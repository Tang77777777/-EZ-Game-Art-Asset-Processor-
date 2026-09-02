import { describe, expect, test } from "bun:test";
import { buildFrameTimestamps, intervalEffectiveFps } from "../apps/web/src/videoFrames";

const EXTRACT_TIMESTAMPS_MAX = 64;

describe("buildFrameTimestamps", () => {
  test("按区间与 fps 生成并包含终点", () => {
    expect(buildFrameTimestamps({ start: 0, end: 0.5, fps: 4 })).toEqual([0, 0.25, 0.5]);
  });

  test("反向区间会自动规范化", () => {
    expect(buildFrameTimestamps({ start: 1, end: 0, fps: 2 })).toEqual([0, 0.5, 1]);
  });

  test("最大帧数会均匀保留首尾", () => {
    expect(buildFrameTimestamps({ start: 0, end: 1, fps: 8, maxFrames: 3 })).toEqual([0, 0.5, 1]);
  });

  test("输出永不超过服务端时间点上限", () => {
    const result = buildFrameTimestamps({ start: 0, end: 60, fps: 60, maxFrames: 999 });
    expect(result).toHaveLength(EXTRACT_TIMESTAMPS_MAX);
    expect(result[0]).toBe(0);
    expect(result.at(-1)).toBe(60);
  });

  test("缺省 mode 与显式 fps 模式结果一致（旧调用方不受影响）", () => {
    expect(buildFrameTimestamps({ start: 0, end: 0.5, fps: 4 })).toEqual(
      buildFrameTimestamps({ start: 0, end: 0.5, mode: "fps", fps: 4 })
    );
  });
});

describe("buildFrameTimestamps 间隔模式", () => {
  /**
   * 步长 = N / 原生帧率。24fps 每 4 帧取 1 → 步长 1/6 秒。
   * 这里写死期望值而不是用常量推导，避免实现改了测试跟着一起「自洽地错」。
   */
  test("每 N 帧取 1：步长为 N / 原生帧率", () => {
    const result = buildFrameTimestamps({ start: 0, end: 0.5, mode: "interval", fps: 8, interval: 4, sourceFps: 24 });
    expect(result).toEqual([0, 0.167, 0.333, 0.5]);
  });

  test("间隔模式忽略 fps 字段，只看 interval 与 sourceFps", () => {
    const a = buildFrameTimestamps({ start: 0, end: 1, mode: "interval", fps: 8, interval: 5, sourceFps: 30 });
    const b = buildFrameTimestamps({ start: 0, end: 1, mode: "interval", fps: 60, interval: 5, sourceFps: 30 });
    expect(a).toEqual(b);
    // 30fps 每 5 帧 → 6fps → 0 到 1 秒共 7 个点
    expect(a).toHaveLength(7);
  });

  test("interval=1 等于逐帧取，步长即原生帧间隔", () => {
    expect(buildFrameTimestamps({ start: 0, end: 0.2, mode: "interval", fps: 8, interval: 1, sourceFps: 25 })).toEqual([
      0, 0.04, 0.08, 0.12, 0.16, 0.2,
    ]);
  });

  test("原生帧率缺失时退到假定值 30fps", () => {
    const assumed = buildFrameTimestamps({ start: 0, end: 1, mode: "interval", fps: 8, interval: 3 });
    const explicit = buildFrameTimestamps({ start: 0, end: 1, mode: "interval", fps: 8, interval: 3, sourceFps: 30 });
    expect(assumed).toEqual(explicit);
  });

  test("最大帧数在间隔模式同样封顶", () => {
    const result = buildFrameTimestamps({
      start: 0,
      end: 10,
      mode: "interval",
      fps: 8,
      interval: 1,
      sourceFps: 30,
      maxFrames: 5,
    });
    expect(result).toHaveLength(5);
    expect(result[0]).toBe(0);
    expect(result.at(-1)).toBe(10);
  });

  test("非法 interval 被夹到合法范围", () => {
    const zero = buildFrameTimestamps({ start: 0, end: 0.2, mode: "interval", fps: 8, interval: 0, sourceFps: 25 });
    const one = buildFrameTimestamps({ start: 0, end: 0.2, mode: "interval", fps: 8, interval: 1, sourceFps: 25 });
    expect(zero).toEqual(one);
  });
});

describe("intervalEffectiveFps", () => {
  test("等效帧率 = 原生帧率 / N", () => {
    expect(intervalEffectiveFps(4, 24)).toBe(6);
    expect(intervalEffectiveFps(1, 25)).toBe(25);
    expect(intervalEffectiveFps(5, 30)).toBe(6);
  });

  test("原生帧率非法时用假定值 30", () => {
    expect(intervalEffectiveFps(3, 0)).toBe(10);
    expect(intervalEffectiveFps(3, Number.NaN)).toBe(10);
  });
});
