import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import { SETTING_KEYS, PROVIDER_VIDEO_SUPPORT } from "@ezgameart/shared";
import { db } from "../../db";
import { broadcast } from "../../ws";
import { getMattingInfo } from "../../jobs/matting";
import { getGenProviders, getImageLayerSettings, imageLayerConfigured, providerConfigured, getPromptEnhancers, enhancerConfigured } from "../../provider";
import { isModelCached, runDoctor } from "../../doctor";
import { enhancePrompt } from "../../enhance";
import { getQueueConcurrency } from "../../queue";
import { ok, err } from "../helpers";

export function register(server: McpServer) {
  server.registerTool(
    "get_config",
    {
      title: "Get Config",
      description:
        "Get server configuration: matting engine info, available generation providers (without API keys), and prompt enhancers. Use this to discover what providers are configured before calling generate_materials.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const matting = getMattingInfo();
      const imageLayers = getImageLayerSettings();
      return ok({
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
      });
    }
  );

  server.registerTool(
    "run_doctor",
    {
      title: "Run Doctor",
      description:
        "Run a health check on the EZ Game Art Asset Processor server. Checks storage writability, ffmpeg availability, matting engine and model cache, and each generation provider's connectivity. Returns a list of check results.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      return ok(await runDoctor());
    }
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get Settings",
      description:
        "Get all server settings (theme, lang, genProviders, matting, imageLayers, promptEnhancers, queueConcurrency). API keys are redacted.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const rows = db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
      const out: Record<string, unknown> = {};
      for (const r of rows) {
        try {
          out[r.key] = JSON.parse(r.value);
        } catch {
          out[r.key] = r.value;
        }
      }
      if (Array.isArray(out.genProviders)) {
        out.genProviders = (out.genProviders as any[]).map((p) => ({
          ...p,
          apiKey: p.apiKey ? "***" : "",
        }));
      }
      if (Array.isArray(out.promptEnhancers)) {
        out.promptEnhancers = (out.promptEnhancers as any[]).map((e) => ({
          ...e,
          apiKey: e.apiKey ? "***" : "",
        }));
      }
      return ok(out);
    }
  );

  server.registerTool(
    "update_setting",
    {
      title: "Update Setting",
      description:
        "Update a single server setting. Allowed keys: theme, lang, genProviders, matting, imageLayers, promptEnhancers, queueConcurrency. The value must match the expected type for each key.",
      inputSchema: z.object({
        key: z.enum(SETTING_KEYS as unknown as [string, ...string[]]).describe("Setting key"),
        value: z.any().describe("Setting value (type depends on key)"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ key, value }) => {
      db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(key, JSON.stringify(value ?? null), Date.now());
      broadcast("settings_changed", { key });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "enhance_prompt",
    {
      title: "Enhance Prompt",
      description:
        "Enhance a short prompt into a detailed English generation prompt using a configured prompt enhancer model. Optional style: pixel (default), anime, illustration, 3d, realistic, general. Optional mediaKind: image or video. Returns the enhanced prompt and enhancer name.",
      inputSchema: z.object({
        prompt: z.string().describe("Original short prompt to enhance"),
        style: z
          .enum(["pixel", "anime", "illustration", "3d", "realistic", "general"])
          .describe("Target style (default: pixel)")
          .optional(),
        enhancerId: z.string().describe("Enhancer UUID (omit to use first configured)").optional(),
        mediaKind: z.enum(["image", "video"]).describe("Target media kind").optional(),
        referenceImageCount: z.number().int().min(0).max(10).describe("Number of ordered reference images selected for generation").optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async ({ prompt, style, enhancerId, mediaKind, referenceImageCount }) => {
      try {
        const result = await enhancePrompt({ enhancerId, prompt, style, mediaKind, referenceImageCount });
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );
}
