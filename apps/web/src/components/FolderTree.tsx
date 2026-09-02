import { useEffect, useMemo, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronDown, ChevronRight, FolderPlus, Pencil, Trash2 } from "lucide-react";
import type { Folder, FolderKind } from "../api";
import { useT } from "../i18n";
import { askConfirm, notify } from "../notice";
import ContextMenu, { type CtxMenuItem } from "./ContextMenu";
import IconBtn from "./IconBtn";

export type FolderSelection = "all" | "ungrouped" | string;

interface Props {
  kind: FolderKind;
  title?: string;
  className?: string;
  folders: Folder[];
  selected: FolderSelection;
  onSelect: (s: FolderSelection) => void;
  onCreate: (name: string, parentId: string | null) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMoveFolder: (id: string, parentId: string | null) => Promise<void>;
  /** 资源拖放到文件夹（null = 未分组） */
  onDropItems?: (folderId: string | null, ids: string[]) => void;
}

type TreeNode = Folder & { children: TreeNode[] };

/** 右键目标：根区新建 / 虚拟节点 / 真实文件夹 */
type CtxTarget =
  | { kind: "root" }
  | { kind: "all" }
  | { kind: "ungrouped" }
  | { kind: "folder"; folder: Folder; hasChildren: boolean; open: boolean };

function buildTree(folders: Folder[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  for (const f of folders) map.set(f.id, { ...f, children: [] });
  const roots: TreeNode[] = [];
  for (const n of map.values()) {
    if (n.parent_id && map.has(n.parent_id)) map.get(n.parent_id)!.children.push(n);
    else roots.push(n);
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) => a.sort - b.sort || a.created_at - b.created_at);
    list.forEach((c) => sortRec(c.children));
  };
  sortRec(roots);
  return roots;
}

function parseDragIds(e: React.DragEvent): string[] {
  try {
    const raw = e.dataTransfer.getData("application/x-ezgameart-ids");
    if (raw) return JSON.parse(raw) as string[];
  } catch {
    /* ignore */
  }
  return [];
}

