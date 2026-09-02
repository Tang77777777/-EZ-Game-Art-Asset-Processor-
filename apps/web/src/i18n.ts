import { useEffect, useState } from "react";
import { api } from "./api";
import { en } from "./i18n/en";
import { zh, type MsgKey } from "./i18n/zh";
import { LANG_KEY } from "./localPrefs";

// ---- 界面语言：zh（默认）/ en ----
// 文案用稳定 key（如 common.close），查 zh.ts / en.ts；缺失回退 key 本身
// 插值：t("msg.delete_failed_msg", { msg })；未提供的 {占位符} 原样保留
// 持久化：localStorage（首屏）+ settings.lang（权威），顺序同 theme.ts

export type Lang = "zh" | "en";
export type { MsgKey };

export { LANG_KEY };

const DICTS: Record<Lang, Record<string, string>> = { zh, en };

const TITLES: Record<Lang, string> = {
  zh: "EZ 游戏美术素材加工器",
  en: "EZ Game Art Asset Processor",
};

const listeners = new Set<(l: Lang) => void>();

export function getLang(): Lang {
  return document.documentElement.lang === "en" ? "en" : "zh";
}

/** toLocaleString 用的 locale 串 */
export function getLocale(): string {
  return getLang() === "en" ? "en-US" : "zh-CN";
}

function applyLang(l: Lang, persist: boolean) {
  document.documentElement.lang = l === "en" ? "en" : "zh-CN";
  document.title = TITLES[l];
  if (persist) {
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((fn) => fn(l));
}

/** 切换语言；sync=true 时 PUT 服务端；sync=false 用于应用服务端值 */
function applyMode(l: Lang, sync: boolean) {
  applyLang(l, true);
  if (sync) {
    api.putSetting("lang", l).catch(() => {
      /* 静默降级 */
    });
  }
}

export function setLang(l: Lang) {
  if (l === getLang()) return;
  applyMode(l, true);
}

let serverLangLoaded = false;

/** 启动后拉服务端语言（权威值） */
export function initLangSync() {
  if (serverLangLoaded) return;
  serverLangLoaded = true;
  document.title = TITLES[getLang()];
  api
    .getSettings()
    .then((s) => {
      const v = s["lang"];
      if (v === "zh" || v === "en") {
        if (v !== getLang()) applyMode(v, false);
      }
    })
    .catch(() => {
      /* 静默降级 */
    });
}

export function onLangChange(l: (lang: Lang) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useLang(): Lang {
  const [l, setL] = useState<Lang>(getLang);
  useEffect(() => onLangChange(setL), []);
  return l;
}

function interp(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

/** 按 key 查当前语言文案，再做 {param} 插值 */
export function t(key: MsgKey | string, params?: Record<string, string | number>): string {
  const dict = DICTS[getLang()];
  return interp(dict[key] ?? key, params);
}

/** 订阅语言变化并返回 t */
export function useT() {
  useLang();
  return t;
}
