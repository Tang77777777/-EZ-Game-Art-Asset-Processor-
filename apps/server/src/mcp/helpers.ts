import type { FolderKind } from "@ezgameart/shared";
import { db } from "../db";

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function err(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// ===== 文件夹辅助 =====

export type FolderRow = {
  id: string;
  kind: string;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
};

export function getFolderRow(id: string): FolderRow | null {
  return (db.query("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | null) ?? null;
}

export function collectDescendants(rootId: string): Set<string> {
  const all = db.query("SELECT id, parent_id FROM folders").all() as Array<{
    id: string;
    parent_id: string | null;
  }>;
  const children = new Map<string | null, string[]>();
  for (const r of all) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r.id);
    children.set(r.parent_id, list);
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of children.get(id) ?? []) stack.push(c);
  }
  return out;
}

export function validateFolderParent(
  kind: FolderKind,
  parentId: string | null,
  selfId?: string
): string | null {
  if (!parentId) return null;
  const parent = getFolderRow(parentId);
  if (!parent) return "父文件夹不存在";
  if (parent.kind !== kind) return "父文件夹类型不匹配";
  if (selfId && collectDescendants(selfId).has(parentId)) return "不能把文件夹移到自身或子孙下";
  return null;
}

export function nextFolderSort(kind: FolderKind, parentId: string | null): number {
  const row = db
    .query("SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM folders WHERE kind = ? AND parent_id IS ?")
    .get(kind, parentId) as { next: number };
  return row.next;
}
