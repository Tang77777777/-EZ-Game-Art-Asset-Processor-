import { useEffect, useState } from "react";
import { api } from "./api";
import { THEME_KEY, readLocalPref } from "./localPrefs";

// ---- 主题管理：data-theme 挂在 <html> 上 ----
// 二态模式：深色（默认）/ 浅色
// 持久化双写：localStorage（首屏防闪烁即时缓存）+ 服务端 settings 表（权威，换浏览器/重启不丢）
// 加载顺序：index.html 内联脚本读 localStorage 定首屏 → initThemeSync() 拉服务端值覆盖
// 服务端不可达时静默降级为纯 localStorage 行为

export type Theme = "dark" | "light";
export type ThemeMode = Theme;

export { THEME_KEY };

const listeners = new Set<(t: Theme) => void>();

export function getThemeMode(): ThemeMode {
  const v = readLocalPref(THEME_KEY);
  if (v === "light" || v === "dark") return v;
  return "dark";
}

export function getTheme(): Theme {
  // 以 <html data-theme> 为准（首屏内联脚本已设置好）
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** 应用主题；persist=true 时写入 localStorage（= 用户手动选择，此后不再跟随系统） */
function applyTheme(t: Theme, persist: boolean) {
  document.documentElement.dataset.theme = t;
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      /* ignore */
    }
  }
  listeners.forEach((l) => l(t));
}

/** 应用主题模式；sync=true 时同时 PUT 服务端（用户主动切换） */
function applyMode(mode: ThemeMode, sync: boolean) {
  applyTheme(mode, true);
  if (sync) {
    api.putSetting("theme", mode).catch(() => {
      /* 静默降级：服务端不可达时仅本地 */
    });
  }
}

export function setThemeMode(mode: ThemeMode) {
  applyMode(mode, true);
}

/** 二态循环：深色 ↔ 浅色 */
export function cycleThemeMode() {
  const cur = getThemeMode();
  setThemeMode(cur === "dark" ? "light" : "dark");
}

let serverThemeLoaded = false;

/** 启动后拉服务端主题（权威值），与本地不同则覆盖并同步 localStorage 缓存；失败静默 */
export function initThemeSync() {
  if (serverThemeLoaded) return;
  serverThemeLoaded = true;
  api
    .getSettings()
    .then((s) => {
      const v = s["theme"];
      // 兼容旧版本曾保存的 system：新产品策略统一落到默认深色。
      const next = v === "light" || v === "dark" ? v : v === "system" ? "dark" : null;
      if (next && next !== getThemeMode()) applyMode(next, false);
    })
    .catch(() => {
      /* 静默降级 */
    });
}

export function onThemeChange(l: (t: Theme) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React hook：订阅当前解析后的主题 */
export function useTheme(): Theme {
  const [t, setT] = useState<Theme>(getTheme);
  useEffect(() => onThemeChange(setT), []);
  return t;
}

/** 从 CSS 变量读取画布相关颜色（data-theme 切换后同步生效）。传入元素时读取其作用域变量。 */
export function canvasColors(element?: Element | null): { bg: string; grid: string; cross: string } {
  const cs = getComputedStyle(element ?? document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--canvas-bg", "#0e1019"),
    grid: read("--border", "#2d3048"),
    cross: read("--purple", "#9b8cff"),
  };
}

/** 帧来源边框色：浅色主题下用 color-mix 加深以保持辨识度 */
export function themedSourceColor(color: string, theme: Theme): string {
  return theme === "light" ? `color-mix(in srgb, ${color} 62%, black)` : color;
}
