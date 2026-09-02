import { serve } from "bun";
import index from "../../web/index.html";
import { app } from "./app";
import { wsHandlers } from "./ws";

const port = Number(process.env.PORT ?? 3000);

serve({
  port,
  routes: {
    "/": index, // 流水线首页
    "/materials": index, // 素材库页同
    "/settings": index, // 设置页同
  },
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined;
      return new Response("WebSocket 升级失败", { status: 400 });
    }
    return app.handle(req);
  },
  websocket: wsHandlers,
  development: process.env.NODE_ENV !== "production",
});

console.log(`EZ Game Art Asset Processor → http://localhost:${port}`);
