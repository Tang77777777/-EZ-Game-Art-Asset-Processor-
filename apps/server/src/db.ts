import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Material, MaterialRow } from "@ezgameart/shared";

// 仓库根目录（apps/server/src → 根）：storage 固定放在根级，与启动时的 cwd 无关
export const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
export const STORAGE_ROOT = join(REPO_ROOT, "storage");

// 确保运行时目录存在
mkdirSync(join(STORAGE_ROOT, "staging"), { recursive: true });
mkdirSync(join(STORAGE_ROOT, "materials"), { recursive: true });

const DB_PATH = join(STORAGE_ROOT, "ezgameart.db");

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  name TEXT,
  raw_path TEXT,
  processed_path TEXT,
  status TEXT NOT NULL DEFAULT 'raw',
  source TEXT NOT NULL DEFAULT 'upload',
  folder_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folders_kind_parent ON folders(kind, parent_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

`);

export const uid = () => crypto.randomUUID();

export type { MaterialRow };

export function getMaterial(id: string): MaterialRow | null {
  return (db.query("SELECT * FROM materials WHERE id = ?").get(id) as MaterialRow | null) ?? null;
}

function parseJson<T>(text: string | null | undefined, fallback: T): T {
  try {
    return JSON.parse(text ?? "") as T;
  } catch {
    return fallback;
  }
}

export function serializeMaterial(m: MaterialRow): Material {
  const path = m.raw_path ?? m.processed_path ?? "";
  const kind: Material["kind"] = /\.(mp4|mov|webm|avi)$/i.test(path) ? "video" : "image";
  return { ...m, metadata: parseJson<Record<string, unknown>>(m.metadata, {}), kind } as Material;
}

export function renameMaterial(id: string, name: string): MaterialRow | null {
  if (!getMaterial(id)) return null;
  db.query("UPDATE materials SET name = ? WHERE id = ?").run(name, id);
  return getMaterial(id);
}
