// 图集打包内核：与时间轴无关的数据契约与布局计算。
//
// 设计约束（改动前请先读 HANDOFF.md 的《解耦方案修订》一节）：
// 1. bounds 与 draw() 必须共享同一套世界坐标系。若先裁透明边，局部矩形
//    必须经 frameGeometry.transformedFrameRectBounds() 转换后再参与统一包围盒。
// 2. frameGeometry.ts 是唯一几何真源，本模块不自行推导变换。
// 3. spacing 只存在于格与格之间，不产生外边距；spacing = 0 时布局结果与
//    历史行为逐值一致（tests/export-layout.test.ts 依赖这一点）。

import type { FrameBounds } from "./frameGeometry";
import type { ZipEntry } from "./zip";

export type AtlasFormat = "sequence" | "spritesheet";

export const MAX_SPRITE_SHEET_DIMENSION = 16384;

/** 单元格内容的抽象：调用方只需描述「包围盒贡献」与「怎么画」。 */
export interface SpriteCell {
  /** 该格对统一包围盒的贡献，必须已转换到世界坐标；空数组 = 空格 */
  bounds: FrameBounds[];
  /** 在 cellWidth×cellHeight 画布上绘制；origin = { x: -minX, y: -minY } */
  draw(ctx: CanvasRenderingContext2D, origin: { x: number; y: number }): void;
  /** 单元格停留时长（毫秒） */
  duration: number;
  /** 谱系信息，原样写入 frames.json */
  trace?: Record<string, string[]>;
}

export interface SpriteSheetLayout {
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export interface AtlasLayoutConstraints {
  /** 显式列数；缺省由自动布局决定 */
  columns?: number;
  /** 显式行数；缺省由自动布局决定 */
  rows?: number;
  /** 格与格之间的像素间隔，不产生外边距；默认 0 */
  spacing?: number;
  /** 画布宽度上限；默认 MAX_SPRITE_SHEET_DIMENSION */
  maxWidth?: number;
  /** 画布高度上限；默认 MAX_SPRITE_SHEET_DIMENSION */
  maxHeight?: number;
}

export interface AtlasOptions extends AtlasLayoutConstraints {
  name: string;
  format: AtlasFormat;
  fps: number;
  /** 显式单帧尺寸；缺省用统一包围盒算出的尺寸。小于内容时报错，不静默裁切 */
  cellWidth?: number;
  cellHeight?: number;
  /** 帧文件名前缀；缺省用 name */
  filePrefix?: string;
  /** 帧序号起始值；默认 0 */
  startIndex?: number;
  /** 合并进 meta.meta 的额外字段 */
  extraMeta?: Record<string, unknown>;
}

export interface AtlasFrameMeta {
  file: string;
  /** 图集内像素矩形，已含 spacing 偏移 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 毫秒 */
  duration: number;
  /** 单元格内像素坐标，原点 = 单元格左上角；归一化坐标由调用方自行相除 */
  pivot: { x: number; y: number };
  trace?: Record<string, string[]>;
}

export interface AtlasMeta {
  frames: AtlasFrameMeta[];
  meta: {
    fps: number;
    count: number;
    format: AtlasFormat;
    cellWidth: number;
    cellHeight: number;
    /** 统一原点在单元格内的像素偏移 */
    originX: number;
    originY: number;
    /** 全部 duration 之和 */
    totalDuration: number;
    app: string;
    spacing?: number;
    columns?: number;
    rows?: number;
    imageWidth?: number;
    imageHeight?: number;
    [key: string]: unknown;
  };
}

export interface AtlasResult {
  entries: ZipEntry[];
  meta: AtlasMeta;
}

const OVERSIZE_CELL = "单帧尺寸超过精灵图画布上限，请改用 PNG 序列导出";
const OVERSIZE_SHEET = "帧尺寸与数量超过精灵图画布上限，请改用 PNG 序列导出";

/** 单元格左上角在图集内的像素坐标；spacing 只作用于格间。 */
export function atlasCellOrigin(index: number, columns: number, cellWidth: number, cellHeight: number, spacing = 0) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return { x: column * (cellWidth + spacing), y: row * (cellHeight + spacing) };
}

