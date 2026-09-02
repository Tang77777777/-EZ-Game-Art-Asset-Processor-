/** 图片变换的四个几何量；与素材实体解耦，本模块是几何真源。 */
export interface FrameTransform {
  offset_x: number;
  offset_y: number;
  rotation: number;
  scale: number;
}

export interface FrameBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface ImageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 图片以中心为锚点，依次应用 offset、弧度旋转和等比缩放后的轴对齐包围盒。
 * opacity 只影响合成，不改变几何范围，由各渲染适配层应用。
 */
export function transformedFrameBounds(width: number, height: number, frame: FrameTransform): FrameBounds {
  const scale = Math.abs(frame.scale);
  const cos = Math.abs(Math.cos(frame.rotation));
  const sin = Math.abs(Math.sin(frame.rotation));
  const halfW = (width * scale * cos + height * scale * sin) / 2;
  const halfH = (width * scale * sin + height * scale * cos) / 2;
  return {
    left: frame.offset_x - halfW,
    right: frame.offset_x + halfW,
    top: frame.offset_y - halfH,
    bottom: frame.offset_y + halfH,
  };
}

/** 图片局部矩形按“图片中心锚点 → 平移 → 旋转 → 缩放”转换后的轴对齐范围。 */
export function transformedFrameRectBounds(width: number, height: number, rect: ImageRect, frame: FrameTransform): FrameBounds {
  const cos = Math.cos(frame.rotation);
  const sin = Math.sin(frame.rotation);
  const corners = [
    [rect.x - width / 2, rect.y - height / 2],
    [rect.x + rect.w - width / 2, rect.y - height / 2],
    [rect.x + rect.w - width / 2, rect.y + rect.h - height / 2],
    [rect.x - width / 2, rect.y + rect.h - height / 2],
  ].map(([x, y]) => ({
    x: frame.offset_x + (x! * cos - y! * sin) * frame.scale,
    y: frame.offset_y + (x! * sin + y! * cos) * frame.scale,
  }));
  return {
    left: Math.min(...corners.map((point) => point.x)),
    right: Math.max(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

/** 以画布原点为中心完整容纳包围盒，默认保留 10% 边距，且永不放大。 */
export function fitScaleForBounds(bounds: FrameBounds, viewportWidth: number, viewportHeight: number, margin = 0.9): number {
  const halfW = Math.max(Math.abs(bounds.left), Math.abs(bounds.right));
  const halfH = Math.max(Math.abs(bounds.top), Math.abs(bounds.bottom));
  if (halfW === 0 || halfH === 0) return 1;
  return Math.min(1, (viewportWidth * margin) / (2 * halfW), (viewportHeight * margin) / (2 * halfH));
}

/** 将弧度归一化到 [-π, π]，并抑制步进累积产生的浮点尾差。 */
export function normalizeFrameRotation(value: number): number {
  const turn = Math.PI * 2;
  const normalized = ((((value + Math.PI) % turn) + turn) % turn) - Math.PI;
  return Math.min(Math.PI, Math.max(-Math.PI, Math.round(normalized * 1_000_000) / 1_000_000));
}
