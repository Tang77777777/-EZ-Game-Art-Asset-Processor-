import { Elysia, t } from "elysia";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MaterialRow } from "@ezgameart/shared";
import { IMAGE_LAYER_COUNT_MAX, IMAGE_LAYER_COUNT_MIN, VIDEO_INPUT_MODES } from "@ezgameart/shared";
import { db, getMaterial, renameMaterial, serializeMaterial, STORAGE_ROOT, uid } from "../db";
import { createGenerationJobs, createJob, createMattingJob } from "../queue";
import { EXTRACT_TIMESTAMPS_MAX, normalizeExtractTimestamps } from "../jobs/extract";
import { checkImageReferenceSupport, checkVideoSupport, resolveReferencePaths } from "../providerAdapter";
import { getImageLayerSettings, imageLayerConfigured } from "../provider";
import { broadcast } from "../ws";
import { getThumbnailPath, isImagePath, parseThumbnailSize, serveMediaFile } from "../media";

function baseName(filename: string): string {
  const n = filename.split("/").pop() ?? filename;
  return n.includes(".") ? n.slice(0, n.lastIndexOf(".")) : n;
}

function extOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte);
}

/** 素材图片/视频流式返回，processed 缺失回退 raw */
const materialImageHandler = ({
  params,
  query,
  request,
  status,
}: {
  params: { id: string };
  query: { type?: string; strict?: string; size?: string };
  request: Request;
  status: (code: number, msg: string) => unknown;
}) => {
  const m = getMaterial(params.id);
  if (!m) return status(404, "素材不存在");
  let path: string | null = query.type === "raw" ? m.raw_path : m.processed_path;
  if (query.strict === "1" && (!path || !existsSync(path))) return status(404, "指定图片槽位不存在");
  if (!path || !existsSync(path)) path = m.raw_path;
  if (!path || !existsSync(path)) return status(404, "文件不存在");
  const lower = path.toLowerCase();
  const contentType = lower.endsWith(".mp4")
    ? "video/mp4"
    : lower.endsWith(".webm")
      ? "video/webm"
      : lower.endsWith(".mov")
        ? "video/quicktime"
        : "image/png";
  const size = parseThumbnailSize(query.size);
  if (size && contentType.startsWith("image/") && isImagePath(path)) {
    return getThumbnailPath(path, size).then((thumbnail) =>
      serveMediaFile(thumbnail ?? path!, request, "image/png")
    );
  }
  return serveMediaFile(path, request, contentType);
};

