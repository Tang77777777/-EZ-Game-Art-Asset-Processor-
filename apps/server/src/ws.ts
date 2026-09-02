import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { WSEventType } from "@ezgameart/shared";

// 已连接的 WS 客户端集合
const clients = new Set<ServerWebSocket<undefined>>();

export const wsHandlers: WebSocketHandler<undefined> = {
  open(ws) {
    clients.add(ws);
  },
  message(_ws, _msg) {
    // 当前服务端不接收客户端消息，仅做广播
  },
  close(ws) {
    clients.delete(ws);
  },
};

/** 向所有客户端广播 JSON 消息 { type, payload } */
export function broadcast(type: WSEventType, payload?: unknown) {
  const data = JSON.stringify({ type, payload });
  for (const ws of clients) {
    try {
      ws.send(data);
    } catch {
      clients.delete(ws);
    }
  }
}
