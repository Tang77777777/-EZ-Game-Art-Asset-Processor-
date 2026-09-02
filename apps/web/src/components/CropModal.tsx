import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Crop, Grid3x3, Layers, Maximize, Minus, Plus, Scan, X } from "lucide-react";
import { useT } from "../i18n";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import { notify } from "../notice";
import type { CropRect } from "../imageops/ops";
import { useTheme } from "../theme";
import { useModalEscClose } from "../hooks/useModalEscClose";
import IconBtn from "./IconBtn";

interface Props {
  image: Blob;
  /** 标题与副标题（如「作用于：抠图后」） */
  title?: string;
  subtitle?: string;
  onConfirm: (blob: Blob) => void | Promise<void>;
  /** 逐张剪裁时提供「跳过本张」 */
  onSkip?: () => void;
  /** 队列批量：把当前剪裁框应用到剩余图片（remaining > 0 时才显示按钮） */
  onConfirmAll?: (rect: CropRect) => void | Promise<void>;
  /** 队列批量：剩余图片全部自动裁透明边 */
  onTrimAll?: () => void | Promise<void>;
  /** 队列中除当前张外的剩余未处理数量（驱动批量按钮的显示与文案） */
  remaining?: number;
  onClose: () => void;
}

type DragMode =
  | { kind: "none" }
  | { kind: "new"; ax: number; ay: number }
  | { kind: "move"; dx: number; dy: number }
  | { kind: "resize"; handle: string }
  | { kind: "pan"; px: number; py: number };

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/** 宽高比锁定选项（null = 自由） */
const RATIO_VALUES: { labelKey?: string; label: string; value: number | null }[] = [
  { labelKey: "crop.free", label: "crop.free", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
];

/** 常用尺寸预设（像素，居中放置） */
const SIZE_PRESETS = [16, 32, 64] as const;

/** 从 CSS 变量读画布配色（主题切换后重读，不硬编码色值） */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
  return {
    mask: read("--mask", "rgba(0,0,0,0.6)"),
    accent: read("--accent", "#ffb86c"),
    grid: read("--border", "#3a3f45"),
    border: read("--text-muted", "#8a8f96"),
    checkerA: read("--checker-a", "#3a3f45"),
    checkerB: read("--checker-b", "#25292e"),
  };
}

function clampRect(r: CropRect, imgW: number, imgH: number): CropRect {
  let { x, y, w, h } = r;
  w = Math.max(1, Math.min(Math.round(w), imgW));
  h = Math.max(1, Math.min(Math.round(h), imgH));
  x = Math.max(0, Math.min(Math.round(x), imgW - w));
  y = Math.max(0, Math.min(Math.round(y), imgH - h));
  return { x, y, w, h };
}

