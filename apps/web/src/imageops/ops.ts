// 环境无关的图像纯计算：worker 与主线程降级路径共用

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EditPoint {
  x: number;
  y: number;
}

export interface EraseStroke {
  size: number;
  points: EditPoint[];

}

/** worker 消息协议（Blob 走 structured clone，无需手动 transfer） */
/** 连通域自动检测参数（阅读顺序返回不透明部件包围盒）。 */
export interface DetectComponentsOptions {
  alphaThreshold?: number;
  /** 面积下限占总不透明像素比例（滤除碎屑）。 */
  minAreaRatio?: number;
  /** 面积绝对下限像素。 */
  minAreaPixels?: number;
  /** 保留最大的前 N 个部件。 */
  maxComponents?: number;
}

/** 纯色背景移除参数；v1 只处理硬阈值，不做羽化或碎屑清理。 */
export interface ColorKeyOptions {
  color: { r: number; g: number; b: number };
  /** 容差 0–255，按 RGB 三分量最大差（Chebyshev 距离）判定；默认 24。 */
  tolerance?: number;
  /** alpha 不高于此值的像素跳过；默认 0。 */
  alphaThreshold?: number;
}

/** 纯色移除的缺省容差；UI 与算法共用同一个值，避免两处各写字面量。 */
export const DEFAULT_COLOR_KEY_TOLERANCE = 24;

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export interface ImageOpRequest {
  id: number;

  op: "bounds" | "crop" | "edit" | "components" | "colorkey" | "bgcolor";

  blob: Blob;
  rect?: CropRect;
  strokes?: EraseStroke[];
  quarterTurns?: number;
  flipHorizontal?: boolean;
  componentOptions?: DetectComponentsOptions;
  colorKeyOptions?: ColorKeyOptions;
}

export interface ImageOpResponse {
  id: number;
  ok: boolean;
  rect?: CropRect | null;
  rects?: CropRect[];
  blob?: Blob;
  /** bgcolor 的返回载荷；无可用边框像素时为 null */
  color?: RgbColor | null;
  error?: string;
}

/** 扫描 alpha>0 像素的最小包围盒（像素图「裁透明边」）；全透明返回 null */
export function computeOpaqueBounds(data: Uint8ClampedArray, width: number, height: number, alphaThreshold = 0): CropRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > alphaThreshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const DEFAULT_ALPHA_THRESHOLD = 8;

/**
 * 连通域自动检测：4 连通洪泛扫描 alpha>阈值 的不透明块，返回按阅读顺序
 * （上到下分行带、行内左到右）排列的显著部件包围盒。用于精灵图按部件而非
 * 均匀网格切分，避免切穿部件。碎屑按面积阈值滤除。
 */
export function detectOpaqueComponents(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: DetectComponentsOptions = {},
): CropRect[] {
  const alphaThreshold = options.alphaThreshold ?? DEFAULT_ALPHA_THRESHOLD;
  const total = width * height;
  if (total <= 0) return [];
  const foreground = (index: number) => data[index * 4 + 3] > alphaThreshold;
  let opaquePixels = 0;
  for (let i = 0; i < total; i++) if (foreground(i)) opaquePixels++;
  if (opaquePixels === 0) return [];

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const components: Array<{ rect: CropRect; area: number }> = [];
  for (let start = 0; start < total; start++) {
    if (visited[start] || !foreground(start)) continue;
    let read = 0;
    let write = 0;
    let area = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    visited[start] = 1;
    queue[write++] = start;
    while (read < write) {
      const index = queue[read++];
      area++;
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const visit = (next: number) => {
        if (!visited[next] && foreground(next)) {
          visited[next] = 1;
          queue[write++] = next;
        }
      };
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (y > 0) visit(index - width);
      if (y + 1 < height) visit(index + width);
    }
    components.push({ area, rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
  }

  const minArea = Math.max(options.minAreaPixels ?? 16, Math.ceil(opaquePixels * (options.minAreaRatio ?? 0.005)));
  let significant = components.filter((component) => component.area >= minArea);
  if (!significant.length) significant = [components.reduce((largest, current) => (current.area > largest.area ? current : largest))];
  if (options.maxComponents && significant.length > options.maxComponents) {
    significant = [...significant].sort((a, b) => b.area - a.area).slice(0, options.maxComponents);
  }

  // 阅读顺序：中位高度的行带聚合，行带内按中心 x 排序。
  const sortedHeights = significant.map((component) => component.rect.h).sort((a, b) => a - b);
  const medianHeight = sortedHeights.length ? sortedHeights[Math.floor(sortedHeights.length / 2)] : 1;
  const band = Math.max(1, medianHeight * 0.6);
  return significant
    .map((component) => ({ rect: component.rect, cx: component.rect.x + component.rect.w / 2, cy: component.rect.y + component.rect.h / 2 }))
    .sort((a, b) => (Math.floor(a.cy / band) - Math.floor(b.cy / band)) || (a.cx - b.cx))
    .map((entry) => entry.rect);
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(Number.isFinite(value) ? value : 0)));
}

/** 原地移除接近目标色的像素，保留 RGB，只将命中像素 alpha 置为 0。 */
export function applyColorKey(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: ColorKeyOptions,
): void {
  const target = {
    r: clampByte(options.color.r),
    g: clampByte(options.color.g),
    b: clampByte(options.color.b),
  };
  const tolerance = Math.min(255, Math.max(0, Math.round(options.tolerance ?? DEFAULT_COLOR_KEY_TOLERANCE)));
  const alphaThreshold = Math.min(255, Math.max(0, Math.round(options.alphaThreshold ?? 0)));
  const total = Math.max(0, Math.min(width * height, Math.floor(data.length / 4)));

  for (let pixel = 0; pixel < total; pixel++) {
    const index = pixel * 4;
    if (data[index + 3]! <= alphaThreshold) continue;
    const distance = Math.max(
      Math.abs(data[index]! - target.r),
      Math.abs(data[index + 1]! - target.g),
      Math.abs(data[index + 2]! - target.b),
    );
    if (distance <= tolerance) data[index + 3] = 0;
  }
}

/**
 * 取四边不透明像素的精确 RGB 众数；没有可用边框像素时返回 null。
 * 键用 (r<<16)|(g<<8)|b 打包成整数，避免逐像素分配字符串。
 */
export function guessBackgroundColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): RgbColor | null {
  if (width <= 0 || height <= 0) return null;
  const counts = new Map<number, number>();
  const sample = (x: number, y: number) => {
    const index = (y * width + x) * 4;
    if (index < 0 || index + 3 >= data.length || data[index + 3]! <= 0) return;
    const key = (data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) {
    sample(x, 0);
    if (height > 1) sample(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    sample(0, y);
    if (width > 1) sample(width - 1, y);
  }
  let bestKey = -1;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestKey = key;
      bestCount = count;
    }
  }
  if (bestKey < 0) return null;
  return { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff };
}
