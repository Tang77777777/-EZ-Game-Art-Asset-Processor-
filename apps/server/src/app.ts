import { Elysia, ElysiaCustomStatusResponse, t } from "elysia";
import { join } from "node:path";
import type { ServerConfig } from "@ezgameart/shared";
import { PROVIDER_VIDEO_SUPPORT } from "@ezgameart/shared";
import { db } from "./db";
import { getMattingInfo } from "./jobs/matting";
import { enhancerConfigured, getGenProviders, getImageLayerSettings, getPromptEnhancers, imageLayerConfigured, providerConfigured } from "./provider";
import { isModelCached, listApiProviderModels, runDoctor, testApiProvider } from "./doctor";
import { enhancePrompt } from "./enhance";
import { materialsApi } from "./api/materials";
import { settingsApi } from "./api/settings";
import { foldersApi } from "./api/folders";
import { mcpHandler } from "./mcp";
import { cancelJob, getQueueConcurrency } from "./queue";
import { broadcast } from "./ws";

// imageOps worker 打包结果：生产缓存一次，开发每次重建（跟随源码改动）
let imageOpsWorkerCode: string | null = null;

async function buildImageOpsWorker(): Promise<string> {
  if (imageOpsWorkerCode && process.env.NODE_ENV === "production") return imageOpsWorkerCode;
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "..", "..", "web", "src", "imageops", "imageOps.worker.ts")],
    target: "browser",
    format: "esm",
  });
  if (!result.success) throw new Error(result.logs.map((l) => String(l)).join("\n"));
  imageOpsWorkerCode = await result.outputs[0].text();
  return imageOpsWorkerCode;
}


export const app = new Elysia()
  .get("/api/health", () => ({ ok: true, name: "EZ Game Art Asset Processor" }))
  // 服务端能力探测（抠图引擎、生成 provider 列表；每次实时解析，设置页改动即时生效）
  .get("/api/config", (): ServerConfig => {
    const matting = getMattingInfo();
    const imageLayers = getImageLayerSettings();
    return {
      matting: {
        engine: matting.engine,
        model: matting.model,
        hint: matting.hint,
        modelCached: isModelCached(matting.model),
      },
      imageLayers: {
        configured: imageLayerConfigured(imageLayers),
        model: imageLayers.model,
      },
      gen: {
        providers: getGenProviders().map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          imageModels: p.imageModels,
          videoModels: p.videoModels,
          textModels: p.textModels,
          // 兼容热更新前仍在运行的旧前端；分层配置已独立，此字段始终为空且不会写回 Provider。
          layerModels: [],
          configured: providerConfigured(p),
          video: PROVIDER_VIDEO_SUPPORT[p.type] && (p.type === "cli" || p.videoModels.length > 0),
          imageSize: p.imageSize,
          videoSize: p.videoSize,
        })),
      },
      promptEnhancers: getPromptEnhancers()
        .filter(enhancerConfigured)
        .map((e) => ({ id: e.id, name: e.name, model: e.model })),
      queueConcurrency: getQueueConcurrency(),
    };
  })
  // 提示词加强：调用设置页配置的加强模型（OpenAI 兼容 chat/completions），原提示词由前端保留
  .post(
    "/api/enhance-prompt",
    async ({ body, status }) => {
      try {
        return await enhancePrompt(body);
      } catch (e) {
        return status(400, (e as Error).message);
      }
    },
    {
      body: t.Object({
        enhancerId: t.Optional(t.String()),
        prompt: t.String(),
        style: t.Optional(t.String()),
        mediaKind: t.Optional(t.Union([t.Literal("image"), t.Literal("video")])),
        referenceImageCount: t.Optional(t.Integer({ minimum: 0, maximum: 10 })),
      }),
    }
  )
  // 体检：逐项检查存储 / ffmpeg / 抠图引擎与模型 / 生成 provider（API 方式含联通测试）
  .get("/api/doctor", () => runDoctor())
  // API provider 联通测试（用表单当前值，不要求已保存）：api/dashscope/gemini 实发模型列表端点；minimax 仅校验字段
  .post(
    "/api/provider/test",
    ({ body }) => testApiProvider(body),
    {
      body: t.Object({
        type: t.Optional(t.Union([t.Literal("api"), t.Literal("dashscope"), t.Literal("gemini"), t.Literal("minimax")])),
        apiBaseUrl: t.String(),
        apiKey: t.String(),
        apiModel: t.Optional(t.String()),
      }),
    }
  )
  // API provider 模型列表（设置页「获取模型」，用表单当前值拉取，不要求已保存）
  .post(
    "/api/provider/models",
    ({ body }) => listApiProviderModels(body),
    {
      body: t.Object({
        type: t.Union([t.Literal("api"), t.Literal("dashscope"), t.Literal("gemini"), t.Literal("minimax")]),
        apiBaseUrl: t.String(),
        apiKey: t.String(),
      }),
    }
  )
  // 任务列表（右侧任务面板初始加载；之后以 WS 事件为主，单任务查询用 /api/jobs/:id）
  .get("/api/jobs", () => {
    const jobs = db.query("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50").all();
    return { jobs };
  })
  // 任务状态查询（前端轮询兜底，WS 为主）
  .get("/api/jobs/:id", ({ params, status }) => {
    const job = db.query("SELECT * FROM jobs WHERE id = ?").get(params.id);
    if (!job) return status(404, "任务不存在");
    return { job };
  })
  .post("/api/jobs/:id/cancel", ({ params, status }) => {
    const job = db.query("SELECT id, status FROM jobs WHERE id = ?").get(params.id) as
      | { id: string; status: string }
      | null;
    if (!job) return status(404, "任务不存在");
    if (job.status !== "queued" && job.status !== "running") {
      return status(409, `任务状态为 ${job.status}，无法取消`);
    }
    if (!cancelJob(params.id)) return status(409, "取消失败");
    return { ok: true };
  })
  // 字体等静态文件（位于 apps/web/public/fonts）
  .get("/fonts/:name", ({ params, status }) => {
    const name = params.name;
    if (!/^[\w.-]+$/.test(name)) return status(400, "非法文件名");
    const file = Bun.file(join(import.meta.dir, "..", "..", "web", "public", "fonts", name));
    return new Response(file, {
      headers: {
        "Content-Type": name.endsWith(".woff2") ? "font/woff2" : "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  })
  // 图像处理 worker 脚本：Bun 的 HTML 打包不处理 new Worker(URL)，这里按需 Bun.build 后同源下发
  .get("/imageops/imageOps.worker.js", async ({ status }) => {
    try {
      const code = await buildImageOpsWorker();
      return new Response(code, {
        headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" },
      });
    } catch (e) {
      return status(500, `worker 构建失败: ${(e as Error).message}`);
    }
  })
  .use(materialsApi)
  .use(foldersApi)
  .use(settingsApi)
  // MCP（Model Context Protocol）端点：Streamable HTTP 传输（SDK v2 自动处理 POST/GET/DELETE）
  .all("/mcp", ({ request }) => mcpHandler.fetch(request));

export type App = typeof app;
