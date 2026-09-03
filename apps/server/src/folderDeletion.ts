import type { FolderKind } from "@ezgameart/shared";
import { db } from "./db";

type FolderRow = {
  id: string;
  kind: string;
  parent_id: string | null;
};

export type FolderDeletionResult =
  | { ok: true; deleted: number }
  | { ok: false; status: 400 | 404; message: string };

/**
 * 删除一个或多个文件夹根节点。若同时选中父子目录，只处理父目录，避免重复操作。
 * 每个根目录中的素材会移动到该根目录的父级，素材记录本身不会删除。
 */
export function deleteFolderRoots(ids: string[], kind: FolderKind): FolderDeletionResult {
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) return { ok: false, status: 400, message: "至少选择一个文件夹" };

  const allFolders = db.query("SELECT id, kind, parent_id FROM folders").all() as FolderRow[];
  const rowById = new Map(allFolders.map((row) => [row.id, row]));
  const rows: FolderRow[] = [];
  for (const id of uniqueIds) {
    const row = rowById.get(id);
    if (!row) return { ok: false, status: 404, message: "文件夹不存在" };
    if (row.kind !== kind) return { ok: false, status: 400, message: "文件夹类型不匹配" };
    rows.push(row);
  }

  const kindFolders = allFolders.filter((folder) => folder.kind === kind);
  const folderById = new Map(kindFolders.map((folder) => [folder.id, folder]));
  const selected = new Set(uniqueIds);
  const roots = rows.filter((row) => {
    const seen = new Set<string>();
    let parentId = row.parent_id;
    while (parentId && !seen.has(parentId)) {
      if (selected.has(parentId)) return false;
      seen.add(parentId);
      parentId = folderById.get(parentId)?.parent_id ?? null;
    }
    return true;
  });

  const children = new Map<string, string[]>();
  for (const folder of kindFolders) {
    if (!folder.parent_id) continue;
    const list = children.get(folder.parent_id) ?? [];
    list.push(folder.id);
    children.set(folder.parent_id, list);
  }

  const subtrees = roots.map((root) => {
    const subtree: string[] = [];
    const stack = [root.id];
    const seen = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      subtree.push(id);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    return { parentId: root.parent_id, ids: subtree };
  });

  const deleted = subtrees.reduce((count, subtree) => count + subtree.ids.length, 0);
  const tx = db.transaction(() => {
    for (const subtree of subtrees) {
      for (const folderId of subtree.ids) {
        db.query("UPDATE materials SET folder_id = ? WHERE folder_id = ?").run(subtree.parentId, folderId);
      }
      for (const folderId of subtree.ids) {
        db.query("DELETE FROM folders WHERE id = ?").run(folderId);
      }
    }
  });
  tx();
  return { ok: true, deleted };
}
