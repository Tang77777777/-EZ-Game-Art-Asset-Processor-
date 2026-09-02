import type { WSMessage } from "@ezgameart/shared";

type Listener = (msg: WSMessage) => void;

/** 应用级实时事件连接；HTTP API 不应负责连接生命周期。 */
class WSClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as WSMessage;
        this.listeners.forEach((listener) => listener(msg));
      } catch {
        /* 忽略非法消息 */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.started) setTimeout(() => this.connect(), 3000);
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const wsClient = new WSClient();
