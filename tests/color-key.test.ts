import { describe, expect, test } from "bun:test";
import { applyColorKey, DEFAULT_COLOR_KEY_TOLERANCE, guessBackgroundColor } from "../apps/web/src/imageops/ops";

describe("纯色移除", () => {
  test("按 RGB 三分量最大差移除命中像素", () => {
    const data = new Uint8ClampedArray([
      10, 20, 30, 255,
      12, 18, 31, 255,
      30, 20, 10, 255,
      10, 20, 30, 0,
    ]);
    applyColorKey(data, 2, 2, { color: { r: 10, g: 20, b: 30 }, tolerance: 2 });
    expect([...data]).toEqual([
      10, 20, 30, 0,
      12, 18, 31, 0,
      30, 20, 10, 255,
      10, 20, 30, 0,
    ]);
  });

  test("alpha 阈值以内的像素不重复处理", () => {
    const data = new Uint8ClampedArray([10, 20, 30, 8, 10, 20, 30, 9]);
    applyColorKey(data, 2, 1, { color: { r: 10, g: 20, b: 30 }, tolerance: 0, alphaThreshold: 8 });
    expect([...data]).toEqual([10, 20, 30, 8, 10, 20, 30, 0]);
  });

  // 下面两条刻意写死 24：期望值不能从 DEFAULT_COLOR_KEY_TOLERANCE 推导，
  // 否则常量一改期望跟着改，成了同义反复，改动就捕捉不到。
  test("缺省容差常量固定为 24", () => {
    expect(DEFAULT_COLOR_KEY_TOLERANCE).toBe(24);
  });

  test("不传容差时按 24 判定：距离 24 命中，25 保留", () => {
    const data = new Uint8ClampedArray([
      100, 100, 100, 255,
      124, 100, 100, 255,
      125, 100, 100, 255,
    ]);
    applyColorKey(data, 3, 1, { color: { r: 100, g: 100, b: 100 } });
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(0);
    expect(data[11]).toBe(255);
  });

  test("容差超出 0–255 时被限制到合法范围", () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
    applyColorKey(data, 2, 1, { color: { r: 250, g: 250, b: 250 }, tolerance: 999 });
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(0);
  });

  test("从四边不透明像素取 RGB 众数", () => {
    const data = new Uint8ClampedArray([
      1, 2, 3, 255, 1, 2, 3, 255, 9, 9, 9, 255,
      1, 2, 3, 255, 8, 8, 8, 255, 1, 2, 3, 255,
      9, 9, 9, 255, 1, 2, 3, 255, 1, 2, 3, 255,
    ]);
    expect(guessBackgroundColor(data, 3, 3)).toEqual({ r: 1, g: 2, b: 3 });
  });

  test("全透明边框返回 null", () => {
    const data = new Uint8ClampedArray(4 * 3 * 3);
    expect(guessBackgroundColor(data, 3, 3)).toBeNull();
  });
});

describe("背景色猜测的取样范围", () => {
  test("只看边框，中心像素再多也不参与众数", () => {
    // 5×5：边框全为 (1,2,3)，中心 3×3 全为 (9,9,9)（9 个 > 边框任一色计数）
    const data = new Uint8ClampedArray(4 * 25);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const index = (y * 5 + x) * 4;
        const border = x === 0 || y === 0 || x === 4 || y === 4;
        data[index] = border ? 1 : 9;
        data[index + 1] = border ? 2 : 9;
        data[index + 2] = border ? 3 : 9;
        data[index + 3] = 255;
      }
    }
    expect(guessBackgroundColor(data, 5, 5)).toEqual({ r: 1, g: 2, b: 3 });
  });

  test("透明边框像素不计入，只统计不透明的", () => {
    const data = new Uint8ClampedArray([
      7, 7, 7, 0,
      5, 5, 5, 255,
      7, 7, 7, 0,
      7, 7, 7, 0,
    ]);
    expect(guessBackgroundColor(data, 2, 2)).toEqual({ r: 5, g: 5, b: 5 });
  });

  test("单行图片也能取到背景色", () => {
    const data = new Uint8ClampedArray([4, 4, 4, 255, 4, 4, 4, 255, 6, 6, 6, 255]);
    expect(guessBackgroundColor(data, 3, 1)).toEqual({ r: 4, g: 4, b: 4 });
  });

  test("尺寸非法时返回 null", () => {
    expect(guessBackgroundColor(new Uint8ClampedArray(4), 0, 1)).toBeNull();
    expect(guessBackgroundColor(new Uint8ClampedArray(4), 1, 0)).toBeNull();
  });
});
