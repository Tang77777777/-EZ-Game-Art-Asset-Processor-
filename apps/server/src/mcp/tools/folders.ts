import * as z from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/server";
import type { FolderKind } from "@ezgameart/shared";
import { db, uid } from "../../db";
import { broadcast } from "../../ws";
import { ok, err, getFolderRow, validateFolderParent, nextFolderSort } from "../helpers";
import { deleteFolderRoots } from "../../folderDeletion";

export function register(server: McpServer) {
  server.registerTool(
    "list_folders",
    {
      title: "List Folders",
      description:
        "List all material folders as a flat list. Frontend groups them into a tree by parent_id.",
      inputSchema: z.object({
        kind: z.enum(["material"]).describe("Folder kind"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ kind }) => {
      const rows = db
        .query("SELECT * FROM folders WHERE kind = ? ORDER BY parent_id IS NOT NULL, sort, created_at")
        .all(kind);
      return ok({ folders: rows });
    }
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create Folder",
      description: "Create a new folder for organizing materials.",
      inputSchema: z.object({
        kind: z.enum(["material"]).describe("Folder kind"),
        name: z.string().describe("Folder name (defaults to 未命名文件夹)"),
        parentId: z.string().describe("Parent folder UUID (null for root level)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ kind, name, parentId: rawParentId }) => {
      const parentId = rawParentId ?? null;
      const err_ = validateFolderParent(kind, parentId);
      if (err_) return err(err_);
      const id = uid();
      const finalName = name.trim() || "未命名文件夹";
      const sort = nextFolderSort(kind, parentId);
      const created_at = Date.now();
      db.query(
        "INSERT INTO folders (id, kind, parent_id, name, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(id, kind, parentId, finalName, sort, created_at);
      broadcast("folders_changed", { kind });
      return ok({ folder: { id, kind, parent_id: parentId, name: finalName, sort, created_at } });
    }
  );

  server.registerTool(
    "update_folder",
    {
      title: "Update Folder",
      description: "Update a folder's name and/or parent. Cannot move a folder into itself or its descendants.",
      inputSchema: z.object({
        folderId: z.string().describe("Folder UUID"),
        name: z.string().describe("New folder name").optional(),
        parentId: z.string().describe("New parent folder UUID (null for root)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ folderId, name: newName, parentId: newParentId }) => {
      const row = getFolderRow(folderId);
      if (!row) return err("文件夹不存在");
      const kind = row.kind as FolderKind;
      let parentId = row.parent_id;
      let name = row.name;
      if (newName !== undefined) name = newName.trim() || "未命名文件夹";
      if (newParentId !== undefined) {
        parentId = newParentId ?? null;
        const err_ = validateFolderParent(kind, parentId, folderId);
        if (err_) return err(err_);
      }
      db.query("UPDATE folders SET name = ?, parent_id = ? WHERE id = ?").run(name, parentId, folderId);
      broadcast("folders_changed", { kind });
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "delete_folder",
    {
      title: "Delete Folder",
      description:
        "Delete a folder and all its descendant folders. Materials inside the deleted subtree are moved up to the deleted folder's parent (not deleted).",
      inputSchema: z.object({
        folderId: z.string().describe("Folder UUID to delete"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ folderId }) => {
      const row = getFolderRow(folderId);
      if (!row) return err("文件夹不存在");
      const kind = row.kind as FolderKind;
      const result = deleteFolderRoots([folderId], kind);
      if (!result.ok) return err(result.message);
      broadcast("folders_changed", { kind });
      broadcast("materials_changed", {});
      return ok({ ok: true });
    }
  );

  server.registerTool(
    "delete_folders",
    {
      title: "Delete Folders",
      description:
        "Delete multiple material folders in one operation. If a parent and child are both selected, only the parent is processed. Materials move to each deleted root's parent and are not deleted.",
      inputSchema: z.object({
        kind: z.enum(["material"]).describe("Folder kind"),
        folderIds: z.array(z.string()).describe("Folder UUIDs to delete"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ kind, folderIds }) => {
      const result = deleteFolderRoots(folderIds, kind);
      if (!result.ok) return err(result.message);
      broadcast("folders_changed", { kind });
      broadcast("materials_changed", {});
      return ok(result);
    }
  );

  server.registerTool(
    "move_items_to_folder",
    {
      title: "Move Items to Folder",
      description: "Move materials to a folder. Use folderId=null to ungroup (move to root).",
      inputSchema: z.object({
        kind: z.enum(["material"]).describe("Item kind"),
        ids: z.array(z.string()).describe("Item UUIDs to move"),
        folderId: z.string().describe("Target folder UUID (null for root/ungrouped)").optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ kind, ids, folderId: rawFolderId }) => {
      const folderId = rawFolderId ?? null;
      if (folderId) {
        const f = getFolderRow(folderId);
        if (!f) return err("文件夹不存在");
        if (f.kind !== kind) return err("文件夹类型不匹配");
      }
      const table = "materials";
      let moved = 0;
      for (const id of ids) {
        const exists = db.query(`SELECT id FROM ${table} WHERE id = ?`).get(id);
        if (!exists) continue;
        db.query(`UPDATE ${table} SET folder_id = ? WHERE id = ?`).run(folderId, id);
        moved++;
      }
      broadcast("materials_changed", {});
      return ok({ ok: true, moved });
    }
  );
}
