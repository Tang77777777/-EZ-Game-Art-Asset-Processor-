import { describe, expect, test } from "bun:test";
import { fitScaleForBounds, normalizeFrameRotation, transformedFrameBounds, transformedFrameRectBounds } from "../apps/web/src/frameGeometry";

describe("帧变换几何", () => {
  test("按中心锚点计算平移后的包围盒", () => {
    expect(transformedFrameBounds(100, 50, { offset_x: 10, offset_y: -20, rotation: 0, scale: 1 })).toEqual({
      left: -40,
      right: 60,
      top: -45,
      bottom: 5,
    });
  });

  test("旋转、缩放与负 scale 都正确扩大包围盒", () => {
    const bounds = transformedFrameBounds(100, 50, {
      offset_x: 0,
      offset_y: 0,
      rotation: Math.PI / 2,
      scale: -2,
    });
    expect(bounds.left).toBeCloseTo(-50);
    expect(bounds.right).toBeCloseTo(50);
    expect(bounds.top).toBeCloseTo(-100);
    expect(bounds.bottom).toBeCloseTo(100);
  });

  test("透明图片只按不透明局部矩形计算变换范围", () => {
    expect(transformedFrameRectBounds(100, 80, { x: 40, y: 20, w: 20, h: 30 }, {
      offset_x: 10,
      offset_y: -5,
      scale: 2,
      rotation: 0,
    })).toEqual({ left: -10, right: 30, top: -45, bottom: 15 });
  });

  test("适应视口不会放大，且处理退化边界", () => {
    expect(fitScaleForBounds({ left: -100, right: 100, top: -50, bottom: 50 }, 1000, 1000)).toBe(1);
    expect(fitScaleForBounds({ left: -100, right: 100, top: -50, bottom: 50 }, 200, 100, 0.9)).toBeCloseTo(0.9);
    expect(fitScaleForBounds({ left: 0, right: 0, top: -20, bottom: 20 }, 100, 100)).toBe(1);
  });

  test("旋转归一化到闭区间并清理浮点尾差", () => {
    expect(normalizeFrameRotation(3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(normalizeFrameRotation(-3 * Math.PI)).toBeCloseTo(-Math.PI);
    expect(normalizeFrameRotation(Math.PI * 2 + 0.123456789)).toBe(0.123457);
    expect(normalizeFrameRotation(-0.123456789)).toBe(-0.123457);
  });
});
