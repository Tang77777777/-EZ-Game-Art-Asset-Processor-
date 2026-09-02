import { describe, expect, test } from "bun:test";
import { spriteSheetLayout } from "../apps/web/src/spritePack";

describe("精灵图自动换行", () => {
  test("宽度超限时按行优先自动换行", () => {
    expect(spriteSheetLayout(1280, 720, 27)).toEqual({
      columns: 4,
      rows: 7,
      width: 5120,
      height: 5040,
    });
  });

  test("帧数不多时也生成紧凑的规则网格", () => {
    expect(spriteSheetLayout(64, 64, 10)).toEqual({
      columns: 3,
      rows: 4,
      width: 192,
      height: 256,
    });
  });

  test("单帧或换行后高度仍超限时给出序列导出建议", () => {
    expect(() => spriteSheetLayout(20000, 64, 1)).toThrow("单帧尺寸超过精灵图画布上限");
    expect(() => spriteSheetLayout(9000, 9000, 3)).toThrow("帧尺寸与数量超过精灵图画布上限");
  });
});
