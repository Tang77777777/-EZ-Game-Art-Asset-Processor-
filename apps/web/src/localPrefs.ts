/**
 * 本地偏好键集中处。
 *
 * 语言与主题的权威值在服务端 settings 表，这里只保存首屏免闪烁和界面布局偏好。
 * `apps/web/index.html` 的首屏内联脚本无法 import，改动键名时必须同步更新它。
 */
const PREFIX = "ezgameart-";

export const THEME_KEY = `${PREFIX}theme`;
export const LANG_KEY = `${PREFIX}lang`;
export const JOBPANEL_POS_KEY = `${PREFIX}jobpanel-pos`;
export const FILE_ZOOM_KEY = `${PREFIX}file-zoom`;

/** localStorage 不可用时返回 null，交给调用方使用默认值。 */
export function readLocalPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // 隐私模式等禁用 localStorage 的场景：交给调用方走默认值
    return null;
  }
}
