import { afterEach, describe, expect, test } from "bun:test";
import { packSprites, type SpriteCell } from "../apps/web/src/spritePack";

// packSprites 依赖 canvas，这里用最小桩替代，验证的是它的行为契约：
// 条目名与顺序、meta 字段、origin 传递、布局分支，而不是像素输出。

interface StubCanvas {
  width: number;
  height: number;
  ops: string[];
  getContext(kind: string, opts?: unknown): unknown;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
}

function installCanvasStub(): StubCanvas[] {
  const created: StubCanvas[] = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement(tag: string): StubCanvas {
      if (tag !== "canvas") throw new Error(`意外的元素: ${tag}`);
      const canvas: StubCanvas = {
        width: 0,
        height: 0,
        ops: [],
        getContext() {
          return {
            imageSmoothingEnabled: true,
            globalAlpha: 1,
            globalCompositeOperation: "source-over",
            save() {},
            restore() {},
            rotate() {},
            scale() {},
            translate(x: number, y: number) {
              canvas.ops.push(`translate(${x},${y})`);
            },
            drawImage(_source: unknown, x?: number, y?: number) {
              canvas.ops.push(x === undefined ? "drawImage" : `blit(${x},${y})`);
            },
          };
        },
        toBlob(callback) {
          callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
        },
      };
      created.push(canvas);
      return canvas;
    },
  };
  return created;
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

/** 生成一个占据 16×16、局部原点偏移 (10,4) 的单元格 */
function cell(duration = 1, trace?: Record<string, string[]>): SpriteCell {
  return {
    bounds: [{ left: -10, right: 6, top: -4, bottom: 12 }],
    duration,
    ...(trace ? { trace } : {}),
    draw: (ctx, origin) => {
      ctx.translate(origin.x, origin.y);
      ctx.drawImage({} as CanvasImageSource, undefined as unknown as number, undefined as unknown as number);
    },
  };
}

describe("packSprites 序列模式", () => {
  test("每格一个 PNG，末尾追加 frames.json", async () => {
    installCanvasStub();
    const { entries, meta } = await packSprites([cell(), cell(), cell()], {
      name: "走路",
      format: "sequence",
      fps: 8,
    });
    expect(entries.map((e) => e.name)).toEqual([
      "走路_00.png",
      "走路_01.png",
      "走路_02.png",
      "走路.frames.json",
    ]);
    expect(meta.meta.format).toBe("sequence");
    expect(meta.meta.count).toBe(3);
    expect(meta.frames.map((f) => f.file)).toEqual(["走路_00.png", "走路_01.png", "走路_02.png"]);
    expect(meta.frames.every((f) => f.x === 0 && f.y === 0)).toBe(true);
  });

  test("统一包围盒强制纳入原点，origin 传给 draw", async () => {
    const canvases = installCanvasStub();
    const { meta } = await packSprites([cell()], { name: "a", format: "sequence", fps: 8 });
    // bounds 左 -10 上 -4 → origin = (10, 4)；内容 16×16
    expect(meta.meta.cellWidth).toBe(16);
    expect(meta.meta.cellHeight).toBe(16);
    expect(meta.meta.originX).toBe(10);
    expect(meta.meta.originY).toBe(4);
    expect(meta.frames[0]!.pivot).toEqual({ x: 10, y: 4 });
    expect(canvases[0]!.ops).toContain("translate(10,4)");
  });

  test("帧序号位宽随帧数增长，且受 startIndex 影响", async () => {
    installCanvasStub();
    const many = Array.from({ length: 10 }, () => cell());
    const a = await packSprites(many, { name: "a", format: "sequence", fps: 8 });
    expect(a.entries[0]!.name).toBe("a_00.png");
    expect(a.entries[9]!.name).toBe("a_09.png");

    // 位宽按最大序号 104 计算，沿用历史实现「多留一位」的约定
    installCanvasStub();
    const b = await packSprites(many, { name: "a", format: "sequence", fps: 8, startIndex: 95 });
    expect(b.entries[0]!.name).toBe("a_0095.png");
    expect(b.entries[9]!.name).toBe("a_0104.png");
  });

  test("filePrefix 只改帧文件名，不改 JSON 与图集名", async () => {
    installCanvasStub();
    const { entries } = await packSprites([cell()], {
      name: "走路",
      format: "sequence",
      fps: 8,
      filePrefix: "walk",
    });
    expect(entries.map((e) => e.name)).toEqual(["walk_00.png", "走路.frames.json"]);
  });

  test("totalDuration 求和，trace 原样写入", async () => {
    installCanvasStub();
    const { meta } = await packSprites([cell(2, { frameIds: ["f1"], effectIds: [] }), cell(3)], {
      name: "a",
      format: "sequence",
      fps: 8,
    });
    expect(meta.meta.totalDuration).toBe(5);
    expect(meta.frames[0]!.trace).toEqual({ frameIds: ["f1"], effectIds: [] });
    expect(meta.frames[1]!.trace).toBeUndefined();
  });
});