/** 左侧多级目录树：全部 / 未分组 + 文件夹 CRUD / DnD / 右键菜单 */
export default function FolderTree({
  kind,
  title,
  className,
  folders,
  selected,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onMoveFolder,
  onDropItems,
}: Props) {
  const t = useT();
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; target: CtxTarget } | null>(null);

  // 新建文件夹时默认展开祖先
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const f of folders) {
        if (f.parent_id) next.add(f.parent_id);
      }
      return next;
    });
  }, [folders]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openCtx = (e: React.MouseEvent, target: CtxTarget) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, target });
  };

  const startRename = (f: Folder) => {
    setEditingId(f.id);
    setEditName(f.name);
  };

  const commitRename = async () => {
    if (!editingId) return;
    const name = editName.trim();
    setEditingId(null);
    if (!name) return;
    try {
      await onRename(editingId, name);
    } catch (e) {
      notify(t("msg.operation_failed_msg", { msg: (e as Error).message }));
    }
  };

  const handleCreate = async (parentId: string | null) => {
    const name = t("msg.untitled_folder");
    try {
      await onCreate(name, parentId);
      if (parentId) setExpanded((prev) => new Set(prev).add(parentId));
    } catch (e) {
      notify(t("msg.create_failed_msg", { msg: (e as Error).message }));
    }
  };

  const handleDelete = async (f: Folder) => {
    if (!(await askConfirm(t("msg.delete_folder_name_contents_move_up_resources_kept", { name: f.name })))) return;
    try {
      await onDelete(f.id);
      if (selected === f.id) onSelect("all");
    } catch (e) {
      notify(t("msg.delete_failed_msg", { msg: (e as Error).message }));
    }
  };

  const onDragOverRow = (e: React.DragEvent, key: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // 函数式更新：值未变时返回旧值触发 React bailout，避免 dragover 高频重渲染
    setDropTarget((prev) => (prev === key ? prev : key));
  };

  const onDropRow = async (e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    setDropTarget(null);
    const folderDrag = e.dataTransfer.getData("application/x-ezgameart-folder");
    if (folderDrag) {
      if (folderDrag === folderId) return;
      try {
        await onMoveFolder(folderDrag, folderId);
      } catch (err) {
        notify(t("msg.operation_failed_msg", { msg: (err as Error).message }));
      }
      return;
    }
    const ids = parseDragIds(e);
    if (ids.length && onDropItems) onDropItems(folderId, ids);
  };

  const ctxItems: CtxMenuItem[] = (() => {
    if (!ctxMenu) return [];
    const target = ctxMenu.target;
    if (target.kind === "folder") {
      const items: CtxMenuItem[] = [
        {
          label: t("msg.new_subfolder"),
          icon: <FolderPlus size={13} />,
          onClick: () => void handleCreate(target.folder.id),
        },
        {
          label: t("msg.rename"),
          icon: <Pencil size={13} />,
          onClick: () => startRename(target.folder),
        },
      ];
      if (target.hasChildren) {
        items.push({
          label: target.open ? t("msg.collapse") : t("msg.expand"),
          icon: target.open ? <ChevronDown size={13} /> : <ChevronRight size={13} />,
          onClick: () => toggle(target.folder.id),
        });
      }
      items.push({
        label: t("msg.delete_folder"),
        icon: <Trash2 size={13} />,
        danger: true,
        onClick: () => void handleDelete(target.folder),
      });
      return items;
    }
    return [
      {
        label: t("msg.new_folder"),
        icon: <FolderPlus size={13} />,
        onClick: () => void handleCreate(null),
      },
    ];
  })();

  const renderNode = (n: TreeNode, depth: number) => {
    const open = expanded.has(n.id);
    const isSel = selected === n.id;
    const isDrop = dropTarget === n.id;
    return (
      <div key={n.id} className="folder-node">
        <div
          className={`folder-row ${isSel ? "on" : ""} ${isDrop ? "drop" : ""}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/x-ezgameart-folder", n.id);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => onDragOverRow(e, n.id)}
          onDragLeave={() => setDropTarget((d) => (d === n.id ? null : d))}
          onDrop={(e) => void onDropRow(e, n.id)}
          onClick={() => onSelect(n.id)}
          onContextMenu={(e) =>
            openCtx(e, { kind: "folder", folder: n, hasChildren: n.children.length > 0, open })
          }
        >
          <button
            type="button"
            className="folder-twist"
            onClick={(e) => {
              e.stopPropagation();
              toggle(n.id);
            }}
            title={open ? t("msg.collapse") : t("msg.expand")}
          >
            {n.children.length ? open ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : <span className="folder-twist-sp" />}
          </button>
          {editingId === n.id ? (
            <input
              className="px-input folder-rename"
              autoFocus
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (e.key === "Enter") void commitRename();
                if (e.key === "Escape") setEditingId(null);
              }}
            />
          ) : (
            <span className="folder-name">{n.name}</span>
          )}
          <span className="folder-acts" onClick={(e) => e.stopPropagation()}>
            <IconBtn title={t("msg.new_subfolder")} onClick={() => void handleCreate(n.id)}>
              <FolderPlus size={12} />
            </IconBtn>
            <IconBtn title={t("msg.rename")} onClick={() => startRename(n)}>
              <Pencil size={12} />
            </IconBtn>
            <IconBtn className="danger" title={t("msg.delete_folder")} onClick={() => void handleDelete(n)}>
              <Trash2 size={12} />
            </IconBtn>
          </span>
        </div>
        {open && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <aside className={`folder-tree pixel-panel${className ? ` ${className}` : ""}`} onContextMenu={(e) => openCtx(e, { kind: "root" })}>
      <div className="folder-tree-head" onContextMenu={(e) => openCtx(e, { kind: "root" })}>
        <span>{title ?? t("msg.folders")}</span>
        <IconBtn title={t("msg.new_folder")} onClick={() => void handleCreate(null)}>
          <FolderPlus size={14} />
        </IconBtn>
      </div>
      <button
        type="button"
        className={`folder-row virtual ${selected === "all" ? "on" : ""}`}
        onClick={() => onSelect("all")}
        onContextMenu={(e) => openCtx(e, { kind: "all" })}
      >
        <span className="folder-name">{t("msg.all")}</span>
      </button>
      <button
        type="button"
        className={`folder-row virtual ${selected === "ungrouped" ? "on" : ""} ${dropTarget === "ungrouped" ? "drop" : ""}`}
        onClick={() => onSelect("ungrouped")}
        onDragOver={(e) => onDragOverRow(e, "ungrouped")}
        onDragLeave={() => setDropTarget((d) => (d === "ungrouped" ? null : d))}
        onDrop={(e) => void onDropRow(e, null)}
        onContextMenu={(e) => openCtx(e, { kind: "ungrouped" })}
      >
        <span className="folder-name">{t("msg.ungrouped")}</span>
      </button>
      <div className="folder-tree-list">{tree.map((n) => renderNode(n, 0))}</div>
      {/* kind 仅用于语义区分，避免 unused */}
      <span hidden>{kind}</span>

      <AnimatePresence>
        {ctxMenu && ctxItems.length > 0 && (
          <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} onClose={() => setCtxMenu(null)} />
        )}
      </AnimatePresence>
    </aside>
  );
}