/** 像素图剪裁工具：整数像素框选 + 缩放/网格/自动透明边，重活（扫描/编码）走 imageops worker */
export default function CropModal({ image, title, subtitle, onConfirm, onSkip, onConfirmAll, onTrimAll, remaining = 0, onClose }: Props) {
  const t = useT();
  const titleId = useId();
  const ratios = useMemo(
    () => RATIO_VALUES.map((r) => ({ ...r, label: r.labelKey ? t(r.labelKey) : r.label })),
    [t]
  );
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showGrid, setShowGrid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyText, setBusyText] = useState("");
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragMode>({ kind: "none" });
  const theme = useTheme();
  const colors = useMemo(readColors, [theme]);
  const [ratio, setRatio] = useState<number | null>(null);

  // 透明底棋盘格瓦片（8px 格，随主题重建）
  const checkerTile = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 16;
    const g = c.getContext("2d")!;
    g.fillStyle = colors.checkerB;
    g.fillRect(0, 0, 16, 16);
    g.fillStyle = colors.checkerA;
    g.fillRect(0, 0, 8, 8);
    g.fillRect(8, 8, 8, 8);
    return c;
  }, [colors]);

  const imgW = bitmap?.width ?? 0;
  const imgH = bitmap?.height ?? 0;

  // ---- 视图变换 ----
  const toImage = useCallback(
    (sx: number, sy: number) => ({ x: (sx - pan.x) / zoom, y: (sy - pan.y) / zoom }),
    [pan, zoom]
  );

  const fitView = useCallback(
    (cw: number, ch: number, w: number, h: number) => {
      if (cw === 0 || ch === 0 || w === 0 || h === 0) return;
      const z = Math.max(0.1, Math.min(cw / w, ch / h, 32) * 0.92);
      setZoom(z);
      setPan({ x: (cw - w * z) / 2, y: (ch - h * z) / 2 });
    },
    []
  );

  // ---- 解码 + 默认框选非透明区域（全透明/无通道则整图）----
  useEffect(() => {
    let alive = true;
    let bmp: ImageBitmap | null = null;
    setBitmap(null);
    setRect(null);
    (async () => {
      try {
        const b = await createImageBitmap(image);
        if (!alive) {
          b.close();
          return;
        }
        bmp = b;
        setBitmap(b);
        const wrap = wrapRef.current;
        if (wrap) fitView(wrap.clientWidth, wrap.clientHeight, b.width, b.height);
        let bounds: CropRect | null = null;
        try {
          bounds = await findOpaqueBounds(image);
        } catch {
          // 扫描失败仍可按整图剪裁
        }
        if (alive) setRect(bounds ?? { x: 0, y: 0, w: b.width, h: b.height });
      } catch (e) {
        if (alive) notify(t("msg.image_decode_failed_msg", { msg: (e as Error).message }));
      }
    })();
    return () => {
      alive = false;
      bmp?.close();
    };
  }, [image, fitView, t]);

  // ---- 画布尺寸跟随容器（ResizeObserver），初始适配视图 ----
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      setCanvasSize((prev) => {
        if (prev.w === 0 && bitmap) fitView(w, h, bitmap.width, bitmap.height);
        return { w, h };
      });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [bitmap, fitView]);

  // ---- 滚轮缩放（锚定光标；原生监听以便 preventDefault）----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rectBox = canvas.getBoundingClientRect();
      const cx = e.clientX - rectBox.left;
      const cy = e.clientY - rectBox.top;
      setZoom((z) => {
        const nz = Math.min(64, Math.max(0.1, z * (e.deltaY < 0 ? 1.25 : 0.8)));
        setPan((p) => ({ x: cx - (cx - p.x) * (nz / z), y: cy - (cy - p.y) * (nz / z) }));
        return nz;
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ---- 绘制 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.w === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.w * dpr;
    canvas.height = canvasSize.h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, canvasSize.w, canvasSize.h);
    if (!bitmap) return;

    ctx.imageSmoothingEnabled = false;
    // 透明区域棋盘格底（先铺底再画图片，框外遮罩照常压暗）
    const checker = ctx.createPattern(checkerTile, "repeat");
    if (checker) {
      ctx.fillStyle = checker;
      ctx.fillRect(pan.x, pan.y, imgW * zoom, imgH * zoom);
    }
    ctx.drawImage(bitmap, pan.x, pan.y, imgW * zoom, imgH * zoom);

    // 图像边界
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(pan.x - 0.5, pan.y - 0.5, imgW * zoom + 1, imgH * zoom + 1);

    // 像素网格：zoom ≥ 8 才画（可见线条数量有限）
    if (showGrid && zoom >= 8) {
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.max(0, Math.floor(-pan.x / zoom));
      const x1 = Math.min(imgW, Math.ceil((canvasSize.w - pan.x) / zoom));
      const y0 = Math.max(0, Math.floor(-pan.y / zoom));
      const y1 = Math.min(imgH, Math.ceil((canvasSize.h - pan.y) / zoom));
      for (let x = x0; x <= x1; x++) {
        const sx = Math.round(pan.x + x * zoom) + 0.5;
        ctx.moveTo(sx, pan.y + y0 * zoom);
        ctx.lineTo(sx, pan.y + y1 * zoom);
      }
      for (let y = y0; y <= y1; y++) {
        const sy = Math.round(pan.y + y * zoom) + 0.5;
        ctx.moveTo(pan.x + x0 * zoom, sy);
        ctx.lineTo(pan.x + x1 * zoom, sy);
      }
      ctx.stroke();
    }

    // 剪裁框：外部遮罩 + 高亮边框 + 手柄
    if (rect) {
      const rx = pan.x + rect.x * zoom;
      const ry = pan.y + rect.y * zoom;
      const rw = rect.w * zoom;
      const rh = rect.h * zoom;
      ctx.fillStyle = colors.mask;
      ctx.fillRect(0, 0, canvasSize.w, ry);
      ctx.fillRect(0, ry + rh, canvasSize.w, canvasSize.h - ry - rh);
      ctx.fillRect(0, ry, rx, rh);
      ctx.fillRect(rx + rw, ry, canvasSize.w - rx - rw, rh);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 2;
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.fillStyle = colors.accent;
      for (const h of HANDLES) {
        const hx = h.includes("w") ? rx : h.includes("e") ? rx + rw : rx + rw / 2;
        const hy = h.includes("n") ? ry : h.includes("s") ? ry + rh : ry + rh / 2;
        ctx.fillRect(hx - 3, hy - 3, 6, 6);
      }
    }
  }, [bitmap, rect, zoom, pan, showGrid, canvasSize, colors, checkerTile, imgW, imgH]);

  // ---- 指针交互：框内移动 / 八向缩放 / 空白新框 / 中键或 Alt 平移 ----
  const hitHandle = (sx: number, sy: number): string | null => {
    if (!rect) return null;
    const rx = pan.x + rect.x * zoom;
    const ry = pan.y + rect.y * zoom;
    const rw = rect.w * zoom;
    const rh = rect.h * zoom;
    for (const h of HANDLES) {
      const hx = h.includes("w") ? rx : h.includes("e") ? rx + rw : rx + rw / 2;
      const hy = h.includes("n") ? ry : h.includes("s") ? ry + rh : ry + rh / 2;
      if (Math.abs(sx - hx) <= 7 && Math.abs(sy - hy) <= 7) return h;
    }
    return null;
  };

  const insideRect = (sx: number, sy: number): boolean => {
    if (!rect) return false;
    const rx = pan.x + rect.x * zoom;
    const ry = pan.y + rect.y * zoom;
    return sx >= rx && sx <= rx + rect.w * zoom && sy >= ry && sy <= ry + rect.h * zoom;
  };

  /** 比例锁定时由锚点生成矩形：另一边按比例联动并 clamp 在图内 */
  const ratioRect = (ax: number, ay: number, dirX: number, dirY: number, w: number, h: number, r: number): CropRect => {
    const maxW = dirX > 0 ? imgW - ax : ax;
    const maxH = dirY > 0 ? imgH - ay : ay;
    w = Math.max(1, Math.min(Math.round(w), maxW));
    h = Math.max(1, Math.round(w / r));
    if (h > maxH) {
      // 高被图片边界截断时反推宽，尽量保住比例
      h = Math.max(1, maxH);
      w = Math.max(1, Math.min(Math.round(h * r), maxW));
    }
    return { x: dirX > 0 ? ax : ax - w, y: dirY > 0 ? ay : ay - h, w, h };
  };

  const resizeRect = (handle: string, ix: number, iy: number): CropRect | null => {
    if (!rect) return null;
    if (ratio) {
      // 比例锁定：以拖动边为主轴，另一边按比例联动
      const isW = handle.includes("w");
      const isE = handle.includes("e");
      const isN = handle.includes("n");
      const isS = handle.includes("s");
      if ((isW || isE) && (isN || isS)) {
        // 角手柄：锚定对角，取相对变化大的一边为主轴
        const ax = isW ? rect.x + rect.w : rect.x;
        const ay = isN ? rect.y + rect.h : rect.y;
        const dw = Math.abs(ix - ax);
        const dh = Math.abs(iy - ay);
        let w: number;
        let h: number;
        if (dw / rect.w >= dh / rect.h) {
          w = dw;
          h = w / ratio;
        } else {
          h = dh;
          w = h * ratio;
        }
        return ratioRect(ax, ay, isW ? -1 : 1, isN ? -1 : 1, w, h, ratio);
      }
      if (isW || isE) {
        // 东西边：宽为主轴，高绕垂直中心联动
        const ax = isW ? rect.x + rect.w : rect.x;
        const maxW = isW ? ax : imgW - ax;
        const w = Math.max(1, Math.min(Math.round(Math.abs(ix - ax)), maxW));
        const h = Math.max(1, Math.min(Math.round(w / ratio), imgH));
        const cy = rect.y + rect.h / 2;
        const y = Math.max(0, Math.min(Math.round(cy - h / 2), imgH - h));
        return { x: isW ? ax - w : ax, y, w, h };
      }
      // 南北边：高为主轴，宽绕水平中心联动
      const ay = isN ? rect.y + rect.h : rect.y;
      const maxH = isN ? ay : imgH - ay;
      const h = Math.max(1, Math.min(Math.round(Math.abs(iy - ay)), maxH));
      const w = Math.max(1, Math.min(Math.round(h * ratio), imgW));
      const cx = rect.x + rect.w / 2;
      const x = Math.max(0, Math.min(Math.round(cx - w / 2), imgW - w));
      return { x, y: isN ? ay - h : ay, w, h };
    }
    let { x, y } = rect;
    let x2 = rect.x + rect.w;
    let y2 = rect.y + rect.h;
    if (handle.includes("w")) x = Math.min(Math.round(ix), x2 - 1);
    if (handle.includes("e")) x2 = Math.max(Math.round(ix), x + 1);
    if (handle.includes("n")) y = Math.min(Math.round(iy), y2 - 1);
    if (handle.includes("s")) y2 = Math.max(Math.round(iy), y + 1);
    return clampRect({ x, y, w: x2 - x, h: y2 - y }, imgW, imgH);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.altKey) {
      dragRef.current = { kind: "pan", px: sx, py: sy };
      return;
    }
    if (e.button !== 0 || !bitmap) return;
    const handle = hitHandle(sx, sy);
    if (handle) {
      dragRef.current = { kind: "resize", handle };
      return;
    }
    if (insideRect(sx, sy) && rect) {
      const p = toImage(sx, sy);
      dragRef.current = { kind: "move", dx: p.x - rect.x, dy: p.y - rect.y };
      return;
    }
    const p = toImage(sx, sy);
    dragRef.current = { kind: "new", ax: p.x, ay: p.y };
    setRect(clampRect({ x: p.x, y: p.y, w: 1, h: 1 }, imgW, imgH));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const mode = dragRef.current;
    if (mode.kind === "none") return;
    const box = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - box.left;
    const sy = e.clientY - box.top;
    if (mode.kind === "pan") {
      setPan((p) => ({ x: p.x + sx - mode.px, y: p.y + sy - mode.py }));
      dragRef.current = { kind: "pan", px: sx, py: sy };
      return;
    }
    const p = toImage(sx, sy);
    if (mode.kind === "new") {
      if (ratio) {
        // 比例锁定：从按下点（clamp 进图内）按比例拖出新框
        const ax = Math.max(0, Math.min(Math.round(mode.ax), imgW - 1));
        const ay = Math.max(0, Math.min(Math.round(mode.ay), imgH - 1));
        const dw = Math.abs(p.x - ax);
        const dh = Math.abs(p.y - ay);
        let w: number;
        let h: number;
        if (dw >= dh * ratio) {
          w = dw;
          h = w / ratio;
        } else {
          h = dh;
          w = h * ratio;
        }
        setRect(ratioRect(ax, ay, p.x >= ax ? 1 : -1, p.y >= ay ? 1 : -1, w, h, ratio));
        return;
      }
      const x = Math.min(mode.ax, p.x);
      const y = Math.min(mode.ay, p.y);
      setRect(
        clampRect(
          { x: Math.round(x), y: Math.round(y), w: Math.round(Math.abs(p.x - mode.ax)) + 1, h: Math.round(Math.abs(p.y - mode.ay)) + 1 },
          imgW,
          imgH
        )
      );
    } else if (mode.kind === "move" && rect) {
      setRect(clampRect({ ...rect, x: Math.round(p.x - mode.dx), y: Math.round(p.y - mode.dy) }, imgW, imgH));
    } else if (mode.kind === "resize") {
      const r = resizeRect(mode.handle, p.x, p.y);
      if (r) setRect(r);
    }
  };

  const onPointerUp = () => {
    dragRef.current = { kind: "none" };
  };

  // ---- 工具行 ----
  const patchRect = (patch: Partial<CropRect>) => {
    if (!rect) return;
    setRect(clampRect({ ...rect, ...patch }, imgW, imgH));
  };

  const resetBounds = async () => {
    try {
      const bounds = await findOpaqueBounds(image);
      if (bitmap) setRect(bounds ?? { x: 0, y: 0, w: bitmap.width, h: bitmap.height });
    } catch (e) {
      notify(t("msg.auto_select_failed_msg", { msg: (e as Error).message }));
    }
  };

  const fullImage = () => {
    if (bitmap) setRect({ x: 0, y: 0, w: bitmap.width, h: bitmap.height });
  };

  /** 切换宽高比锁定：已有框时保持中心、以宽为基准调高（clamp 到图内） */
  const changeRatio = (r: number | null) => {
    setRatio(r);
    if (!r || !rect) return;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    let w = rect.w;
    let h = Math.max(1, Math.round(w / r));
    if (h > imgH) {
      h = imgH;
      w = Math.max(1, Math.min(Math.round(h * r), imgW));
    }
    setRect(clampRect({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h }, imgW, imgH));
  };

  /** 尺寸预设：居中放置，超出图片的边 clamp（双边都超即整图） */
  const applyPreset = (s: number) => {
    if (!bitmap) return;
    const w = Math.min(s, imgW);
    const h = Math.min(s, imgH);
    setRect({ x: Math.round((imgW - w) / 2), y: Math.round((imgH - h) / 2), w, h });
  };

  const doConfirm = async () => {
    if (!rect || busy) return;
    setBusyText(t("msg.cropping_a8d178"));
    setBusy(true);
    try {
      const blob = await cropImage(image, rect);
      await onConfirm(blob);
    } catch (e) {
      notify(t("msg.crop_failed_msg", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  /** 「应用到剩余 N 张」：把当前框交给队列批量处理（hook 内逐张求交集），结束后队列关闭 */
  const doConfirmAll = async () => {
    if (!rect || busy || !onConfirmAll) return;
    setBusyText(t("msg.batch_cropping"));
    setBusy(true);
    try {
      await onConfirmAll(rect);
    } finally {
      setBusy(false);
    }
  };

  /** 「剩余全部 trim 透明边」：无需当前框，直接交给队列批量处理 */
  const doTrimAll = async () => {
    if (busy || !onTrimAll) return;
    setBusyText(t("msg.batch_cropping"));
    setBusy(true);
    try {
      await onTrimAll();
    } finally {
      setBusy(false);
    }
  };

  // ---- 键盘快捷键：Enter 确认 / Esc 取消 / 方向键移动 1px（Shift 10px）----
  // 经 ref 转发，window 监听只挂一次且始终拿到最新状态
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const move: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = move[e.key];
    if (d && rect) {
      // 数字输入框内也接管方向键（preventDefault 挡住数值自增）
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      setRect(clampRect({ ...rect, x: rect.x + d[0] * step, y: rect.y + d[1] * step }, imgW, imgH));
      return;
    }
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      // 输入框内只接管 Enter 确认，其余按键留给输入框
      if (e.key === "Enter") {
        e.preventDefault();
        doConfirm();
      }
      return;
    }
    if (e.key === "Enter") {
      if (e.target instanceof HTMLButtonElement) return; // 按钮聚焦时 Enter 走原生点击
      e.preventDefault();
      doConfirm();
    }
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  useModalEscClose(onClose);

  const num = (v: number, onChange: (n: number) => void, max: number) => (
    <input
      className="px-input num"
      type="number"
      min={0}
      max={max}
      value={v}
      onChange={(e) => onChange(Number(e.target.value) || 0)}
    />
  );

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}  >
      <motion.div
        className="modal pixel-panel crop-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 id={titleId} style={{ flex: 1 }}>
            {title ?? t("msg.crop_image")}
            {subtitle && <span className="crop-sub"> · {subtitle}</span>}
          </h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="crop-stage" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ width: canvasSize.w, height: canvasSize.h }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          />
        </div>

        <div className="crop-toolbar">
          <span className="crop-nums">
            X {num(rect?.x ?? 0, (n) => patchRect({ x: n }), imgW - 1)}Y {num(rect?.y ?? 0, (n) => patchRect({ y: n }), imgH - 1)}
            {t("msg.msg_6395f4")}{" "}
            {num(rect?.w ?? 0, (n) => patchRect({ w: n }), imgW)}
            {t("msg.msg_b096b3")} {num(rect?.h ?? 0, (n) => patchRect({ h: n }), imgH)}
          </span>
          <span className="crop-size">
            {t("msg.image_w_h", { w: imgW, h: imgH })}
          </span>
        </div>

        <div className="crop-toolbar">
          <IconBtn title={t("msg.zoom_out")} onClick={() => setZoom((z) => Math.max(0.1, z / 1.25))}>
            <Minus size={14} />
          </IconBtn>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <IconBtn title={t("msg.zoom_in")} onClick={() => setZoom((z) => Math.min(64, z * 1.25))}>
            <Plus size={14} />
          </IconBtn>
          <IconBtn title={t("msg.fit")} onClick={() => bitmap && fitView(canvasSize.w, canvasSize.h, imgW, imgH)}>
            <Maximize size={14} />
          </IconBtn>
          <IconBtn className={showGrid ? "on" : ""} title={t("msg.pixel_grid")} onClick={() => setShowGrid((s) => !s)}>
            <Grid3x3 size={14} />
          </IconBtn>
          <span className="tb-sep" />
          <IconBtn title={t("msg.auto_select_opaque_bounds")} onClick={resetBounds}>
            <Scan size={14} />
          </IconBtn>
          <IconBtn title={t("msg.full_image")} onClick={fullImage}>
            <Crop size={14} />
          </IconBtn>
          <span className="tb-sep" />
          {ratios.map((r) => (
            <IconBtn
              key={String(r.value ?? "free")}
              className={ratio === r.value ? "on" : ""}
              title={t("msg.aspect_lock_label", { label: r.label })}
              style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
              onClick={() => changeRatio(r.value)}
            >
              {r.label}
            </IconBtn>
          ))}
          <span className="tb-sep" />
          {SIZE_PRESETS.map((s) => (
            <IconBtn
              key={s}
              title={t("msg.preset_s_s_centered", { s })}
              style={{ width: "auto", padding: "0 6px", fontSize: 11 }}
              onClick={() => applyPreset(s)}
            >
              {s}
            </IconBtn>
          ))}
          <span className="crop-hint">{t("msg.drag_select_wheel_zoom_alt_mmb_pan_arrows_nudge")}</span>
        </div>

        <div className="modal-actions">
          {onSkip && (
            <button type="button" className="px-btn" disabled={busy} onClick={onSkip}>
              {t("msg.skip")}
            </button>
          )}
          {onTrimAll && remaining > 0 && (
            <button type="button" className="px-btn" disabled={busy} onClick={doTrimAll}>
              <Scan size={14} /> {t("msg.trim_transparent_edges_on_remaining_remaining", { remaining })}
            </button>
          )}
          {onConfirmAll && remaining > 0 && (
            <button type="button" className="px-btn" disabled={!rect || busy} onClick={doConfirmAll}>
              <Layers size={14} /> {t("msg.apply_to_remaining_remaining", { remaining })}
            </button>
          )}
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={!rect || busy}
            onClick={doConfirm}
          >
            <Crop size={14} />{" "}
            {busy ? busyText : rect ? t("msg.confirm_crop_w_h", { w: rect.w, h: rect.h }) : t("msg.confirm_crop")}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
