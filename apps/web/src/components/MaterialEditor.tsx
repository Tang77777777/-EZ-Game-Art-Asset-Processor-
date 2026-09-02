import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Eraser, FlipHorizontal2, Maximize, Minus, Plus, RotateCcw, RotateCw, Save, Undo2, X } from "lucide-react";
import { api, materialImageUrl } from "../api";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { editImage } from "../imageops/client";
import type { EditPoint, EraseStroke } from "../imageops/ops";
import { useT } from "../i18n";
import { notify } from "../notice";
import { useTheme } from "../theme";
import IconBtn from "./IconBtn";

interface OpenMaterialEditorOptions {
  id?: string;
  image?: Blob;
  name?: string;
  v?: number;
  onSave?: (image: Blob) => void | Promise<void>;
  onSaved?: () => void;
}

type OpenMaterialEditor = (options: OpenMaterialEditorOptions) => void;

const MaterialEditorContext = createContext<OpenMaterialEditor | null>(null);

export function useMaterialEditor(): OpenMaterialEditor {
  const open = useContext(MaterialEditorContext);
  if (!open) throw new Error("useMaterialEditor 必须在 MaterialEditorProvider 内使用");
  return open;
}

export function MaterialEditorProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<OpenMaterialEditorOptions | null>(null);
  const open = useCallback((options: OpenMaterialEditorOptions) => setRequest(options), []);
  return (
    <MaterialEditorContext.Provider value={open}>
      {children}
      {request && <MaterialEditorModal request={request} onClose={() => setRequest(null)} />}
    </MaterialEditorContext.Provider>
  );
}

function readEditorColors(element?: Element | null) {
  const style = getComputedStyle(element ?? document.documentElement);
  return {
    accent: style.getPropertyValue("--accent").trim(),
    border: style.getPropertyValue("--border-focused").trim(),
  };
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: EraseStroke) {
  const first = stroke.points[0];
  if (!first) return;
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = stroke.size;
  if (stroke.points.length === 1) {
    ctx.beginPath();
    ctx.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    ctx.stroke();
  }
  ctx.restore();
}