describe("packSprites 图集模式", () => {
  test("只产出一张大图，帧矩形按布局排布", async () => {
    installCanvasStub();
    const { entries, meta } = await packSprites([cell(), cell(), cell(), cell()], {
      name: "走路",
      format: "spritesheet",
      fps: 8,
    });
    expect(entries.map((e) => e.name)).toEqual(["走路.png", "走路.frames.json"]);
    expect(meta.meta.columns).toBe(2);
    expect(meta.meta.rows).toBe(2);
    expect(meta.meta.imageWidth).toBe(32);
    expect(meta.meta.imageHeight).toBe(32);
    expect(meta.frames.map((f) => `${f.x},${f.y}`)).toEqual(["0,0", "16,0", "0,16", "16,16"]);
    expect(meta.frames.every((f) => f.file === "走路.png")).toBe(true);
  });

  test("spacing 计入帧矩形与画布尺寸，且写入 meta", async () => {
    installCanvasStub();
    const { meta } = await packSprites([cell(), cell()], {
      name: "a",
      format: "spritesheet",
      fps: 8,
      columns: 2,
      spacing: 4,
    });
    expect(meta.meta.spacing).toBe(4);
    expect(meta.meta.imageWidth).toBe(36);
    expect(meta.frames.map((f) => f.x)).toEqual([0, 20]);
  });

  test("spacing 为 0 时不写入 meta", async () => {
    installCanvasStub();
    const { meta } = await packSprites([cell()], { name: "a", format: "spritesheet", fps: 8 });
    expect(meta.meta.spacing).toBeUndefined();
  });

  test("extraMeta 合并进 meta", async () => {
    installCanvasStub();
    const { meta } = await packSprites([cell()], {
      name: "a",
      format: "spritesheet",
      fps: 8,
      extraMeta: { axisId: "ax1", axisName: "Default" },
    });
    expect(meta.meta.axisId).toBe("ax1");
    expect(meta.meta.axisName).toBe("Default");
  });
});

describe("packSprites 边界", () => {
  test("没有单元格时报错", async () => {
    installCanvasStub();
    await expect(packSprites([], { name: "a", format: "sequence", fps: 8 })).rejects.toThrow("没有可导出的帧");
  });

  test("显式单帧尺寸小于内容时报错，不静默裁切", async () => {
    installCanvasStub();
    await expect(
      packSprites([cell()], { name: "a", format: "sequence", fps: 8, cellWidth: 8, cellHeight: 8 })
    ).rejects.toThrow("小于内容尺寸 16×16");
  });

  test("显式单帧尺寸大于内容时按显式值出图", async () => {
    installCanvasStub();
    const { meta } = await packSprites([cell()], {
      name: "a",
      format: "sequence",
      fps: 8,
      cellWidth: 32,
      cellHeight: 24,
    });
    expect(meta.meta.cellWidth).toBe(32);
    expect(meta.meta.cellHeight).toBe(24);
    expect(meta.frames[0]!.w).toBe(32);
    expect(meta.frames[0]!.h).toBe(24);
  });

  test("空格（无 bounds）也占一格，尺寸退化为 1×1", async () => {
    installCanvasStub();
    const blank: SpriteCell = { bounds: [], duration: 1, draw: () => {} };
    const { meta } = await packSprites([blank], { name: "a", format: "sequence", fps: 8 });
    expect(meta.meta.cellWidth).toBe(1);
    expect(meta.meta.cellHeight).toBe(1);
  });
});
