import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { MaterialRow } from "@ezgameart/shared";
import { IMAGE_LAYER_COUNT_MAX, IMAGE_LAYER_COUNT_MIN } from "@ezgameart/shared";
import { db, getMaterial, renameMaterial, uid, STORAGE_ROOT, serializeMaterial } from "../../db";
import { broadcast } from "../../ws";
import { createJob, createMattingJob } from "../../queue";
import { EXTRACT_TIMESTAMPS_MAX, normalizeExtractTimestamps } from "../../jobs/extract";
import { getImageLayerSettings, imageLayerConfigured } from "../../provider";
import { ok, err } from "../helpers";

export function register(server: McpServer) {
  server.registerTool(
    "list_materials",
    {
      title: "List Materials",
      description:
        "List all materials in the library sorted by creation time (newest first). Each material has id, name, status (raw/matted), source, kind (image/video), folder_id, and metadata.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const rows = db
        .query("SELECT * FROM materials ORDER BY created_at DESC")
        .all() as MaterialRow[];
      return ok({ materials: rows.map(serializeMaterial) });
    }
  );

  server.registerTool(
    "rename_material",
    {
      title: "Rename Material",
      description: "Rename one image or video material in the material library.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID"),
        name: z.string().trim().min(1).max(200).describe("New material name"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ materialId, name }) => {
      const material = renameMaterial(materialId, name);
      if (!material) return err("素材不存在");
      broadcast("material_updated", { id: materialId });
      return ok({ material: serializeMaterial(material) });
    }
  );

  server.registerTool(
    "matting_material",
    {
      title: "Matting Material",
      description:
        "Run background removal (matting) on a single material. Creates an async job—returns jobId. Uses configured matting engine (custom CLI → bundled rembg → PATH rembg → passthrough). Same material with active matting job returns error.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      if (!m.raw_path || !existsSync(m.raw_path)) return err("素材缺少 raw 文件");
      if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path)) return err("视频素材不能抠图，请先抽帧");
      const r = createMattingJob(m.id);
      if (r.duplicate) return err("该素材已有进行中的抠图任务");
      return ok({ jobId: r.jobId });
    }
  );

  server.registerTool(
    "split_material_layers",
    {
      title: "Split Material Layers",
      description: "Decompose a flat image into editable RGBA scene layers such as background, whole subject, props, and foreground. This does not split a character into body parts. Creates an async image_layers job.",
      inputSchema: z.object({
        materialId: z.string(),
        layers: z.number().int().min(IMAGE_LAYER_COUNT_MIN).max(IMAGE_LAYER_COUNT_MAX).default(4),
        numInferenceSteps: z.number().int().min(1).max(100).default(50),
        trueCfgScale: z.number().min(0).max(20).default(4),
        negativePrompt: z.string().optional(), seed: z.number().int().min(0).default(0),
        autoMatting: z.boolean().optional().describe("Remove the background before splitting when the material has no processed image"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, layers, numInferenceSteps, trueCfgScale, negativePrompt, seed, autoMatting }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      const input = m.processed_path && existsSync(m.processed_path) ? m.processed_path : m.raw_path;
      if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) return err("只支持图片素材分层");
      const settings = getImageLayerSettings();
      if (!imageLayerConfigured(settings)) return err("图片分层服务未配置完整");
      const jobId = createJob("image_layers", { imageLayers: {
        materialId, model: settings.model, layers, numInferenceSteps, trueCfgScale,
        negativePrompt: negativePrompt?.trim() || undefined, seed, autoMatting,
      } });
      return ok({ jobId });
    }
  );

  server.registerTool(
    "batch_matting",
    {
      title: "Batch Matting",
      description:
        "Run background removal on multiple materials at once. Only materials with status=raw are enqueued; already matted, video, or with active matting jobs are skipped. Returns count of enqueued and skipped.",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("Material UUIDs to process"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ ids }) => {
      let count = 0;
      let skipped = 0;
      for (const id of ids) {
        const m = getMaterial(id);
        if (!m || !m.raw_path || !existsSync(m.raw_path)) continue;
        if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path) || m.status === "matted") {
          skipped++;
          continue;
        }
        const r = createMattingJob(id);
        if (r.duplicate) {
          skipped++;
          continue;
        }
        count++;
      }
      return ok({ ok: true, count, skipped });
    }
  );

  server.registerTool(
    "extract_material_frames",
    {
      title: "Extract Material Frames",
      description:
        "Extract frames from a video/GIF material into individual image materials. For GIF or video with fps: extracts all frames at the given fps. For video with timestamps: extracts at specific time points (max 64). Creates an async job—returns jobId.",
      inputSchema: z.object({
        materialId: z.string().describe("Source material UUID (must be video or GIF)"),
        fps: z.number().int().min(1).max(60).describe("Extraction fps (default 8, ignored if timestamps given)").optional(),
        timestamps: z.array(z.number()).max(64).describe("Specific time points in seconds (video only, not GIF)").optional(),
        autoMatting: z.boolean().describe("Auto-run background removal on extracted frames").optional(),
        folderId: z.string().describe("Target folder for extracted materials (defaults to source material's folder)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ materialId, fps: rawFps, timestamps: rawTs, autoMatting, folderId }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      if (!m.raw_path || !existsSync(m.raw_path)) return err("素材缺少文件");
      const isGif = /\.(gif)$/i.test(m.raw_path);
      const isVideo = /\.(mp4|mov|webm|avi)$/i.test(m.raw_path);
      if (!isGif && !isVideo) return err("仅视频/GIF 素材可抽帧");

      if (rawTs) {
        if (isGif) return err("GIF 不支持定点抽帧，请用 fps 整段拆帧");
        if (rawTs.length > EXTRACT_TIMESTAMPS_MAX) return err(`最多 ${EXTRACT_TIMESTAMPS_MAX} 个时间点`);
      }

      const stagingId = uid();
      const dir = join(STORAGE_ROOT, "staging", stagingId);
      mkdirSync(dir, { recursive: true });
      const ext = m.raw_path.includes(".") ? m.raw_path.split(".").pop()!.toLowerCase() : "mp4";
      const stagingFile = join(dir, `input.${ext}`);
      copyFileSync(m.raw_path, stagingFile);
      const fps = Math.min(Math.max(rawFps ?? 8, 1), 60);

      let mode: "fps" | "timestamps" = "fps";
      let timestamps: number[] | undefined;
      if (rawTs) {
        timestamps = normalizeExtractTimestamps(rawTs.map(Number));
        if (timestamps.length === 0) return err("未提供有效抽帧时间点");
        mode = "timestamps";
      }

      const jobId = createJob("extract_frames", {
        extract: {
          stagingFile,
          mediaType: isGif ? "gif" : "mp4",
          fps,
          mode,
          timestamps,
          autoMatting: autoMatting ?? false,
          originName: (m.name || "素材").replace(/\s*#\d+$/, "").trim() || "素材",
          folderId: folderId !== undefined ? (folderId as string | null) : m.folder_id,
        },
      });
      return ok({ jobId });
    }
  );

  server.registerTool(
    "batch_delete_materials",
    {
      title: "Batch Delete Materials",
      description:
        "Delete multiple materials and their disk files. Returns count of deleted materials. Broadcasts materials_changed.",
      inputSchema: z.object({
        ids: z.array(z.string()).describe("Material UUIDs to delete"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ ids }) => {
      const stmt = db.query("DELETE FROM materials WHERE id = ?");
      let deleted = 0;
      for (const id of ids) {
        const m = getMaterial(id);
        if (!m) continue;
        stmt.run(id);
        deleted++;
        rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
      }
      broadcast("materials_changed", {});
      return ok({ ok: true, deleted });
    }
  );

  server.registerTool(
    "unmatting_material",
    {
      title: "Unmatting Material",
      description:
        "Remove the matting (background removal) result from a material, reverting it to raw status. Deletes the processed file.",
      inputSchema: z.object({
        materialId: z.string().describe("Material UUID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ materialId }) => {
      const m = getMaterial(materialId);
      if (!m) return err("素材不存在");
      if (m.processed_path && existsSync(m.processed_path)) rmSync(m.processed_path);
      db.query("UPDATE materials SET status = 'raw', processed_path = NULL WHERE id = ?").run(m.id);
      broadcast("material_updated", { id: m.id });
      return ok({ material: serializeMaterial(getMaterial(m.id)!) });
    }
  );
}