function MaterialEditorModal({ request, onClose }: { request: OpenMaterialEditorOptions; onClose: () => void }) {
  const t = useT();
  const theme = useTheme();
  const colors = useMemo(() => readEditorColors(document.querySelector(".app-shell")), [theme]);
  const [image, setImage] = useState<Blob | null>(null);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [brushSize, setBrushSize] = useState(16);
  const [quarterTurns, setQuarterTurns] = useState(0);
  const [flipHorizontal, setFlipHorizontal] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [revision, setRevision] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<EraseStroke[]>([]);
  const activeStrokeRef = useRef<EraseStroke | null>(null);
  const cursorRef = useRef<{ x: number; y: number } | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const panDragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const strokeExitedRef = useRef(false);
  const spaceRef = useRef(false);
  const drawRef = useRef<() => void>(() => {});
  const rafRef = useRef(0);

  useModalEscClose(onClose, !saving);

  useEffect(() => {
    modalRef.current?.focus();
  }, []);

  useEffect(() => {
    let alive = true;
    setImage(null);
    setBitmap(null);
    setBusy(true);
    const source = request.image
      ? Promise.resolve(request.image)
      : request.id
        ? fetch(materialImageUrl(request.id, request.v ?? Date.now())).then((res) => {
            if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
            return res.blob();
          })
        : Promise.reject(new Error(t("msg.failed_to_read_material_image")));
    source
      .then(async (blob) => {
        const nextBitmap = await createImageBitmap(blob);
        if (!alive) {
          nextBitmap.close();
          return;
        }
        const work = document.createElement("canvas");
        work.width = nextBitmap.width;
        work.height = nextBitmap.height;
        work.getContext("2d")!.drawImage(nextBitmap, 0, 0);
        workRef.current = work;
        strokesRef.current = [];
        setImage(blob);
        setBitmap(nextBitmap);
        setBrushSize(Math.max(1, Math.min(64, Math.round(Math.min(nextBitmap.width, nextBitmap.height) / 12))));
        setQuarterTurns(0);
        setFlipHorizontal(false);
        setZoom(1);
        panRef.current = { x: 0, y: 0 };
        setRevision((value) => value + 1);
      })
      .catch((error) => notify(t("msg.image_decode_failed_msg", { msg: (error as Error).message })))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [request.id, request.image, request.v, t]);

  useEffect(() => () => bitmap?.close(), [bitmap]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(() => setCanvasSize({ w: stage.clientWidth, h: stage.clientHeight }));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  const keyRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyRef.current = (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const isControl = Boolean(target?.closest("button, input, textarea, select, [contenteditable]"));
      if (event.code === "Space" && !isControl && !saving) {
        event.preventDefault();
        spaceRef.current = true;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !isControl && !busy) {
        event.preventDefault();
        undo();
      }
  };
  useEffect(() => {
    const down = (event: KeyboardEvent) => keyRef.current(event);
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const imgW = bitmap?.width ?? 0;
  const imgH = bitmap?.height ?? 0;
  const rotatedW = Math.abs(quarterTurns) % 2 ? imgH : imgW;
  const rotatedH = Math.abs(quarterTurns) % 2 ? imgW : imgH;
  const fitScale = canvasSize.w && rotatedW ? Math.min(canvasSize.w / rotatedW, canvasSize.h / rotatedH) * 0.9 : 1;
  const scale = fitScale * zoom;

  const scheduleDraw = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => drawRef.current());
  };

  drawRef.current = () => {
    const canvas = canvasRef.current;
    const work = workRef.current;
    if (!canvas || !work || !bitmap || !canvasSize.w || !canvasSize.h) return;
    const dpr = window.devicePixelRatio || 1;
    const pixelW = Math.round(canvasSize.w * dpr);
    const pixelH = Math.round(canvasSize.h * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvasSize.w, canvasSize.h);
    ctx.save();
    ctx.translate(canvasSize.w / 2 + panRef.current.x, canvasSize.h / 2 + panRef.current.y);
    ctx.rotate(quarterTurns * Math.PI / 2);
    ctx.scale(flipHorizontal ? -scale : scale, scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(work, -imgW / 2, -imgH / 2);
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(-imgW / 2, -imgH / 2, imgW, imgH);
    ctx.restore();
    const cursor = cursorRef.current;
    if (cursor) {
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, Math.max(3, brushSize * scale / 2), 0, Math.PI * 2);
      ctx.strokeStyle = colors.accent;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };

  useEffect(() => {
    scheduleDraw();
    return () => cancelAnimationFrame(rafRef.current);
  }, [bitmap, brushSize, canvasSize, colors, flipHorizontal, quarterTurns, revision, scale]);

  const toImage = (sx: number, sy: number): EditPoint => {
    const dx = sx - canvasSize.w / 2 - panRef.current.x;
    const dy = sy - canvasSize.h / 2 - panRef.current.y;
    const angle = -quarterTurns * Math.PI / 2;
    const rotatedX = dx * Math.cos(angle) - dy * Math.sin(angle);
    const rotatedY = dx * Math.sin(angle) + dy * Math.cos(angle);
    return {
      x: rotatedX / (flipHorizontal ? -scale : scale) + imgW / 2,
      y: rotatedY / scale + imgH / 2,
    };
  };

  const eventPosition = (event: { clientX: number; clientY: number }) => {
    const box = canvasRef.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const appendPoint = (point: EditPoint) => {
    const stroke = activeStrokeRef.current;
    const work = workRef.current;
    if (!stroke || !work || strokeExitedRef.current) return;
    const outside = point.x < 0 || point.y < 0 || point.x > imgW || point.y > imgH;
    if (outside) {
      point = {
        x: Math.max(0, Math.min(imgW, point.x)),
        y: Math.max(0, Math.min(imgH, point.y)),
      };
      strokeExitedRef.current = true;
    }
    const previous = stroke.points.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.35) return;
    stroke.points.push(point);
    drawStroke(work.getContext("2d")!, { size: stroke.size, points: previous ? [previous, point] : [point] });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pos = eventPosition(event);
    cursorRef.current = pos;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (busy) return;
    if (event.button === 1 || event.altKey || spaceRef.current) {
      panDragRef.current = { x: pos.x, y: pos.y, panX: panRef.current.x, panY: panRef.current.y };
      return;
    }
    if (event.button !== 0 || !bitmap) return;
    strokeExitedRef.current = false;
    activeStrokeRef.current = { size: brushSize, points: [] };
    appendPoint(toImage(pos.x, pos.y));
    scheduleDraw();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const pos = eventPosition(event);
    cursorRef.current = pos;
    const drag = panDragRef.current;
    if (drag) {
      panRef.current = { x: drag.panX + pos.x - drag.x, y: drag.panY + pos.y - drag.y };
      scheduleDraw();
      return;
    }
    if (activeStrokeRef.current) {
      const events = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
      for (const item of events) {
        const p = eventPosition(item);
        appendPoint(toImage(p.x, p.y));
      }
    }
    scheduleDraw();
  };

  const onPointerUp = () => {
    panDragRef.current = null;
    strokeExitedRef.current = false;
    const stroke = activeStrokeRef.current;
    activeStrokeRef.current = null;
    if (stroke?.points.length) {
      strokesRef.current.push(stroke);
      setRevision((value) => value + 1);
    }
  };

  function rebuildWork() {
    const work = workRef.current;
    if (!work || !bitmap) return;
    const ctx = work.getContext("2d")!;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, work.width, work.height);
    ctx.drawImage(bitmap, 0, 0);
    for (const stroke of strokesRef.current) drawStroke(ctx, stroke);
    setRevision((value) => value + 1);
  }

  function undo() {
    if (busy || !strokesRef.current.length) return;
    strokesRef.current.pop();
    rebuildWork();
  }

  const reset = () => {
    if (busy) return;
    strokesRef.current = [];
    setQuarterTurns(0);
    setFlipHorizontal(false);
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
    rebuildWork();
  };

  const rotate = (delta: number) => {
    if (busy) return;
    setQuarterTurns((value) => value + delta);
    setZoom(1);
    panRef.current = { x: 0, y: 0 };
  };

  const save = async () => {
    if (!image || busy || (!strokesRef.current.length && quarterTurns % 4 === 0 && !flipHorizontal)) return;
    setBusy(true);
    setSaving(true);
    try {
      const strokes = strokesRef.current.map(({ size, points }) => ({
        size,
        points: points.map(({ x, y }) => ({ x, y })),
      }));
      const turns = quarterTurns;
      const output = await editImage(image, strokes, turns, flipHorizontal);
      if (request.onSave) await request.onSave(output);
      else if (request.id) await api.replaceMaterialImage(request.id, output, "processed");
      else throw new Error(t("msg.failed_to_read_material_image"));
      request.onSaved?.();
      notify(t(request.onSave ? "materialEdit.changesSaved" : "materialEdit.saved"), "info");
      onClose();
    } catch (error) {
      notify(t("materialEdit.saveFailed", { msg: (error as Error).message }));
    } finally {
      setSaving(false);
      setBusy(false);
    }
  };

  return (
    <motion.div className="modal-mask material-editor-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div ref={modalRef} className="modal pixel-panel material-editor-modal" role="dialog" aria-modal="true" tabIndex={-1} initial={{ scale: 0.94, y: 20 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.94, y: 20 }} onClick={(event) => event.stopPropagation()}>
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("materialEdit.title", { name: request.name ?? t("common.material") })}</h2>
          <IconBtn disabled={saving} onClick={onClose} title={t("common.close")}><X size={16} /></IconBtn>
        </div>
        <div className="material-editor-stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            style={{ width: canvasSize.w, height: canvasSize.h }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => { cursorRef.current = null; scheduleDraw(); }}
          />
          {!bitmap && <div className="material-editor-loading">{t("msg.loading")}</div>}
        </div>
        <div className="crop-toolbar material-editor-toolbar">
          <span className="material-editor-tool-label"><Eraser size={14} /> {t("materialEdit.eraser")}</span>
          <input type="range" min={1} max={Math.max(64, Math.min(imgW, imgH) / 2)} value={brushSize} disabled={busy} onChange={(event) => setBrushSize(Number(event.target.value))} />
          <span className="zoom-label">{brushSize}px</span>
          <span className="tb-sep" />
          <IconBtn title={t("materialEdit.rotateLeft")} disabled={busy} onClick={() => rotate(-1)}><RotateCcw size={14} /></IconBtn>
          <IconBtn title={t("materialEdit.rotateRight")} disabled={busy} onClick={() => rotate(1)}><RotateCw size={14} /></IconBtn>
          <IconBtn title={t("materialEdit.flipHorizontal")} className={flipHorizontal ? "active" : ""} aria-pressed={flipHorizontal} disabled={busy} onClick={() => setFlipHorizontal((value) => !value)}><FlipHorizontal2 size={14} /></IconBtn>
          <IconBtn title={t("materialEdit.undo")} disabled={busy || !strokesRef.current.length} onClick={undo}><Undo2 size={14} /></IconBtn>
          <span className="tb-sep" />
          <IconBtn title={t("msg.zoom_out")} disabled={busy} onClick={() => setZoom((value) => Math.max(0.25, value / 1.25))}><Minus size={14} /></IconBtn>
          <span className="zoom-label">{Math.round(zoom * 100)}%</span>
          <IconBtn title={t("msg.zoom_in")} disabled={busy} onClick={() => setZoom((value) => Math.min(8, value * 1.25))}><Plus size={14} /></IconBtn>
          <IconBtn title={t("msg.fit")} disabled={busy} onClick={() => { setZoom(1); panRef.current = { x: 0, y: 0 }; scheduleDraw(); }}><Maximize size={14} /></IconBtn>
          <span className="crop-hint">{t("materialEdit.hint")}</span>
        </div>
        <div className="modal-actions">
          <button type="button" className="px-btn" disabled={busy} onClick={reset}>{t("materialEdit.reset")}</button>
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent" disabled={busy || !image || (!strokesRef.current.length && quarterTurns % 4 === 0 && !flipHorizontal)} onClick={() => void save()}>
            <Save size={14} /> {busy ? t("materialEdit.saving") : t(request.onSave ? "materialEdit.saveChanges" : "materialEdit.saveProcessed")}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}
