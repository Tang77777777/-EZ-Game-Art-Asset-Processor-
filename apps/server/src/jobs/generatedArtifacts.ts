import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { GenerationIntent, GenProviderType } from "@ezgameart/shared";
import { db, STORAGE_ROOT, uid } from "../db";
import { broadcast } from "../ws";

type EnqueueMatting = (materialId: string) => void;
type MediaKind = "image" | "video";

interface ArtifactAllocation {
  kind: MediaKind;
  requestedKind: MediaKind;
  index: number;
  path: string;
  id?: string;
  disposableDir?: string;
}

export interface ArtifactCommitResult {
  kind: MediaKind;
  id: string;
}

function isVideoArtifact(path: string): boolean {
  const buffer = Buffer.alloc(16);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  const head = buffer.toString("latin1");
  return (
    head.slice(4, 8) === "ftyp" ||
    head.startsWith("\x1a\x45\xdf\xa3") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "AVI ")
  );
}

export function createGeneratedArtifactCommitter(options: {
  count: number;
  autoMatting: boolean;
  name: string;
  folderId?: string | null;
  source: GenProviderType;
  prompt: string;
  providerName: string;
  model?: string;
  size?: string;
  enqueueMatting: EnqueueMatting;
  intent?: GenerationIntent;
  referenceMaterialId?: string;
}) {
  const ids: string[] = [];
  let finished = false;
  const metadata = (index: number) =>
    JSON.stringify({
      prompt: options.prompt,
      index,
      provider: options.providerName,
      model: options.model || undefined,
      size: options.size || undefined,
      intent: options.intent || undefined,
      referenceMaterialId: options.referenceMaterialId || undefined,
    });

  const allocate = (kind: MediaKind, index: number, requestedKind = kind): ArtifactAllocation => {
    if (kind === "video") {
      const dir = join(STORAGE_ROOT, "staging", `genvid_${uid()}`);
      mkdirSync(dir, { recursive: true });
      return { kind, requestedKind, index, path: join(dir, "output.mp4"), disposableDir: dir };
    }
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    return { kind, requestedKind, index, path: join(dir, "raw.png"), id, disposableDir: dir };
  };

  const discard = (allocation: ArtifactAllocation) => {
    if (allocation.disposableDir) rmSync(allocation.disposableDir, { recursive: true, force: true });
    else rmSync(allocation.path, { force: true });
  };

  const commitImage = (allocation: ArtifactAllocation): string => {
    const id = allocation.id ?? uid();
    // 视频请求误返单图时只会提交一项，不追加 #1。
    const total = allocation.requestedKind === "video" ? 1 : options.count;
    db.query(
      "INSERT INTO materials (id, name, raw_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, 'raw', ?, ?, ?, ?)"
    ).run(
      id,
      total > 1 ? `${options.name} #${allocation.index + 1}` : options.name,
      allocation.path,
      options.source,
      options.folderId ?? null,
      metadata(allocation.index),
      Date.now()
    );
    ids.push(id);
    return id;
  };

  const commitVideo = (allocation: ArtifactAllocation): string => {
    const id = uid();
    const dir = join(STORAGE_ROOT, "materials", id);
    mkdirSync(dir, { recursive: true });
    const rawPath = join(dir, "raw.mp4");
    renameSync(allocation.path, rawPath);
    if (allocation.disposableDir) rmSync(allocation.disposableDir, { recursive: true, force: true });
    const meta = JSON.stringify({ ...JSON.parse(metadata(0)), mediaKind: "video" });
    db.query(
      "INSERT INTO materials (id, name, raw_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, 'raw', ?, ?, ?, ?)"
    ).run(id, options.name, rawPath, options.source, options.folderId ?? null, meta, Date.now());
    broadcast("materials_changed", {});
    return id;
  };

  return {
    allocate(kind: MediaKind, index: number) {
      return allocate(kind, index);
    },
    discard(allocation: ArtifactAllocation) {
      discard(allocation);
    },
    /** 校验并识别实际媒体类型；provider 误返另一类型时在 module 内转换目标 allocation。 */
    commit(allocation: ArtifactAllocation): ArtifactCommitResult {
      if (!existsSync(allocation.path)) throw new Error(`生成执行成功但未产出文件: ${allocation.path}`);
      const actual: MediaKind = isVideoArtifact(allocation.path) ? "video" : "image";
      if (actual !== allocation.kind) {
        const converted = allocate(actual, allocation.index, allocation.requestedKind);
        renameSync(allocation.path, converted.path);
        discard(allocation);
        allocation = converted;
      }
      const id = actual === "video" ? commitVideo(allocation) : commitImage(allocation);
      return { kind: actual, id };
    },
    finish() {
      if (finished) return;
      finished = true;
      if (!ids.length) return;
      broadcast("materials_changed", {});
      if (options.autoMatting) for (const id of ids) options.enqueueMatting(id);
    },
  };
}
