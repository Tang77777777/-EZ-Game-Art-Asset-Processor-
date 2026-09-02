import { Elysia, t } from "elysia";
import { FOLDER_KINDS, type FolderKind } from "@ezgameart/shared";
import { db, uid } from "../db";
import { broadcast } from "../ws";

type FolderRow = {
  id: string;
  kind: string;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
};

function getFolder(id: string): FolderRow | null {
  return (db.query("SELECT * FROM folders WHERE id = ?").get(id) as FolderRow | null) ?? null;
}

/** 收集某节点的全部子孙 id（含自身） */
function collectDescendants(rootId: string): Set<string> {
  const all = db.query("SELECT id, parent_id FROM folders").all() as Array<{ id: string; parent_id: string | null }>;
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

function assertFolderKind(kind: string): kind is FolderKind {
  return (FOLDER_KINDS as readonly string[]).includes(kind);
}

function nextSort(kind: FolderKind, parentId: string | null): number {
  const row = db
    .query("SELECT COALESCE(MAX(sort), -1) + 1 AS next FROM folders WHERE kind = ? AND parent_id IS ?")
    .get(kind, parentId) as { next: number };
  return row.next;
}

function validateParent(kind: FolderKind, parentId: string | null, selfId?: string): string | null {
  if (!parentId) return null;
  const parent = getFolder(parentId);
  if (!parent) return "父文件夹不存在";
  if (parent.kind !== kind) return "父文件夹类型不匹配";
  if (selfId && collectDescendants(selfId).has(parentId)) return "不能把文件夹移到自身或子孙下";
  return null;
}


export const foldersApi = new Elysia({ prefix: "/api" })
  .get("/folders", ({ query, status }) => {
    const kind = query.kind ?? "";
    if (!assertFolderKind(kind)) return status(400, `kind 须为 ${FOLDER_KINDS.join(" | ")}`);
    const rows = db
      .query("SELECT * FROM folders WHERE kind = ? ORDER BY parent_id IS NOT NULL, sort, created_at")
      .all(kind) as FolderRow[];
    return { folders: rows };
  })
  .post(
    "/folders",
    ({ body, status }) => {
      if (!assertFolderKind(body.kind)) return status(400, `kind 须为 ${FOLDER_KINDS.join(" | ")}`);
      const parentId = body.parentId ?? null;
      const err = validateParent(body.kind, parentId);
      if (err) return status(400, err);
      const id = uid();
      const name = body.name.trim() || "未命名文件夹";
      const sort = nextSort(body.kind, parentId);
      const created_at = Date.now();
      db.query(
        "INSERT INTO folders (id, kind, parent_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, body.kind, parentId, name, sort, created_at);
      broadcast("folders_changed", { kind: body.kind });
      return { folder: { id, kind: body.kind, parent_id: parentId, name, sort, created_at } };
    },
    {
      body: t.Object({
        kind: t.String(),
        name: t.String(),
        parentId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  .patch(
    "/folders/:id",
    ({ params, body, status }) => {
      const row = getFolder(params.id);
      if (!row) return status(404, "文件夹不存在");
      const kind = row.kind as FolderKind;
      let parentId = row.parent_id;
      let name = row.name;
      if (body.name !== undefined) name = body.name.trim() || "未命名文件夹";
      if (body.parentId !== undefined) {
        parentId = body.parentId;
        const err = validateParent(kind, parentId, params.id);
        if (err) return status(400, err);
      }
      db.query("UPDATE folders SET name = ?, parent_id = ? WHERE id = ?").run(name, parentId, params.id);
      broadcast("folders_changed", { kind });
      return { ok: true };
    },
    {
      body: t.Object({
        name: t.Optional(t.String()),
        parentId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  )
  .delete("/folders/:id", ({ params, status }) => {
    const row = getFolder(params.id);
    if (!row) return status(404, "文件夹不存在");
    const kind = row.kind as FolderKind;
    const table = "materials";
    const subtree = [...collectDescendants(params.id)];
    const parentId = row.parent_id;
    const tx = db.transaction(() => {
      // 子树内资源上移到被删根节点的父级，再删整棵文件夹子树
      for (const fid of subtree) {
        db.query(`UPDATE ${table} SET folder_id = ? WHERE folder_id = ?`).run(parentId, fid);
      }
      for (const fid of subtree) {
        db.query("DELETE FROM folders WHERE id = ?").run(fid);
      }
    });
    tx();
    broadcast("folders_changed", { kind });
    broadcast("materials_changed", {});
    return { ok: true };
  })
  .post(
    "/folders/move-items",
    ({ body, status }) => {
      if (!assertFolderKind(body.kind)) return status(400, `kind 须为 ${FOLDER_KINDS.join(" | ")}`);
      const folderId = body.folderId ?? null;
      if (folderId) {
        const f = getFolder(folderId);
        if (!f) return status(404, "文件夹不存在");
        if (f.kind !== body.kind) return status(400, "文件夹类型不匹配");
      }
      const table = "materials";
      let moved = 0;
      for (const id of body.ids) {
        const exists = db.query(`SELECT id FROM ${table} WHERE id = ?`).get(id);
        if (!exists) continue;
        db.query(`UPDATE ${table} SET folder_id = ? WHERE id = ?`).run(folderId, id);
        moved++;
      }
      broadcast("materials_changed", {});
      return { ok: true, moved };
    },
    {
      body: t.Object({
        kind: t.String(),
        ids: t.Array(t.String()),
        folderId: t.Optional(t.Union([t.String(), t.Null()])),
      }),
    }
  );
