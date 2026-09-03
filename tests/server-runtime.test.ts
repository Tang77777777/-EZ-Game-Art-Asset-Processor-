import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "../apps/server/src/app";
import { db, getMaterial, serializeMaterial, STORAGE_ROOT } from "../apps/server/src/db";
import { JobCancelledError, runCmd } from "../apps/server/src/jobs/run";
import { parseThumbnailSize, serveMediaFile } from "../apps/server/src/media";

describe("外部命令执行器", () => {
  test("成功命令正常结束", async () => {
    await expect(runCmd(["/usr/bin/true"])).resolves.toBeUndefined();
  });

  test("非零退出携带 stderr 上下文", async () => {
    await expect(runCmd(["/bin/sh", "-c", "echo command-failed >&2; exit 7"])).rejects.toThrow("命令执行失败 (/bin/sh): command-failed");
  });

  test("已取消的任务不会启动进程", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runCmd(["/usr/bin/false"], undefined, controller.signal)).rejects.toBeInstanceOf(JobCancelledError);
  });
});

describe("媒体响应", () => {
  test("缩略图尺寸只接受 64 到 1024 的整数", () => {
    expect(parseThumbnailSize("64")).toBe(64);
    expect(parseThumbnailSize("320")).toBe(320);
    expect(parseThumbnailSize("1024")).toBe(1024);
    for (const value of [undefined, "", "63", "1025", "64.5", " 320", "1e2"]) {
      expect(parseThumbnailSize(value)).toBeNull();
    }
  });

  test("图片支持版本化缓存与 ETag 条件请求", async () => {
    const path = `/tmp/ezgameart-media-${crypto.randomUUID()}.png`;
    try {
      await Bun.write(path, "image-bytes");
      const response = serveMediaFile(path, new Request("http://localhost/image.png?v=1"), "image/png");
      const etag = response.headers.get("etag");
      expect(await response.text()).toBe("image-bytes");
      expect(etag).toBeTruthy();
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");

      const revalidated = serveMediaFile(
        path,
        new Request("http://localhost/image.png", { headers: { "If-None-Match": etag! } }),
        "image/png"
      );
      expect(revalidated.status).toBe(304);
      expect(revalidated.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    } finally {
      unlinkSync(path);
    }
  });
});

describe("素材重命名", () => {
  test("更新素材名称并拒绝空名称和不存在的素材", async () => {
    const materialId = crypto.randomUUID();
    db.query("INSERT INTO materials (id, name, status, source, metadata, created_at) VALUES (?, '旧名称', 'raw', 'upload', '{}', ?)").run(materialId, Date.now());
    try {
      const renamed = await app.handle(new Request(`http://localhost/api/materials/${materialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  新名称  " }),
      }));
      expect(renamed.status).toBe(200);
      expect((await renamed.json()).material.name).toBe("新名称");
      expect(getMaterial(materialId)?.name).toBe("新名称");

      const empty = await app.handle(new Request(`http://localhost/api/materials/${materialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "   " }),
      }));
      expect(empty.status).toBe(400);

      const missing = await app.handle(new Request("http://localhost/api/materials/missing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "新名称" }),
      }));
      expect(missing.status).toBe(404);
    } finally {
      db.query("DELETE FROM materials WHERE id=?").run(materialId);
    }
  });
});

describe("文件夹批量删除", () => {
  test("父子目录只处理一次，并把素材上移而不删除素材", async () => {
    const rootId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const siblingId = crypto.randomUUID();
    const materialInChild = crypto.randomUUID();
    const materialInSibling = crypto.randomUUID();
    const now = Date.now();
    db.query("INSERT INTO folders (id, kind, parent_id, name, sort, created_at) VALUES (?, 'material', NULL, ?, 0, ?)").run(rootId, "根目录", now);
    db.query("INSERT INTO folders (id, kind, parent_id, name, sort, created_at) VALUES (?, 'material', ?, ?, 0, ?)").run(childId, rootId, "子目录", now + 1);
    db.query("INSERT INTO folders (id, kind, parent_id, name, sort, created_at) VALUES (?, 'material', NULL, ?, 1, ?)").run(siblingId, "并列目录", now + 2);
    db.query("INSERT INTO materials (id, name, status, source, folder_id, metadata, created_at) VALUES (?, '子目录素材', 'raw', 'upload', ?, '{}', ?)").run(materialInChild, childId, now);
    db.query("INSERT INTO materials (id, name, status, source, folder_id, metadata, created_at) VALUES (?, '并列素材', 'raw', 'upload', ?, '{}', ?)").run(materialInSibling, siblingId, now + 1);
    try {
      const response = await app.handle(new Request("http://localhost/api/folders/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "material", ids: [rootId, childId, siblingId] }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, deleted: 3 });
      expect(db.query("SELECT id FROM folders WHERE id IN (?, ?, ?)").all(rootId, childId, siblingId)).toHaveLength(0);
      expect(db.query("SELECT id, folder_id FROM materials WHERE id = ?").get(materialInChild)).toMatchObject({ id: materialInChild, folder_id: null });
      expect(db.query("SELECT id, folder_id FROM materials WHERE id = ?").get(materialInSibling)).toMatchObject({ id: materialInSibling, folder_id: null });
    } finally {
      db.query("DELETE FROM materials WHERE id IN (?, ?)").run(materialInChild, materialInSibling);
      db.query("DELETE FROM folders WHERE id IN (?, ?, ?)").run(rootId, childId, siblingId);
    }
  });
});

describe("SQLite 实体转换", () => {
  test("素材按扩展名推断媒体类型，并优先使用原始路径", () => {
    expect(serializeMaterial({
      id: "video", name: "视频", raw_path: "/tmp/demo.MP4", processed_path: "/tmp/demo.png", status: "raw", source: "upload", folder_id: null, metadata: "{}", created_at: 1,
    }).kind).toBe("video");
    expect(serializeMaterial({
      id: "image", name: "图片", raw_path: null, processed_path: "/tmp/matted.png", status: "matted", source: "upload", folder_id: null, metadata: '{"ok":true}', created_at: 1,
    })).toMatchObject({ kind: "image", metadata: { ok: true } });
  });

});
