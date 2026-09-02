import { beforeEach, describe, expect, test } from "bun:test";

/** 本地偏好键统一使用产品自己的命名空间。 */
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
};

const { FILE_ZOOM_KEY, JOBPANEL_POS_KEY, LANG_KEY, THEME_KEY, readLocalPref } = await import(
  "../apps/web/src/localPrefs"
);

beforeEach(() => store.clear());

describe("本地偏好键", () => {
  test("键名统一为 ezgameart- 前缀", () => {
    expect([THEME_KEY, LANG_KEY, JOBPANEL_POS_KEY, FILE_ZOOM_KEY]).toEqual([
      "ezgameart-theme",
      "ezgameart-lang",
      "ezgameart-jobpanel-pos",
      "ezgameart-file-zoom",
    ]);
  });

  test("读取当前产品键保存的值", () => {
    store.set(THEME_KEY, "light");
    expect(readLocalPref(THEME_KEY)).toBe("light");
  });

  test("键缺失时返回 null 交给调用方走默认值", () => {
    expect(readLocalPref(FILE_ZOOM_KEY)).toBeNull();
  });
});
