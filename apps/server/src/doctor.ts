import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  DoctorCheck,
  DoctorResponse,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ProviderTestRequest,
  ProviderTestResponse,
} from "@ezgameart/shared";
import { normalizeDashscopeBaseUrl } from "@ezgameart/shared";
import { STORAGE_ROOT } from "./db";
import { bundledRembg, getMattingInfo } from "./jobs/matting";
import { enhancerConfigured, getGenProviders, getImageLayerSettings, getMattingSettings, getPromptEnhancers, imageLayerConfigured, providerConfigured, resolveEnhancerRuntime } from "./provider";
import { listProviderModels, probeProviderModels } from "./providerAdapter";

/** provider 类型展示名（doctor 标签用） */
export const PROVIDER_TYPE_LABEL: Record<string, string> = {
  cli: "CLI",
  api: "API",
  dashscope: "百炼",
  gemini: "banana",
  minimax: "MiniMax",
};

/** rembg 模型是否已缓存（递归扫描 storage/models，大小写不敏感；覆盖 rembg 的 models/<name> 布局） */
export function isModelCached(model: string): boolean {
  try {
    const needle = model.trim().toLowerCase();
    if (!needle) return false;
    const hasModel = (dir: string): boolean =>
      readdirSync(dir, { withFileTypes: true }).some((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? hasModel(path) : entry.name.toLowerCase().includes(needle);
      });
    return hasModel(join(STORAGE_ROOT, "models"));
  } catch {
    return false;
  }
}

/**
 * API provider 模型列表接口（设置页「获取模型」）：
 * 各类型协议由 providerAdapter 处理；minimax 为 best-effort，失败返回错误文案由前端保持手填
 */
export async function listApiProviderModels(req: ProviderModelsRequest): Promise<ProviderModelsResponse> {
  return listProviderModels(req);
}

/**
 * API provider 联通测试：
 * - api / dashscope / gemini：经 providerAdapter 实发模型列表端点，校验状态/认证并核对模型是否在列
 * - minimax：官方接口无轻量探测端点，仅校验字段齐备，不实发请求
 */
export async function testApiProvider(req: ProviderTestRequest): Promise<ProviderTestResponse> {
  const raw = req.apiBaseUrl.trim().replace(/\/+$/, "");
  if (!raw || !req.apiKey.trim()) return { ok: false, error: "Base URL 与 API Key 不能为空" };
  if (req.type === "minimax") {
    return {
      ok: true,
      note: "字段齐备（该厂商接口无轻量探测端点，未实发请求；生成失败会以任务错误形式暴露）",
    };
  }

  const type = req.type ?? "api";
  const base = type === "dashscope" ? normalizeDashscopeBaseUrl(raw) : raw;
  const r = await probeProviderModels(type, base, req.apiKey);
  if (!r.ok) return { ok: false, status: r.status, latencyMs: r.latencyMs, error: r.error };

  let modelsFound: boolean | undefined;
  const target = req.apiModel?.trim();
  if (r.models !== null && target) {
    // Gemini 已去 models/ 前缀，直接比对即可（兼容个别未去前缀的响应）
    modelsFound = r.models.some((m) => m === target || m === `models/${target}`);
  }
  return { ok: true, status: r.status, latencyMs: r.latencyMs, modelsFound };
}

