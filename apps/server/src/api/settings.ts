import { Elysia, t } from "elysia";
import { SETTING_KEYS } from "@ezgameart/shared";
import { db } from "../db";
import { broadcast } from "../ws";

// 界面偏好设置（布局/主题）：服务端 SQLite 持久化，换浏览器/重启不丢
export const settingsApi = new Elysia({ prefix: "/api" })
  // 返回整个 kv 对象（value 已 JSON 解析）
  .get("/settings", () => {
    const rows = db.query("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  })
  // 写入单个 key（白名单校验，JSON 存储）
  .put(
    "/settings/:key",
    ({ params, body, status }) => {
      if (!(SETTING_KEYS as readonly string[]).includes(params.key)) {
        return status(400, `非法设置项: ${params.key}（允许: ${SETTING_KEYS.join(", ")}）`);
      }
      db.query(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).run(params.key, JSON.stringify(body.value ?? null), Date.now());
      broadcast("settings_changed", { key: params.key });
      return { ok: true };
    },
    { body: t.Object({ value: t.Any() }) }
  );
