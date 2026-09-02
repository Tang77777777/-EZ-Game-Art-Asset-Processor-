import { useEffect, useState } from "react";
import type { ServerConfig } from "@ezgameart/shared";
import { api } from "./api";

// GET /api/config 的前端缓存：会话级缓存 + 订阅通知
// 设置页保存 provider/抠图配置后调 refreshServerConfig() 让所有 useServerConfig 处即时刷新
let cache: ServerConfig | null = null;
let inflight: Promise<ServerConfig | null> | null = null;
const listeners = new Set<(c: ServerConfig) => void>();

async function fetchConfig(): Promise<ServerConfig | null> {
  try {
    const raw = await api.getConfig();
    // 配置接口跨版本兼容：旧数据或热更新期间缺少模型数组时统一归一为空数组，避免 UI 直接读 .length 崩溃。
    const cfg: ServerConfig = {
      ...raw,
      gen: {
        providers: (raw.gen?.providers ?? []).map((provider) => ({
          ...provider,
          imageModels: Array.isArray(provider.imageModels) ? provider.imageModels : [],
          videoModels: Array.isArray(provider.videoModels) ? provider.videoModels : [],
          textModels: Array.isArray(provider.textModels) ? provider.textModels : [],
        })),
      },
      promptEnhancers: Array.isArray(raw.promptEnhancers) ? raw.promptEnhancers : [],
    };
    cache = cfg;
    listeners.forEach((l) => l(cfg));
    return cfg;
  } catch (e) {
    console.error("获取服务端配置失败:", e);
    return null;
  }
}

/** 清缓存重拉 /api/config 并通知订阅者（设置保存后调用） */
export function refreshServerConfig(): Promise<ServerConfig | null> {
  cache = null;
  inflight = fetchConfig();
  return inflight;
}

/** 读取 GET /api/config（抠图引擎状态等），首次加载后缓存，refreshServerConfig 后自动更新 */
export function useServerConfig(): ServerConfig | null {
  const [cfg, setCfg] = useState<ServerConfig | null>(cache);
  useEffect(() => {
    if (!cache) {
      inflight ??= fetchConfig();
      inflight.then((c) => {
        if (c) setCfg(c);
      });
    }
    const l = (c: ServerConfig) => setCfg(c);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return cfg;
}