/** 体检：逐项检查运行所需条件（存储 / ffmpeg / 抠图引擎与模型 / 生成 provider） */
export async function runDoctor(): Promise<DoctorResponse> {
  const checks: DoctorCheck[] = [];

  // 存储目录可写
  try {
    const probe = join(STORAGE_ROOT, `.doctor_${Date.now()}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    checks.push({ id: "storage", ok: true, label: "存储目录", detail: `${STORAGE_ROOT} 可写` });
  } catch (e) {
    checks.push({ id: "storage", ok: false, label: "存储目录", detail: `不可写: ${(e as Error).message}` });
  }

  // ffmpeg（GIF/MP4 拆帧）
  const ffmpeg = Bun.which("ffmpeg");
  checks.push({
    id: "ffmpeg",
    ok: !!ffmpeg,
    label: "ffmpeg（GIF/MP4 拆帧）",
    detail:
      ffmpeg ??
      (process.platform === "win32"
        ? "未找到：winget install ffmpeg（或 https://ffmpeg.org/download.html）"
        : process.platform === "darwin"
          ? "未找到：brew install ffmpeg"
          : "未找到：用系统包管理器安装 ffmpeg（如 apt install ffmpeg）"),
  });

  // 抠图引擎
  const matting = getMattingInfo();
  if (matting.engine === "custom-cli") {
    const ms = getMattingSettings();
    const bin = ms.cliBin.trim() || (ms.envTemplate.split(/\s+/)[0] ?? "");
    const found = !!bin && (existsSync(bin) || !!Bun.which(bin));
    checks.push({
      id: "matting-engine",
      ok: found,
      label: "抠图引擎（自定义 CLI）",
      detail: found ? `命令 ${bin} 可用` : `命令 ${bin || "?"} 不在 PATH 也不是有效路径`,
    });
  } else {
    checks.push({
      id: "matting-engine",
      ok: matting.engine !== "none",
      label: "抠图引擎",
      detail:
        matting.engine === "rembg-bundled"
          ? `内置 ${bundledRembg() ?? ".venv-matting"}`
          : matting.engine === "rembg-path"
            ? `PATH 中的 rembg（${Bun.which("rembg")}）`
            : (matting.hint ?? "未安装"),
    });
  }

  // 抠图模型缓存（未缓存不算失败，首次抠图自动下载，仅提示）
  if (matting.engine !== "none") {
    const cached = isModelCached(matting.model);
    checks.push({
      id: "matting-model",
      ok: true,
      label: `抠图模型 ${matting.model}`,
      detail: cached ? "已缓存（storage/models）" : "未缓存，首次抠图会自动下载（约百 MB，耗时较长）",
    });
  }

  // 图片分层服务（独立于生成 provider）
  const imageLayers = getImageLayerSettings();
  if (!imageLayerConfigured(imageLayers)) {
    checks.push({ id: "image-layers", ok: false, label: "图片分层服务", detail: "未配置：请填写 Base URL / API Key / 模型" });
  } else {
    const r = await testApiProvider({ type: "api", apiBaseUrl: imageLayers.apiBaseUrl, apiKey: imageLayers.apiKey, apiModel: imageLayers.model });
    checks.push({
      id: "image-layers",
      ok: r.ok,
      label: `图片分层模型 ${imageLayers.model}`,
      detail: r.ok
        ? `${imageLayers.apiBaseUrl} 连通（${r.latencyMs}ms）${r.modelsFound === false ? "，但模型列表中未找到该模型" : ""}`
        : (r.error ?? "连接失败"),
    });
  }

  // 生成 provider（逐个检查，CLI 校验命令存在，API 做联通测试）
  const providers = getGenProviders();
  if (providers.length === 0) {
    checks.push({ id: "gen", ok: false, label: "生成 provider", detail: "未配置：请到设置页添加（CLI / API 可配多个共存）" });
  }
  for (const p of providers) {
    if (p.type === "cli") {
      if (!providerConfigured(p)) {
        checks.push({ id: `gen-${p.id}`, ok: false, label: `生成 provider「${p.name}」（CLI）`, detail: "未配置命令" });
      } else {
        const bin = p.cliBin.trim() || (p.legacyTemplate?.trim().split(/\s+/)[0] ?? "");
        const found = !!bin && (existsSync(bin) || !!Bun.which(bin));
        checks.push({
          id: `gen-${p.id}`,
          ok: found,
          label: `生成 provider「${p.name}」（CLI）`,
          detail: found ? `命令 ${bin} 可用` : `命令 ${bin} 不在 PATH 也不是有效路径`,
        });
      }
    } else if (!providerConfigured(p)) {
      checks.push({
        id: `gen-${p.id}`,
        ok: false,
        label: `生成 provider「${p.name}」（${PROVIDER_TYPE_LABEL[p.type]}）`,
        detail: "Base URL / API Key 未填齐",
      });
    } else if (p.type === "minimax") {
      checks.push({
        id: `gen-${p.id}`,
        ok: true,
        label: `生成 provider「${p.name}」（${PROVIDER_TYPE_LABEL[p.type]}）`,
        detail: "字段齐备（该厂商接口无轻量探测端点，未实发请求）",
      });
    } else {
      const probeModel = p.imageModels[0] ?? p.videoModels[0] ?? p.textModels[0];
      const r = await testApiProvider({ type: p.type, apiBaseUrl: p.apiBaseUrl, apiKey: p.apiKey, apiModel: probeModel });
      checks.push({
        id: `gen-${p.id}`,
        ok: r.ok,
        label: `生成 provider「${p.name}」（${PROVIDER_TYPE_LABEL[p.type]}）`,
        detail: r.ok
          ? `${p.apiBaseUrl} 连通（${r.latencyMs}ms）${r.modelsFound === false ? `，但模型列表中没有 ${probeModel}` : ""}`
          : (r.error ?? "连接失败"),
      });
    }
  }

  // 提示词加强模型（OpenAI 兼容 chat，逐个探测 /models）
  const enhancers = getPromptEnhancers();
  for (const e of enhancers) {
    if (!enhancerConfigured(e)) {
      checks.push({
        id: `enh-${e.id}`,
        ok: false,
        label: `加强模型「${e.name}」`,
        detail: "Base URL / API Key / 模型 未填齐",
      });
      continue;
    }
    const runtime = resolveEnhancerRuntime(e)!;
    const r = await testApiProvider({ type: runtime.providerType, apiBaseUrl: runtime.baseUrl, apiKey: runtime.apiKey, apiModel: runtime.model });
    checks.push({
      id: `enh-${e.id}`,
      ok: r.ok,
      label: `加强模型「${e.name}」`,
      detail: r.ok
        ? `${runtime.baseUrl} 连通（${r.latencyMs}ms）${r.modelsFound === false ? `，但模型列表中没有 ${runtime.model}` : ""}`
        : (r.error ?? "连接失败"),
    });
  }

  return { checks };
}