export const materialsApi = new Elysia({ prefix: "/api" })
  // 素材列表（按创建时间倒序）
  .get("/materials", () => {
    const rows = db.query("SELECT * FROM materials ORDER BY created_at DESC").all() as MaterialRow[];
    return { materials: rows.map(serializeMaterial) };
  })
  .patch(
    "/materials/:id",
    ({ params, body, status }) => {
      const name = body.name.trim();
      if (!name) return status(400, "素材名称不能为空");
      const material = renameMaterial(params.id, name);
      if (!material) return status(404, "素材不存在");
      broadcast("material_updated", { id: params.id });
      return { material: serializeMaterial(material) };
    },
    { body: t.Object({ name: t.String({ minLength: 1, maxLength: 200 }) }) }
  )
  // 素材图片，processed 缺失回退 raw（.png 后缀别名：让浏览器按扩展名判定图片类型）
  .get("/materials/:id/image", materialImageHandler)
  .get("/materials/:id/image.png", materialImageHandler)
  // 上传素材：单图 → 直接入库；GIF/MP4 → 队列拆帧，每帧一个素材
  .post(
    "/materials/upload",
    async ({ body }) => {
      const origName = body.file.name ?? "素材";
      const ext = extOf(origName);
      const autoMatting = body.autoMatting === "true";

      // Pipeline 浏览器抽帧失败时先保存视频本体，再走 /extract 的定点时间戳路径。
      // 默认行为保持不变：普通素材上传仍然直接创建整段抽帧任务。
      if ((ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm") && body.deferExtract === "true") {
        const id = uid();
        const dir = join(STORAGE_ROOT, "materials", id);
        mkdirSync(dir, { recursive: true });
        const rawPath = join(dir, `raw.${ext}`);
        await Bun.write(rawPath, Buffer.from(await body.file.arrayBuffer()));
        db.query(
          "INSERT INTO materials (id, name, raw_path, status, source, folder_id, created_at) VALUES (?, ?, ?, 'raw', 'upload', ?, ?)"
        ).run(id, baseName(origName) || "视频素材", rawPath, body.folderId || null, Date.now());
        broadcast("materials_changed", {});
        return { materialId: id };
      }

      if (ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm") {
        const stagingId = uid();
        const dir = join(STORAGE_ROOT, "staging", stagingId);
        mkdirSync(dir, { recursive: true });
        const stagingFile = join(dir, `input.${ext}`);
        await Bun.write(stagingFile, Buffer.from(await body.file.arrayBuffer()));
        const fps = Math.min(Math.max(parseInt(body.fps ?? "8", 10) || 8, 1), 60);
        const jobId = createJob("extract_frames", {
          extract: {
            stagingFile,
            mediaType: ext === "gif" ? "gif" : "mp4",
            fps,
            autoMatting,
            originName: baseName(origName),
            folderId: body.folderId || null,
          },
        });
        return { jobId };
      }

      // PNG/JPG 等单图 → 1 个素材
      const id = uid();
      const dir = join(STORAGE_ROOT, "materials", id);
      mkdirSync(dir, { recursive: true });
      const rawPath = join(dir, "raw.png");
      await Bun.write(rawPath, Buffer.from(await body.file.arrayBuffer()));
      const processedPath = body.processedFile ? join(dir, "processed.png") : null;
      if (body.processedFile && processedPath) {
        await Bun.write(processedPath, Buffer.from(await body.processedFile.arrayBuffer()));
      }
      const folderId = body.folderId || null;
      let metadata: Record<string, unknown> = {};
      if (body.metadata) {
        try {
          const parsed = typeof body.metadata === "string" ? JSON.parse(body.metadata) as unknown : body.metadata;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
        } catch {
          // 非法 metadata 不阻断文件上传，仅按空对象保存。
        }
      }
      db.query(
        "INSERT INTO materials (id, name, raw_path, processed_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, 'image', ?, ?, ?)"
      ).run(id, baseName(origName) || "素材", rawPath, processedPath, processedPath ? "matted" : "raw", folderId, JSON.stringify(metadata), Date.now());
      if (autoMatting && !processedPath) createMattingJob(id);
      broadcast("materials_changed", {});
      return { materialId: id };
    },
    {
      body: t.Object({
        file: t.File(),
        processedFile: t.Optional(t.File()),
        metadata: t.Optional(t.Union([t.String(), t.Record(t.String(), t.Unknown())])),
        autoMatting: t.Optional(t.String()),
        fps: t.Optional(t.String()),
        deferExtract: t.Optional(t.String()),
        folderId: t.Optional(t.String()),
      }),
    }
  )
  // CLI 生成素材（可选引用图）
  .post(
    "/materials/generate",
    ({ body, status }) => {
      // 引用图 id 解析 + 模板一致性前置校验（在创建 job 前就 400）
      const ref = resolveReferencePaths(body);
      if (ref.error) return status(400, ref.error);
      const videoErr = checkVideoSupport(body);
      if (videoErr) return status(400, videoErr);
      const referenceMaterialId = body.referenceMaterialId ?? body.references?.[0]?.id;
      const jobId = createJob("generate_materials", {
        generate: {
          prompt: body.prompt,
          count: body.count,
          autoMatting: body.autoMatting ?? false,
          name: body.name,
          referencePaths: ref.referencePaths,
          providerId: body.providerId,
          model: body.model,
          size: body.size,
          mediaKind: body.mediaKind,
          videoInputMode: body.videoInputMode,
          fps: body.fps,
          folderId: body.folderId ?? null,
          intent: body.intent,
          referenceMaterialId,
        },
      });
      return { jobId };
    },
    {
      body: t.Object({
        prompt: t.String(),
        count: t.Integer({ minimum: 1, maximum: 16 }),
        autoMatting: t.Optional(t.Boolean()),
        name: t.Optional(t.String()),
        referenceMaterialId: t.Optional(t.String()),
        poseReferenceMaterialId: t.Optional(t.String()),
        references: t.Optional(t.Array(t.Object({
          kind: t.Literal("material"),
          id: t.String(),
        }), { maxItems: 10 })),
        providerId: t.Optional(t.String()),
        model: t.Optional(t.String()),
        size: t.Optional(t.String()),
        mediaKind: t.Optional(t.Union([t.Literal("image"), t.Literal("video")])),
        // 本次请求期望的视频输入形态；缺省回退设置页声明与模型名推断
        videoInputMode: t.Optional(t.Union(VIDEO_INPUT_MODES.map((mode) => t.Literal(mode)))),
        fps: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
        intent: t.Optional(t.Union([t.Literal("frame-image"), t.Literal("frame-sheet"), t.Literal("frame-video")])),
      }),
    }
  )
  // 图片场景分层：使用独立配置，前置校验后创建异步任务
  .post(
    "/materials/:id/layers",
    ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const input = m.processed_path && existsSync(m.processed_path) ? m.processed_path : m.raw_path;
      if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) return status(400, "只支持图片素材分层");
      const settings = getImageLayerSettings(body.providerId);
      if (!imageLayerConfigured(settings)) return status(400, "图片分层服务未配置完整");
      const jobId = createJob("image_layers", { imageLayers: {
        materialId: m.id, model: settings.model, layers: body.layers,
        numInferenceSteps: body.numInferenceSteps, trueCfgScale: body.trueCfgScale,
        negativePrompt: body.negativePrompt?.trim() || undefined, seed: body.seed,
        autoMatting: body.autoMatting,
      } });
      return { jobId };
    },
    { body: t.Object({
      // providerId/model 仅兼容旧客户端；新请求使用独立 imageLayers 设置。
      providerId: t.Optional(t.String()), model: t.Optional(t.String()),
      layers: t.Integer({ minimum: IMAGE_LAYER_COUNT_MIN, maximum: IMAGE_LAYER_COUNT_MAX }),
      numInferenceSteps: t.Integer({ minimum: 1, maximum: 100 }),
      trueCfgScale: t.Number({ minimum: 0, maximum: 20 }),
      negativePrompt: t.Optional(t.String()), seed: t.Integer({ minimum: 0 }),
      autoMatting: t.Optional(t.Boolean()),
    }) }
  )
  // 执行抠图：入队异步执行（模型首次下载可能耗时数分钟，同步会挂死请求；与批量抠图同路径）
  .post("/materials/:id/matting", ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    if (!m.raw_path || !existsSync(m.raw_path)) return status(400, "素材缺少 raw 文件");
    if (/\.(mp4|mov|webm|avi)$/i.test(m.raw_path)) return status(400, "视频素材不能抠图，请先抽帧");
    const r = createMattingJob(params.id);
    if (r.duplicate) return status(409, "该素材已有进行中的抠图任务");
    return { jobId: r.jobId };
  })
  // 视频抽帧：复制到 staging → extract_frames → 每帧一个素材（同文件夹）
  // body.timestamps 有值 → 定点抽帧（仅视频）；否则整段按 fps（GIF/视频）
  .post(
    "/materials/:id/extract",
    ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      if (!m.raw_path || !existsSync(m.raw_path)) return status(400, "素材缺少文件");
      const isGif = /\.(gif)$/i.test(m.raw_path);
      const isVideo = /\.(mp4|mov|webm|avi)$/i.test(m.raw_path);
      if (!isGif && !isVideo) return status(400, "仅视频/GIF 素材可抽帧");

      const rawTs = Array.isArray(body.timestamps) ? body.timestamps : null;
      if (rawTs) {
        if (isGif) return status(400, "GIF 不支持定点抽帧，请用 fps 整段拆帧");
        if (rawTs.length > EXTRACT_TIMESTAMPS_MAX) {
          return status(400, `最多 ${EXTRACT_TIMESTAMPS_MAX} 个时间点`);
        }
      }

      const stagingId = uid();
      const dir = join(STORAGE_ROOT, "staging", stagingId);
      mkdirSync(dir, { recursive: true });
      const ext = m.raw_path.includes(".") ? m.raw_path.split(".").pop()!.toLowerCase() : "mp4";
      const stagingFile = join(dir, `input.${ext}`);
      copyFileSync(m.raw_path, stagingFile);
      const fps = Math.min(Math.max(body.fps ?? 8, 1), 60);

      let mode: "fps" | "timestamps" = "fps";
      let timestamps: number[] | undefined;
      if (rawTs) {
        timestamps = normalizeExtractTimestamps(rawTs.map(Number));
        if (timestamps.length === 0) return status(400, "未提供有效抽帧时间点");
        mode = "timestamps";
      }

      const jobId = createJob("extract_frames", {
        extract: {
          stagingFile,
          mediaType: isGif ? "gif" : "mp4",
          fps,
          mode,
          timestamps,
          autoMatting: body.autoMatting ?? false,
          originName: (m.name || "素材").replace(/\s*#\d+$/, "").trim() || "素材",
          folderId: body.folderId !== undefined ? body.folderId : m.folder_id,
        },
      });
      return { jobId };
    },
    {
      body: t.Object({
        fps: t.Optional(t.Integer({ minimum: 1, maximum: 60 })),
        timestamps: t.Optional(t.Array(t.Number(), { maxItems: 64 })),
        autoMatting: t.Optional(t.Boolean()),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  // 批量抠图：仅对未抠图（raw）入队；已抠图 / 视频 / 已有进行中任务跳过
  .post(
    "/materials/batch-matting",
    ({ body }) => {
      let count = 0;
      let skipped = 0;
      for (const id of body.ids) {
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
      return { ok: true, count, skipped };
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  )
  // 替换图片（剪裁工具产出）：slot=raw 覆盖原图；slot=processed 覆盖/建立抠图结果
  .post(
    "/materials/:id/replace-image",
    async ({ params, body, status }) => {
      const m = getMaterial(params.id);
      if (!m) return status(404, "素材不存在");
      const bytes = Buffer.from(await body.file.arrayBuffer());
      if (!isPng(bytes)) return status(400, "替换图片必须是 PNG（请通过剪裁工具提交）");
      let target: string;
      if (body.slot === "raw") {
        if (!m.raw_path) return status(400, "素材缺少 raw 文件");
        target = m.raw_path;
      } else {
        target = m.processed_path ?? join(STORAGE_ROOT, "materials", params.id, "processed.png");
      }
      mkdirSync(dirname(target), { recursive: true });
      await Bun.write(target, bytes);
      if (body.slot === "processed" && (m.status !== "matted" || m.processed_path !== target)) {
        db.query("UPDATE materials SET status = 'matted', processed_path = ? WHERE id = ?").run(target, params.id);
      }
      broadcast("material_updated", { id: params.id });
      return { material: serializeMaterial(getMaterial(params.id)!) };
    },
    {
      body: t.Object({
        file: t.File(),
        slot: t.Union([t.Literal("raw"), t.Literal("processed")]),
      }),
    }
  )
  // 还原原图：删除 processed
  .post("/materials/:id/unmatting", ({ params, status }) => {
    const m = getMaterial(params.id);
    if (!m) return status(404, "素材不存在");
    if (m.processed_path && existsSync(m.processed_path)) rmSync(m.processed_path);
    db.query("UPDATE materials SET status = 'raw', processed_path = NULL WHERE id = ?").run(params.id);
    broadcast("material_updated", { id: params.id });
    return { material: serializeMaterial(getMaterial(params.id)!) };
  })
  // 批量删除
  .post(
    "/materials/batch-delete",
    ({ body }) => {
      const stmt = db.query("DELETE FROM materials WHERE id = ?");
      let deleted = 0;
      for (const id of body.ids) {
        const m = getMaterial(id);
        if (!m) continue;
        stmt.run(id);
        deleted++;
        rmSync(join(STORAGE_ROOT, "materials", id), { recursive: true, force: true });
      }
      broadcast("materials_changed", {});
      return { ok: true, deleted };
    },
    { body: t.Object({ ids: t.Array(t.String()) }) }
  );
