import { describe, expect, test } from "bun:test";
import { atlasCellOrigin, resolveAtlasLayout, spriteSheetLayout } from "../apps/web/src/spritePack";

describe("图集布局优先级", () => {
  test("显式列与行直接采用", () => {
    expect(resolveAtlasLayout(64, 64, 10, { columns: 5, rows: 2 })).toEqual({
      columns: 5,
      rows: 2,
      width: 320,
      height: 128,
    });
  });

  test("只给列数时行数由帧数推导", () => {
    expect(resolveAtlasLayout(64, 64, 10, { columns: 4 })).toEqual({
      columns: 4,
      rows: 3,
      width: 256,
      height: 192,
    });
  });

  test("只给行数时列数由帧数推导", () => {
    expect(resolveAtlasLayout(64, 64, 10, { rows: 4 })).toEqual({
      columns: 3,
      rows: 4,
      width: 192,
      height: 256,
    });
  });

  test("无约束时回退到自动布局，与历史签名结果一致", () => {
    expect(resolveAtlasLayout(64, 64, 10)).toEqual(spriteSheetLayout(64, 64, 10));
  });

  test("独立宽度上限会压缩列数", () => {
    expect(resolveAtlasLayout(64, 64, 10, { maxWidth: 130 })).toEqual({
      columns: 2,
      rows: 5,
      width: 128,
      height: 320,
    });
  });
});

describe("图集间距", () => {
  test("spacing 只作用于格间，不产生外边距", () => {
    expect(resolveAtlasLayout(64, 64, 4, { columns: 2, rows: 2, spacing: 4 })).toEqual({
      columns: 2,
      rows: 2,
      width: 132,
      height: 132,
    });
  });

  test("自动布局同样计入 spacing", () => {
    expect(resolveAtlasLayout(64, 64, 4, { spacing: 4 })).toEqual({
      columns: 2,
      rows: 2,
      width: 132,
      height: 132,
    });
  });

  test("单元格原点按 cell + spacing 步进", () => {
    expect(atlasCellOrigin(0, 2, 64, 64, 4)).toEqual({ x: 0, y: 0 });
    expect(atlasCellOrigin(1, 2, 64, 64, 4)).toEqual({ x: 68, y: 0 });
    expect(atlasCellOrigin(2, 2, 64, 64, 4)).toEqual({ x: 0, y: 68 });
    expect(atlasCellOrigin(3, 2, 64, 64, 4)).toEqual({ x: 68, y: 68 });
  });

  test("spacing 为 0 时原点退化为紧密排列", () => {
    expect(atlasCellOrigin(3, 2, 64, 64)).toEqual({ x: 64, y: 64 });
  });
});

describe("图集布局越界", () => {
  test("显式列数导致超宽时建议改用序列导出", () => {
    expect(() => resolveAtlasLayout(4096, 64, 8, { columns: 5 })).toThrow("帧尺寸与数量超过精灵图画布上限");
  });

  test("恰好贴到上限可以通过，spacing 多出一像素即越界", () => {
    expect(resolveAtlasLayout(8192, 64, 2, { columns: 2 })).toEqual({
      columns: 2,
      rows: 1,
      width: 16384,
      height: 64,
    });
    expect(() => resolveAtlasLayout(8192, 64, 2, { columns: 2, spacing: 1 })).toThrow("帧尺寸与数量超过精灵图画布上限");
  });

  test("显式行列容量不足时报出具体数字", () => {
    expect(() => resolveAtlasLayout(64, 64, 10, { columns: 3, rows: 3 })).toThrow("3 列 × 3 行放不下 10 帧");
  });

  test("单帧尺寸超上限时不尝试布局", () => {
    expect(() => resolveAtlasLayout(20000, 64, 1)).toThrow("单帧尺寸超过精灵图画布上限");
  });
});

describe("图集布局参数校验", () => {
  test("帧数必须是正整数", () => {
    expect(() => resolveAtlasLayout(64, 64, 0)).toThrow("帧数必须是正整数");
    expect(() => resolveAtlasLayout(64, 64, 2.5)).toThrow("帧数必须是正整数");
  });

  test("间距必须是非负整数", () => {
    expect(() => resolveAtlasLayout(64, 64, 4, { spacing: -1 })).toThrow("间距必须是非负整数");
  });

  test("显式列数与行数必须是正整数", () => {
    expect(() => resolveAtlasLayout(64, 64, 4, { columns: 0 })).toThrow("列数必须是正整数");
    expect(() => resolveAtlasLayout(64, 64, 4, { columns: 2.5 })).toThrow("列数必须是正整数");
    expect(() => resolveAtlasLayout(64, 64, 4, { rows: 0 })).toThrow("行数必须是正整数");
  });
});
