import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { GenProvider } from "@ezgameart/shared";
type RuntimeProvider = GenProvider & { apiSize: string };
import {
  normalizeDashscopeBaseUrl,
  resolveVideoInputMode,
  videoModeOffersKeyframes,
  type VideoInputMode,
  videoInputModeAcceptsReferences,
  videoInputModeMaxReferences,
} from "@ezgameart/shared";
import { JobCancelledError } from "./run";

interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
}

/** MiniMax 图像 prompt 上限（官方 invalid params: length must be less than 1500） */
const MINIMAX_PROMPT_MAX = 1499;
/** 图片生成与引用图编辑可能需要较长推理时间，所有 Provider 统一等待 5 分钟。 */
const IMAGE_GENERATION_TIMEOUT = 5 * 60_000;

function imageMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "image/png";
  }
}

function imageDataUri(path: string): string {
  return `data:${imageMimeType(path)};base64,${readFileSync(path).toString("base64")}`;
}

function clampMinimaxPrompt(prompt: string): string {
  if (prompt.length <= MINIMAX_PROMPT_MAX) return prompt;
  return `${prompt.slice(0, MINIMAX_PROMPT_MAX - 1)}…`;
}

/** 合并用户取消信号与超时（二者任一触发即 abort） */
function fetchSignal(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (timeoutMs) parts.push(AbortSignal.timeout(timeoutMs));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

/** 从 OpenAI 兼容响应取图写盘：b64_json 直接解码，url 再下载 */
async function saveFirstImage(json: ImagesResponse, outPath: string, signal?: AbortSignal): Promise<void> {
  const item = json.data?.[0];
  if (item?.b64_json) {
    writeFileSync(outPath, Buffer.from(item.b64_json, "base64"));
    return;
  }
  if (item?.url) {
    await downloadFile(item.url, outPath, signal);
    return;
  }
  throw new Error("生成 API 响应缺少 data[0].b64_json / data[0].url");
}

/** 通用下载（生成图/视频写盘）；视频较大，超时放宽到 300s */
async function downloadFile(url: string, outPath: string, signal?: AbortSignal): Promise<void> {
  const res = await fetch(url, { signal: fetchSignal(signal, 300_000) });
  if (!res.ok) throw new Error(`下载生成文件失败: HTTP ${res.status}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

async function readError(res: Response, which: string): Promise<Error> {
  const text = (await res.text()).slice(0, 500);
  return new Error(`生成 API ${which} 返回 ${res.status}: ${text}`);
}

/**
 * OpenAI 兼容图片生成：
 * - 无引用图：POST {base}/images/generations（JSON：{ model, prompt, size?, n: 1 }）
 * - 有引用图：POST {base}/images/edits（multipart：image + prompt + model + size?）
 *   edits 需模型支持（gpt-image 系列、dall-e-2 支持；dall-e-3 不支持，此时 API 报错会写入 job error）
 */
async function generateViaOpenAI(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePaths: string[] = [],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };

  let res: Response;
  if (referencePaths.length) {
    const form = new FormData();
    const field = referencePaths.length === 1 ? "image" : "image[]";
    for (const referencePath of referencePaths) {
      form.append(field, new File([readFileSync(referencePath)], basename(referencePath), { type: imageMimeType(referencePath) }));
    }
    form.append("prompt", prompt);
    form.append("model", model);
    if (cfg.apiSize.trim()) form.append("size", cfg.apiSize.trim());
    res = await fetch(`${base}/images/edits`, {
      method: "POST",
      headers: auth,
      body: form,
      signal: fetchSignal(signal, IMAGE_GENERATION_TIMEOUT),
    });
    if (!res.ok) throw await readError(res, "images/edits（引用图）");
  } else {
    const body: Record<string, unknown> = { model, prompt, n: 1 };
    if (cfg.apiSize.trim()) body.size = cfg.apiSize.trim();
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: fetchSignal(signal, IMAGE_GENERATION_TIMEOUT),
    });
    if (!res.ok) throw await readError(res, "images/generations");
  }
  await saveFirstImage((await res.json()) as ImagesResponse, outPath, signal);
}

interface DashscopeResponse {
  output?: { choices?: Array<{ message?: { content?: Array<{ image?: string }> } }> };
  code?: string;
  message?: string;
}

/**
 * 百炼 DashScope 原生图片生成/编辑（wan2.7-image / qwen-image 等官方接口，不在 OpenAI 兼容模式内）：
 * POST {base}/api/v1/services/aigc/multimodal-generation/generation
 * - 无引用图：messages content 仅 [{text}]（文生图）
 * - 有引用图：content 前置 {image: dataURI}（图像编辑/多图融合）
 * 同步返回 output.choices[0].message.content[*].image（URL，24h 有效，需及时下载）
 * size 可为 1K/2K/4K 或星号格式（如 2048*2048），由 provider 配置原样透传
 */
async function generateViaDashscope(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePaths: string[] = [],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  // Token Plan 可粘贴 …/compatible-mode/v1；归一到 host 根再拼原生路径
  const base = normalizeDashscopeBaseUrl(cfg.apiBaseUrl);
  const content: Array<Record<string, string>> = [];
  for (const referencePath of referencePaths) {
    content.push({ image: imageDataUri(referencePath) });
  }
  content.push({ text: prompt });
  const parameters: Record<string, unknown> = { n: 1, watermark: false };
  if (cfg.apiSize.trim()) parameters.size = cfg.apiSize.trim();

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/services/aigc/multimodal-generation/generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey.trim()}`,
      },
      body: JSON.stringify({ model, input: { messages: [{ role: "user", content }] }, parameters }),
      signal: fetchSignal(signal, IMAGE_GENERATION_TIMEOUT),
    });
  } catch (e) {
    throw new Error(`DashScope 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) throw await readError(res, "multimodal-generation");

  const json = (await res.json()) as DashscopeResponse;
  if (json.code) throw new Error(`DashScope 错误 ${json.code}: ${json.message ?? ""}`);
  const imageUrl = json.output?.choices?.[0]?.message?.content?.find((c) => c.image)?.image;
  if (!imageUrl) throw new Error("DashScope 响应缺少 output.choices[0].message.content[*].image");
  await downloadFile(imageUrl, outPath, signal);
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
  /** 部分 Gemini 兼容代理未转换 REST snake_case，兼容读取但官方请求仍使用 inlineData。 */
  inline_data?: { mime_type?: string; data?: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
  finishMessage?: string;
  safetyRatings?: Array<{ category?: string; blocked?: boolean }>;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  promptFeedback?: {
    blockReason?: string;
    blockReasonMessage?: string;
    safetyRatings?: Array<{ category?: string; blocked?: boolean }>;
  };
  error?: { message?: string; status?: string; code?: number };
  responseId?: string;
}

const GEMINI_RETRYABLE_FINISH_REASONS = new Set(["NO_IMAGE", "IMAGE_OTHER"]);

function geminiImageData(json: GeminiResponse): string | null {
  for (const candidate of json.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;
      if (data?.trim()) return data.replace(/^data:image\/[^;]+;base64,/, "");
    }
  }
  return null;
}

function geminiFailure(json: GeminiResponse, retried: boolean): { message: string; retryable: boolean } {
  if (json.error?.message) {
    return {
      message: `Gemini 错误${json.error.status ? ` ${json.error.status}` : ""}: ${json.error.message}`,
      retryable: false,
    };
  }
  const blockReason = json.promptFeedback?.blockReason;
  if (blockReason) {
    const detail = json.promptFeedback?.blockReasonMessage?.trim();
    return {
      message: `Gemini 提示词被拦截（blockReason=${blockReason}）${detail ? `: ${detail}` : "，请调整提示词或引用图"}`,
      retryable: false,
    };
  }

  const candidates = json.candidates ?? [];
  const reasons = [...new Set(candidates.map((candidate) => candidate.finishReason).filter((value): value is string => Boolean(value)))];
  const finishMessages = candidates.map((candidate) => candidate.finishMessage?.trim()).filter((value): value is string => Boolean(value));
  const modelText = candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text?.trim())
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  const blockedCategories = [...new Set(
    candidates
      .flatMap((candidate) => candidate.safetyRatings ?? [])
      .filter((rating) => rating.blocked)
      .map((rating) => rating.category)
      .filter((value): value is string => Boolean(value))
  )];
  const retryable = reasons.length === 0 || reasons.every((reason) => GEMINI_RETRYABLE_FINISH_REASONS.has(reason));
  const details = [
    reasons.length ? `finishReason=${reasons.join(",")}` : candidates.length ? "候选未说明结束原因" : "未返回 candidates",
    finishMessages.length ? finishMessages.join("；") : "",
    blockedCategories.length ? `安全类别=${blockedCategories.join(",")}` : "",
    modelText ? `模型返回文本：${modelText}` : "",
    json.responseId ? `responseId=${json.responseId}` : "",
  ].filter(Boolean);
  return {
    message: `Gemini 未生成图片${retried ? "（已自动重试 1 次）" : ""}: ${details.join("；")}`,
    retryable,
  };
}

async function waitGeminiRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new JobCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, 600);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Gemini 图像生成（banana / nano-banana，gemini-2.5-flash-image 等）：
 * POST {base}/v1beta/models/{model}:generateContent（x-goog-api-key 头）
 * parts = [{text}, {inlineData: base64 引用图}?]；generationConfig.responseModalities=["TEXT","IMAGE"]
 * apiSize 映射 imageConfig.aspectRatio（如 16:9）；响应遍历全部 candidates/parts 取 inlineData.data。
 * Gemini 的 HTTP 200 仍可能是 promptFeedback 拦截、图片安全过滤、NO_IMAGE 或文本拒绝；分类显示原因，
 * 仅对 NO_IMAGE / IMAGE_OTHER / 无候选的暂时性空响应自动重试一次。
 */
async function generateViaGemini(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePaths: string[] = [],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  // 有引用图时图在前、文在后，利于图像编辑/角色一致性（无引用则仅 text）
  const parts: Array<Record<string, unknown>> = [];
  for (const referencePath of referencePaths) {
    parts.push({
      inlineData: { mimeType: imageMimeType(referencePath), data: readFileSync(referencePath).toString("base64") },
    });
  }
  parts.push({ text: prompt });
  const generationConfig: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (cfg.apiSize.trim()) generationConfig.imageConfig = { aspectRatio: cfg.apiSize.trim() };

  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": cfg.apiKey.trim() },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
        signal: fetchSignal(signal, IMAGE_GENERATION_TIMEOUT),
      });
    } catch (e) {
      if (signal?.aborted) throw new JobCancelledError();
      throw new Error(`Gemini 请求失败: ${(e as Error).message}`);
    }
    if (!res.ok) throw await readError(res, "generateContent");

    const json = (await res.json()) as GeminiResponse;
    const b64 = geminiImageData(json);
    if (b64) {
      writeFileSync(outPath, Buffer.from(b64, "base64"));
      return;
    }
    const failure = geminiFailure(json, attempt > 0);
    if (!failure.retryable || attempt > 0) throw new Error(failure.message);
    await waitGeminiRetry(signal);
  }
}

interface MinimaxResponse {
  data?: { image_base64?: string[] | string; image_urls?: string[] | string };
  metadata?: { success_count?: number | string; failed_count?: number | string };
  base_resp?: { status_code?: number; status_msg?: string };
}

/**
 * MiniMax 图像生成（image-01）：POST {base}/v1/image_generation（Bearer）
 * 引用图走 subject_reference（主体特征保持，协议限一张；base64 dataURI 上送）
 * apiSize 映射 aspect_ratio（如 16:9，默认 1:1）；优先解码 base64，兼容服务端返回 URL
 * prompt 官方限制小于 1500 字符，超长截断
 */
async function generateViaMinimax(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  referencePaths: string[] = [],
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const body: Record<string, unknown> = {
    model,
    prompt: clampMinimaxPrompt(prompt),
    n: 1,
    response_format: "base64",
  };
  if (cfg.apiSize.trim()) body.aspect_ratio = cfg.apiSize.trim();
  const referencePath = referencePaths[0];
  if (referencePath) {
    body.subject_reference = [{ type: "character", image_file: imageDataUri(referencePath) }];
  }

  let res: Response;
  try {
    res = await fetch(`${base}/v1/image_generation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey.trim()}` },
      body: JSON.stringify(body),
      signal: fetchSignal(signal, IMAGE_GENERATION_TIMEOUT),
    });
  } catch (e) {
    throw new Error(`MiniMax 请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) throw await readError(res, "image_generation");

  const json = (await res.json()) as MinimaxResponse;
  if (json.base_resp?.status_code && json.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${json.base_resp.status_code}: ${json.base_resp.status_msg ?? ""}`);
  }
  const base64 = json.data?.image_base64;
  const b64 = Array.isArray(base64) ? base64[0] : base64;
  if (b64) {
    writeFileSync(outPath, Buffer.from(b64, "base64"));
    return;
  }
  const urls = json.data?.image_urls;
  const imageUrl = Array.isArray(urls) ? urls[0] : urls;
  if (imageUrl) {
    await downloadFile(imageUrl, outPath, signal);
    return;
  }
  const failedCount = Number(json.metadata?.failed_count ?? 0);
  if (failedCount > 0) throw new Error(`MiniMax 生成结果被安全过滤（失败 ${failedCount} 张）`);
  throw new Error("MiniMax 响应缺少 data.image_base64 / data.image_urls");
}

/**
 * API 生成统一入口（按 provider.type 分发 OpenAI 兼容 / DashScope 原生 / Gemini / MiniMax）。
 * 模型在生成时单独指定（生成弹窗选择/输入），provider 只存连接信息；
 * sizeOverride 非空时覆盖 provider 的 apiSize（生成弹窗的尺寸选择）
 */
export async function generateViaApi(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  _index: number,
  outPath: string,
  referencePaths?: string[],
  sizeOverride?: string,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const eff = sizeOverride?.trim() ? { ...cfg, apiSize: sizeOverride.trim() } : cfg;
  if (eff.type === "minimax" && (referencePaths?.length ?? 0) > 1)
    throw new Error("MiniMax 图像协议最多支持 1 张引用图");
  try {
    if (eff.type === "dashscope") return await generateViaDashscope(eff, prompt, model, outPath, referencePaths, signal);
    if (eff.type === "gemini") return await generateViaGemini(eff, prompt, model, outPath, referencePaths, signal);
    if (eff.type === "minimax") return await generateViaMinimax(eff, prompt, model, outPath, referencePaths, signal);
    return await generateViaOpenAI(eff, prompt, model, outPath, referencePaths, signal);
  } catch (error) {
    if (error instanceof JobCancelledError || signal?.aborted) throw error;
    if ((referencePaths?.length ?? 0) > 1) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`多引用图生成失败：当前模型或 API 接口可能不支持 ${referencePaths!.length} 张引用图。请确认模型的多图输入能力，或减少为 1 张后重试。Provider 原始错误：${detail}`);
    }
    throw error;
  }
}

// ===== 视频生成（异步任务制：创建 → 轮询 → 下载 mp4；仅 dashscope / minimax）=====

const VIDEO_POLL_INTERVAL = 5_000;
const VIDEO_POLL_TIMEOUT = 10 * 60_000;

interface VideoPollResult {
  done: boolean;
  url?: string;
  error?: string;
}

/** 视频任务轮询：5s 间隔，10 分钟超时；进度文案经 report 写入 job.progress */
async function pollVideoTask(
  report: (s: string) => void,
  query: () => Promise<VideoPollResult>,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + VIDEO_POLL_TIMEOUT;
  for (;;) {
    if (signal?.aborted) throw new JobCancelledError();
    await new Promise((r) => setTimeout(r, VIDEO_POLL_INTERVAL));
    if (signal?.aborted) throw new JobCancelledError();
    const r = await query();
    if (r.error) throw new Error(r.error);
    if (r.done) {
      if (!r.url) throw new Error("视频任务成功但响应缺少下载地址");
      return r.url;
    }
    if (Date.now() >= deadline) throw new Error("视频生成超时（10 分钟），请稍后重试");
    report("视频生成中（异步任务，约需数分钟）");
  }
}

/** MiniMax-H3 等走 v2；Hailuo / T2V-01 等走 v1（多数套餐仍是后者） */
function usesMinimaxVideoV2(model: string): boolean {
  // MiniMax-H3（H 后跟数字）；Hailuo 为 MiniMax-Hailuo-*，不会命中
  return /^MiniMax-H\d/i.test(model.trim());
}

/** v1 成功后经 file_id 换下载地址 */
async function retrieveMinimaxFileUrl(
  base: string,
  auth: Record<string, string>,
  fileId: string,
  signal?: AbortSignal
): Promise<string> {
  const q = await fetch(`${base}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: auth,
    signal: fetchSignal(signal, 30_000),
  });
  if (!q.ok) throw await readError(q, "v1/files/retrieve");
  const j = (await q.json()) as {
    file?: { download_url?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (j.base_resp?.status_code && j.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${j.base_resp.status_code}: ${j.base_resp.status_msg ?? ""}`);
  }
  const url = j.file?.download_url?.trim();
  if (!url) throw new Error("MiniMax 文件检索响应缺少 download_url");
  return url.startsWith("http") ? url : `https://${url}`;
}

/**
 * MiniMax 视频（Hailuo / T2V 等 v1）：
 * POST {base}/v1/video_generation { model, prompt, duration? } → task_id
 * 轮询 GET {base}/v1/query/video_generation?task_id=…（Success/Fail）→ file_id
 * 再 GET {base}/v1/files/retrieve?file_id=… 取 download_url
 */
async function generateVideoViaMinimaxV1(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  const body: Record<string, unknown> = {
    model,
    prompt: clampMinimaxPrompt(prompt),
    duration: 6,
  };
  // apiSize 若写成 768P/1080P/720P 则当作 resolution；宽高比留给 v2
  const size = cfg.apiSize.trim().toUpperCase();
  if (/^(720|768|1080)P$/.test(size)) body.resolution = size;

  const res = await fetch(`${base}/v1/video_generation`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: fetchSignal(signal, 60_000),
  });
  if (!res.ok) throw await readError(res, "v1/video_generation");
  const created = (await res.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (created.base_resp?.status_code && created.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${created.base_resp.status_code}: ${created.base_resp.status_msg ?? ""}`);
  }
  if (!created.task_id) throw new Error("MiniMax 视频任务创建失败：响应缺少 task_id");

  const fileId = await pollVideoTask(
    report,
    async () => {
      const q = await fetch(`${base}/v1/query/video_generation?task_id=${encodeURIComponent(created.task_id!)}`, {
        headers: auth,
        signal: fetchSignal(signal, 30_000),
      });
      if (!q.ok) throw await readError(q, "v1/query/video_generation");
      const j = (await q.json()) as {
        status?: string;
        file_id?: string | number;
        base_resp?: { status_code?: number; status_msg?: string };
      };
      if (j.base_resp?.status_code && j.base_resp.status_code !== 0) {
        return { done: false, error: `MiniMax 错误 ${j.base_resp.status_code}: ${j.base_resp.status_msg ?? ""}` };
      }
      const st = (j.status ?? "").toLowerCase();
      if (st === "success") {
        if (j.file_id == null) return { done: false, error: "MiniMax 视频成功但缺少 file_id" };
        return { done: true, url: String(j.file_id) }; // 暂存 file_id，下面再换下载 URL
      }
      if (st === "fail" || st === "failed") {
        return { done: false, error: `MiniMax 视频任务失败: ${j.base_resp?.status_msg ?? ""}` };
      }
      return { done: false };
    },
    signal
  );
  const url = await retrieveMinimaxFileUrl(base, auth, fileId, signal);
  await downloadFile(url, outPath, signal);
}

/**
 * MiniMax 视频（H3 等 v2）：
 * POST {base}/v2/video_generation { model, content:[{type:"text",text}], duration, ratio? } → task_id
 * 轮询 GET {base}/v2/query/video_generation/{task_id}（task.status: succeeded/failed/cancelled）
 * 成功直接取 task.content.url 下载
 */
async function generateVideoViaMinimaxV2(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const base = cfg.apiBaseUrl.trim().replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  // 文生视频 ratio 必填且不可 adaptive；缺省 16:9
  const ratio = cfg.apiSize.trim() || "16:9";
  const body: Record<string, unknown> = {
    model,
    content: [{ type: "text", text: clampMinimaxPrompt(prompt) }],
    duration: 6,
    ratio: /^(720|768|1080)P$/i.test(ratio) ? "16:9" : ratio,
  };

  const res = await fetch(`${base}/v2/video_generation`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: fetchSignal(signal, 60_000),
  });
  if (!res.ok) throw await readError(res, "v2/video_generation");
  const created = (await res.json()) as {
    task_id?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  };
  if (created.base_resp?.status_code && created.base_resp.status_code !== 0) {
    throw new Error(`MiniMax 错误 ${created.base_resp.status_code}: ${created.base_resp.status_msg ?? ""}`);
  }
  if (!created.task_id) throw new Error("MiniMax 视频任务创建失败：响应缺少 task_id");

  const url = await pollVideoTask(
    report,
    async () => {
      const q = await fetch(`${base}/v2/query/video_generation/${created.task_id}`, {
        headers: auth,
        signal: fetchSignal(signal, 30_000),
      });
      if (!q.ok) throw await readError(q, "v2/query/video_generation");
      const j = (await q.json()) as { task?: { status?: string; content?: { url?: string }; error?: { message?: string } } };
      const st = j.task?.status;
      if (st === "succeeded") return { done: true, url: j.task?.content?.url };
      if (st === "failed" || st === "cancelled") {
        return { done: false, error: `MiniMax 视频任务 ${st}: ${j.task?.error?.message ?? ""}` };
      }
      return { done: false };
    },
    signal
  );
  await downloadFile(url, outPath, signal);
}

/** MiniMax 视频入口：按模型名分发 v1（Hailuo/T2V）或 v2（H3） */
async function generateVideoViaMinimax(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (usesMinimaxVideoV2(model)) {
    return generateVideoViaMinimaxV2(cfg, prompt, model, outPath, report, signal);
  }
  return generateVideoViaMinimaxV1(cfg, prompt, model, outPath, report, signal);
}

/**
 * 百炼 DashScope 视频生成（万相 / HappyHorse 异步协议）：
 * POST {base}/api/v1/services/aigc/video-generation/video-synthesis（X-DashScope-Async: enable）
 * - t2v：input:{prompt}；parameters:{resolution,ratio,duration,watermark:false}
 * - i2v：input.media[{type:first_frame,url}]（引用图 base64 dataURI）
 * - r2v：input.media[{type:reference_image,url}]，prompt 可指 [Image 1]
 * 旧 wanx 仍可把 apiSize 当 size（宽*高）透传
 * 轮询 GET {base}/api/v1/tasks/{task_id} → output.video_url
 */
async function generateVideoViaDashscope(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal,
  referencePaths: string[] = [],
  requestedMode?: VideoInputMode
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  // Token Plan 可粘贴 …/compatible-mode/v1；归一到 host 根再拼原生路径
  const base = normalizeDashscopeBaseUrl(cfg.apiBaseUrl);
  const auth = { Authorization: `Bearer ${cfg.apiKey.trim()}` };
  /**
   * 输入形态三级取值：本次请求显式指定 > 设置页声明 > 模型名推断。
   *
   * 请求优先，是因为像 wan3.0-video 这种统一模型同时支持文生 / 首帧 / 首尾帧 /
   * 参考图，形态本质上是「这次想怎么生成」，不是模型的固有属性。设置页的声明
   * 退化为约束：声明了就不允许本次请求越界（见下方校验）。
   *
   * 曾经这里是三条正则直接判名字，结果 wan3.0-video 三条全不匹配、被当纯文生
   * 视频，用户选的引用图被静默丢弃。名字不可靠。
   */
  const declaredMode = cfg.videoModelModes?.[model];
  const inputMode = requestedMode ?? resolveVideoInputMode(model, cfg.videoModelModes);
  // 声明为纯文生 / 参考图时，不允许本次请求擅自改成首尾帧
  if (declaredMode && requestedMode && declaredMode !== requestedMode && !videoModeOffersKeyframes(declaredMode)) {
    throw new Error(
      `模型「${model}」在设置页被声明为「${declaredMode}」，本次请求要求「${requestedMode}」。请改设置页声明，或按声明的形态提供引用图`
    );
  }
  const usesKeyframes = inputMode === "firstFrame" || inputMode === "firstLastFrame";
  const isR2v = inputMode === "referenceImage";
  const isHappyOrWanVideo = /happyhorse|wan\d/i.test(model);

  const maxReferences = videoInputModeMaxReferences(inputMode);
  const referenceLabel = inputMode === "firstLastFrame" ? "首帧与尾帧" : usesKeyframes ? "首帧" : "参考图";
  if (videoInputModeAcceptsReferences(inputMode) && referencePaths.length === 0) {
    throw new Error(`模型「${model}」需要引用图（${referenceLabel}），请在生成时选择素材/帧作为引用`);
  }
  // 不再静默丢弃：声明为纯文生却带了引用图，直接报错并指明去哪改
  if (!videoInputModeAcceptsReferences(inputMode) && referencePaths.length > 0) {
    throw new Error(`模型「${model}」声明为纯文生视频，不接受引用图。如需首帧驱动，请到设置页把该模型的输入形态改为「首帧」`);
  }
  if (referencePaths.length > maxReferences) {
    throw new Error(`模型「${model}」最多支持 ${maxReferences} 张引用图（当前 ${referencePaths.length} 张）`);
  }

  let text = prompt;
  const input: Record<string, unknown> = {};
  if (referencePaths.length && (usesKeyframes || isR2v)) {
    if (inputMode === "firstFrame") {
      input.media = [{ type: "first_frame", url: imageDataUri(referencePaths[0]!) }];
      if (text.trim()) input.prompt = text;
    } else if (inputMode === "firstLastFrame") {
      /*
        只给 1 张时首尾同帧 —— 产出可无缝循环的动画，正是像素待机动作最需要的形态。
        这个复制只在形态确实是 firstLastFrame 时才发生：前端把「勾了复制为结束帧」
        派生成本形态、「只想首帧驱动」派生成 firstFrame，两者不会再混淆。
        早先服务端只看张数，1 张一律复制成尾帧，把想要单纯首帧驱动的人也强行套上了循环。
      */
      const firstUri = imageDataUri(referencePaths[0]!);
      input.media = [
        { type: "first_frame", url: firstUri },
        { type: "last_frame", url: referencePaths[1] ? imageDataUri(referencePaths[1]) : firstUri },
      ];
      if (text.trim()) input.prompt = text;
    } else {
      input.media = referencePaths.map((referencePath) => ({
        type: "reference_image",
        url: imageDataUri(referencePath),
      }));
      if (!/\[Image\s*1\]/i.test(text)) text = `Based on [Image 1], ${text}`;
      input.prompt = text;
    }
  } else {
    input.prompt = text;
  }

  /**
   * 参数按官方 Wan3.0 文档校准：分辨率是 resolution（1080P/720P/480P），比例是
   * ratio（adaptive 默认，或 16:9 等固定值），**没有 size 参数**——size 只属于
   * 旧的 wanx2.1 系。ratio 用 adaptive 让模型按输入媒体比例自适应，比硬写
   * 16:9 更适合像素素材（常见方形或竖形）。
   * audio 默认为 true，会带一条无用音轨；抽帧场景显式关掉。
   * 依据：https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference
   */
  const parameters: Record<string, unknown> = { watermark: false };
  const size = cfg.apiSize.trim();
  if (isHappyOrWanVideo || /happyhorse/i.test(model)) {
    parameters.duration = 5;
    parameters.audio = false;
    if (/^(480|720|1080)P$/i.test(size)) {
      parameters.resolution = size.toUpperCase();
      parameters.ratio = "adaptive";
    } else if (/^\d+:\d+$/.test(size)) {
      // 用户在设置页填的是比例（如 16:9）而非档位，按比例走、分辨率取 720P
      parameters.ratio = size;
      parameters.resolution = "720P";
    } else {
      parameters.resolution = "720P";
      parameters.ratio = "adaptive";
    }
  } else if (size) {
    // 旧 wanx2.1 等：size 如 1280*720
    parameters.size = size;
  }

  const res = await fetch(`${base}/api/v1/services/aigc/video-generation/video-synthesis`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", "X-DashScope-Async": "enable" },
    body: JSON.stringify({ model, input, parameters }),
    signal: fetchSignal(signal, 60_000),
  });
  if (!res.ok) throw await readError(res, "video-synthesis");
  const created = (await res.json()) as {
    output?: { task_id?: string };
    code?: string;
    message?: string;
  };
  if (created.code) throw new Error(`DashScope 错误 ${created.code}: ${created.message ?? ""}`);
  const taskId = created.output?.task_id;
  if (!taskId) throw new Error("DashScope 视频任务创建失败：响应缺少 output.task_id");

  const url = await pollVideoTask(
    report,
    async () => {
      const q = await fetch(`${base}/api/v1/tasks/${taskId}`, {
        headers: auth,
        signal: fetchSignal(signal, 30_000),
      });
      if (!q.ok) throw await readError(q, "tasks 查询");
      const j = (await q.json()) as { output?: { task_status?: string; video_url?: string; code?: string; message?: string } };
      const st = j.output?.task_status;
      if (st === "SUCCEEDED") return { done: true, url: j.output?.video_url };
      if (st === "FAILED" || st === "CANCELED" || st === "UNKNOWN") {
        return { done: false, error: `DashScope 视频任务 ${st}: ${j.output?.message ?? j.output?.code ?? ""}` };
      }
      return { done: false };
    },
    signal
  );
  await downloadFile(url, outPath, signal);
}

/**
 * API 视频生成统一入口（仅 dashscope / minimax，其余类型在前端已被过滤，这里兜底报错）。
 * 产出 mp4 到 outPath；耗时数分钟，进度经 report 写入 job.progress
 * referencePaths：按 requestedMode 决定用途——首帧 / 首帧+尾帧 / 多张参考图
 * requestedMode：本次请求期望的输入形态（前端按填写的槽位派生）；缺省回退声明与推断
 * sizeOverride：生成弹窗选择的比例/分辨率，非空时覆盖 provider.apiSize
 */
export async function generateVideoViaApi(
  cfg: RuntimeProvider,
  prompt: string,
  model: string,
  outPath: string,
  report: (s: string) => void,
  signal?: AbortSignal,
  referencePaths?: string[],
  sizeOverride?: string,
  requestedMode?: VideoInputMode
): Promise<void> {
  if (signal?.aborted) throw new JobCancelledError();
  const eff = sizeOverride?.trim() ? { ...cfg, apiSize: sizeOverride.trim() } : cfg;
  if (eff.type === "dashscope") {
    return generateVideoViaDashscope(eff, prompt, model, outPath, report, signal, referencePaths, requestedMode);
  }
  if (eff.type === "minimax") return generateVideoViaMinimax(eff, prompt, model, outPath, report, signal);
  throw new Error(`该 provider 类型（${eff.type}）不支持视频生成（支持：CLI / 百炼 / MiniMax）`);
}