function sheetExtent(count: number, cell: number, spacing: number): number {
  return count * cell + Math.max(0, count - 1) * spacing;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label}必须是正整数`);
}

/**
 * 按四级优先级解析图集布局：
 *   1. columns 与 rows 都显式 → 直接采用（count 超出容量时报错）
 *   2. 只显式其中一维         → 另一维 = ceil(count / 已知维)
 *   3. 都不显式               → 自动布局，行优先、尽量接近正方形
 *   4. 以上任一结果超出 maxWidth / maxHeight → 报错并建议改用序列导出
 */
export function resolveAtlasLayout(
  cellWidth: number,
  cellHeight: number,
  count: number,
  constraints: AtlasLayoutConstraints = {},
): SpriteSheetLayout {
  if (!Number.isInteger(count) || count < 1) throw new Error("帧数必须是正整数");
  const spacing = constraints.spacing ?? 0;
  if (!Number.isInteger(spacing) || spacing < 0) throw new Error("间距必须是非负整数");
  const maxWidth = constraints.maxWidth ?? MAX_SPRITE_SHEET_DIMENSION;
  const maxHeight = constraints.maxHeight ?? MAX_SPRITE_SHEET_DIMENSION;
  if (cellWidth > maxWidth || cellHeight > maxHeight) throw new Error(OVERSIZE_CELL);

  const finish = (columns: number, rows: number): SpriteSheetLayout => {
    const width = sheetExtent(columns, cellWidth, spacing);
    const height = sheetExtent(rows, cellHeight, spacing);
    if (width > maxWidth || height > maxHeight) throw new Error(OVERSIZE_SHEET);
    return { columns, rows, width, height };
  };

  // 1 / 2：显式维度优先
  if (constraints.columns !== undefined || constraints.rows !== undefined) {
    if (constraints.columns !== undefined) assertPositiveInt(constraints.columns, "列数");
    if (constraints.rows !== undefined) assertPositiveInt(constraints.rows, "行数");
    if (constraints.columns !== undefined && constraints.rows !== undefined) {
      if (constraints.columns * constraints.rows < count) {
        throw new Error(`${constraints.columns} 列 × ${constraints.rows} 行放不下 ${count} 帧`);
      }
      return finish(constraints.columns, constraints.rows);
    }
    if (constraints.columns !== undefined) {
      return finish(constraints.columns, Math.ceil(count / constraints.columns));
    }
    return finish(Math.ceil(count / constraints.rows!), constraints.rows!);
  }

  // 3：自动布局。穷举列数，取 max(width, height) 最小的方案（尽量接近正方形）
  const maxColumns = Math.min(count, Math.floor((maxWidth + spacing) / (cellWidth + spacing)));
  const maxRows = Math.floor((maxHeight + spacing) / (cellHeight + spacing));
  if (maxColumns < 1 || maxRows < 1) throw new Error(OVERSIZE_SHEET);
  const minColumns = Math.max(1, Math.ceil(count / maxRows));
  if (minColumns > maxColumns) throw new Error(OVERSIZE_SHEET);

  let columns = minColumns;
  let bestScore = Infinity;
  for (let candidate = minColumns; candidate <= maxColumns; candidate++) {
    const candidateRows = Math.ceil(count / candidate);
    const score = Math.max(sheetExtent(candidate, cellWidth, spacing), sheetExtent(candidateRows, cellHeight, spacing));
    if (score < bestScore) {
      columns = candidate;
      bestScore = score;
    }
  }
  return finish(columns, Math.max(1, Math.ceil(count / columns)));
}

/**
 * 在浏览器安全画布尺寸内按播放顺序自动换行，采用行优先布局。
 * 保留历史签名与行为，等价于 resolveAtlasLayout 的无约束自动布局路径。
 */
export function spriteSheetLayout(
  cellWidth: number,
  cellHeight: number,
  count: number,
  maxDimension = MAX_SPRITE_SHEET_DIMENSION,
): SpriteSheetLayout {
  return resolveAtlasLayout(cellWidth, cellHeight, count, { maxWidth: maxDimension, maxHeight: maxDimension });
}

/** 写入 frames.json 的产品标识。 */
export const ATLAS_APP_NAME = "EZ Game Art Asset Processor";

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas 导出失败"))), "image/png"),
  );
}

/**
 * 把一组单元格合成为 PNG 序列或单张精灵图，并生成 frames.json。
 *
 * 不负责压缩与下载：返回的 entries 交给 zip.createZip，meta 可直接用于预览。
 * 统一包围盒强制纳入原点 (0,0)，保证所有格共享同一局部原点，播放时 offset
 * 与尺寸变化不会抖动——这一语义与历史导出行为一致，不要改。
 */
export async function packSprites(cells: SpriteCell[], opts: AtlasOptions): Promise<AtlasResult> {
  if (cells.length === 0) throw new Error("没有可导出的帧");
  const prefix = opts.filePrefix ?? opts.name;
  const startIndex = opts.startIndex ?? 0;
  const spacing = opts.spacing ?? 0;

  const bounds = cells.flatMap((cell) => cell.bounds);
  const minX = Math.floor(Math.min(0, ...bounds.map((b) => b.left)));
  const maxX = Math.ceil(Math.max(0, ...bounds.map((b) => b.right)));
  const minY = Math.floor(Math.min(0, ...bounds.map((b) => b.top)));
  const maxY = Math.ceil(Math.max(0, ...bounds.map((b) => b.bottom)));
  const contentWidth = Math.max(1, maxX - minX);
  const contentHeight = Math.max(1, maxY - minY);

  const cellWidth = opts.cellWidth ?? contentWidth;
  const cellHeight = opts.cellHeight ?? contentHeight;
  if (cellWidth < contentWidth || cellHeight < contentHeight) {
    throw new Error(`指定单帧尺寸 ${cellWidth}×${cellHeight} 小于内容尺寸 ${contentWidth}×${contentHeight}`);
  }

  const origin = { x: -minX, y: -minY };
  const padLen = String(startIndex + cells.length - 1).length + 1;
  const layout =
    opts.format === "spritesheet"
      ? resolveAtlasLayout(cellWidth, cellHeight, cells.length, {
          columns: opts.columns,
          rows: opts.rows,
          spacing,
          maxWidth: opts.maxWidth,
          maxHeight: opts.maxHeight,
        })
      : null;

  const sheet = layout ? document.createElement("canvas") : null;
  if (sheet && layout) {
    sheet.width = layout.width;
    sheet.height = layout.height;
  }
  const sheetCtx = sheet?.getContext("2d", { willReadFrequently: true }) ?? null;
  if (sheet && !sheetCtx) throw new Error("帧尺寸过大，无法创建精灵图画布");
  if (sheetCtx) sheetCtx.imageSmoothingEnabled = false;

  const entries: ZipEntry[] = [];
  const frames: AtlasFrameMeta[] = [];
  let totalDuration = 0;

  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]!;
    // 始终先在单格小画布完成合成，再贴到大图；避免大型 GPU 画布在编码时丢失中间纹理块。
    const canvas = document.createElement("canvas");
    canvas.width = cellWidth;
    canvas.height = cellHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("帧尺寸过大，无法创建导出画布");
    ctx.imageSmoothingEnabled = false;
    cell.draw(ctx, origin);

    const at = layout ? atlasCellOrigin(index, layout.columns, cellWidth, cellHeight, spacing) : { x: 0, y: 0 };
    const filename = `${prefix}_${String(startIndex + index).padStart(padLen, "0")}.png`;
    if (sheetCtx) {
      sheetCtx.drawImage(canvas, at.x, at.y);
    } else {
      const png = await canvasBlob(canvas);
      entries.push({ name: filename, data: new Uint8Array(await png.arrayBuffer()) });
    }

    totalDuration += cell.duration;
    frames.push({
      file: sheet ? `${opts.name}.png` : filename,
      x: at.x,
      y: at.y,
      w: cellWidth,
      h: cellHeight,
      duration: cell.duration,
      pivot: { x: origin.x, y: origin.y },
      ...(cell.trace ? { trace: cell.trace } : {}),
    });
  }

  if (sheet) {
    const png = await canvasBlob(sheet);
    entries.push({ name: `${opts.name}.png`, data: new Uint8Array(await png.arrayBuffer()) });
  }

  const meta: AtlasMeta = {
    frames,
    meta: {
      fps: opts.fps,
      count: cells.length,
      format: opts.format,
      cellWidth,
      cellHeight,
      originX: origin.x,
      originY: origin.y,
      totalDuration,
      app: ATLAS_APP_NAME,
      ...(spacing ? { spacing } : {}),
      ...(layout
        ? { columns: layout.columns, rows: layout.rows, imageWidth: layout.width, imageHeight: layout.height }
        : {}),
      ...(opts.extraMeta ?? {}),
    },
  };
  entries.push({
    name: `${opts.name}.frames.json`,
    data: new TextEncoder().encode(JSON.stringify(meta, null, 2)),
  });

  return { entries, meta };
}
