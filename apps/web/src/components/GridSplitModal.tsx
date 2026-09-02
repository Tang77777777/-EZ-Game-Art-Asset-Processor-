import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Grid3x3, Scan, ScanSearch, X } from "lucide-react";
import { api, materialImageUrl, type Material } from "../api";
import { cropImage, detectComponents, findOpaqueBounds } from "../imageops/client";
import { type CropRect } from "../imageops/ops";
import { notify } from "../notice";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onDone: () => void;
  onToast: (msg: string) => void;
}

const clampCell = (n: number) => Math.max(1, Math.min(8, Math.floor(n) || 1));

function gridFromMaterialName(name: string): { cols: number; rows: number } {
  const match = /_(\d+)x(\d+)$/.exec(name.trim());
  return match ? { cols: clampCell(Number(match[1])), rows: clampCell(Number(match[2])) } : { cols: 2, rows: 2 };
}

function clampRegion(r: CropRect, imgW: number, imgH: number): CropRect {
  let { x, y, w, h } = r;
  w = Math.max(1, Math.min(Math.round(w), imgW));
  h = Math.max(1, Math.min(Math.round(h), imgH));
  x = Math.max(0, Math.min(Math.round(x), imgW - w));
  y = Math.max(0, Math.min(Math.round(y), imgH - h));
  return { x, y, w, h };
}

/**
 * 多宫格精灵图网格切分：
 * - 可拖动网格区域对齐角色（图片坐标系）
 * - 等分行×列切成独立素材，或按连通域自动检测按部件切分（避免切穿）
 * - 可选每格自动裁透明边
 */
export default function GridSplitModal({ material: m, v, onClose, onDone, onToast }: Props) {
  const t = useT();
  const slot = m.processed_path ? "processed" : "raw";
  const initialGrid = gridFromMaterialName(m.name);
  const [rows, setRows] = useState(initialGrid.rows);
  const [cols, setCols] = useState(initialGrid.cols);
  const [autoMatting, setAutoMatting] = useState(!m.processed_path);
  const [autoTrim, setAutoTrim] = useState(true); // 每格裁透明边
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [region, setRegion] = useState<CropRect | null>(null);
  /** 连通域自动检测得到的部件矩形（图片绝对坐标）；非空时取代均匀网格。 */
  const [detected, setDetected] = useState<CropRect[] | null>(null);
  const [disp, setDisp] = useState<{ w: number; h: number }>({ w: 1, h: 1 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ ax: number; ay: number; rx: number; ry: number } | null>(null);
  useModalEscClose(onClose);

  // 八向转身表的 3×3 网格中心格留空，不产出素材
  const skipCenter = /_8directions_3x3$/.test(m.name.trim()) && rows === 3 && cols === 3;
  const total = detected ? detected.length : rows * cols - (skipCenter ? 1 : 0);

  // 载入尺寸，默认网格盖住整图
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(materialImageUrl(m.id, v, slot));
        if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        if (!alive) {
          bmp.close();
          return;
        }
        setImgSize({ w: bmp.width, h: bmp.height });
        setRegion({ x: 0, y: 0, w: bmp.width, h: bmp.height });
        bmp.close();
      } catch (e) {
        notify(t("msg.failed_to_read_material_image") + `: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [m.id, v, slot, t]);

  const syncDisp = useCallback(() => {
    const el = imgRef.current;
    if (!el) return;
    setDisp({ w: el.clientWidth || 1, h: el.clientHeight || 1 });
  }, []);

  useEffect(() => {
    syncDisp();
    window.addEventListener("resize", syncDisp);
    return () => window.removeEventListener("resize", syncDisp);
  }, [syncDisp, imgSize]);

  const scaleX = imgSize ? disp.w / imgSize.w : 1;
  const scaleY = imgSize ? disp.h / imgSize.h : 1;

  /** 均匀网格第 index 格在图片坐标系中的矩形 */
  const baseCellRect = (index: number): CropRect | null => {
    if (!region) return null;
    const row = Math.floor(index / cols);
    const col = index % cols;
    const cellWidth = Math.floor(region.w / cols);
    const cellHeight = Math.floor(region.h / rows);
    return {
      x: region.x + cellWidth * col,
      y: region.y + cellHeight * row,
      w: col === cols - 1 ? region.w - cellWidth * col : cellWidth,
      h: row === rows - 1 ? region.h - cellHeight * row : cellHeight,
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!region || busy || detected) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { ax: e.clientX, ay: e.clientY, rx: region.x, ry: region.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !imgSize) return;
    const dx = (e.clientX - d.ax) / scaleX;
    const dy = (e.clientY - d.ay) / scaleY;
    // 拖动 = 移动网格区域（对齐图片内容）
    setRegion((prev) => (prev ? clampRegion({ ...prev, x: d.rx + dx, y: d.ry + dy }, imgSize.w, imgSize.h) : prev));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  /** 把网格区域收成整图不透明包围盒 */
  const fitOpaque = async () => {
    if (!imgSize || busy) return;
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      const bounds = await findOpaqueBounds(blob);
      if (!bounds) {
        notify(t("msg.no_opaque_region_found"), "info");
        return;
      }
      setRegion(clampRegion(bounds, imgSize.w, imgSize.h));
    } catch (e) {
      notify(t("msg.auto_select_failed_msg", { msg: (e as Error).message }));
    }
  };

  const resetRegion = () => {
    if (!imgSize) return;
    setDetected(null);
    setRegion({ x: 0, y: 0, w: imgSize.w, h: imgSize.h });
  };

  /** 连通域自动检测：按不透明块切分，避免均匀网格切穿部件。 */
  const autoDetectComponents = async () => {
    if (!imgSize || busy) return;
    setBusy(true);
    setProgress(t("gridSplit.detecting"));
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      const rects = await detectComponents(blob, { minAreaRatio: 0.004, maxComponents: 64 });
      if (!rects.length) {
        notify(t("gridSplit.noComponents"), "info");
        return;
      }
      // 检测在整图坐标进行：网格区域重置为整图，矩形即绝对坐标。
      setRegion({ x: 0, y: 0, w: imgSize.w, h: imgSize.h });
      setDetected(rects);
      onToast(t("gridSplit.detectedComponents", { count: rects.length }));
    } catch (e) {
      notify(t("gridSplit.detectFailed", { msg: (e as Error).message }));
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const nudge = (dx: number, dy: number) => {
    if (!region || !imgSize) return;
    setRegion(clampRegion({ ...region, x: region.x + dx, y: region.y + dy }, imgSize.w, imgSize.h));
  };

  const split = async () => {
    if (busy || !region || !imgSize) return;
    if (!detected && (region.w < cols || region.h < rows)) {
      notify(t("msg.region_w_h_smaller_than_grid_cols_rows", { w: region.w, h: region.h, cols, rows }));
      return;
    }
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let trimmed = 0;
    let firstError = "";
    try {
      const res = await fetch(materialImageUrl(m.id, v, slot));
      if (!res.ok) throw new Error(t("msg.failed_to_read_material_image"));
      const blob = await res.blob();
      let rawBlob = blob;
      if (m.processed_path) {
        const rawResponse = await fetch(materialImageUrl(m.id, v, "raw"));
        if (!rawResponse.ok) throw new Error(t("msg.failed_to_read_material_image"));
        rawBlob = await rawResponse.blob();
      }
      const base = m.name.replace(/\s*#\d+$/, "").trim() || t("common.material");
      const targets = detected
        ? detected.map((rect, index) => ({ rect, row: 0, col: index }))
        : Array.from({ length: rows * cols }, (_, index) => ({
            rect: baseCellRect(index)!,
            row: Math.floor(index / cols),
            col: index % cols,
          })).filter((_, index) => !(skipCenter && index === 4));
      for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
        const { rect: cellRect, row, col } = targets[targetIndex];
        const i = targetIndex + 1;
        setProgress(t("msg.uploading_split_i_total", { i, total }));
        try {
          const { w, h } = cellRect;
          let cell = await cropImage(blob, cellRect);
          let rawCell = m.processed_path ? await cropImage(rawBlob, cellRect) : cell;
          if (autoTrim) {
            const bounds = await findOpaqueBounds(cell);
            if (bounds && (bounds.w < w || bounds.h < h || bounds.x > 0 || bounds.y > 0)) {
              cell = await cropImage(cell, bounds);
              if (m.processed_path) rawCell = await cropImage(rawCell, bounds);
              trimmed++;
            }
          }
          if (!m.processed_path) rawCell = cell;
          const cellName = detected ? `${base}_${i}` : `${base}_r${row + 1}c${col + 1}`;
          const fd = new FormData();
          fd.append("file", rawCell, `${cellName}.png`);
          if (m.processed_path) fd.append("processedFile", cell, `${cellName}_processed.png`);
          fd.append("autoMatting", String(autoMatting && !m.processed_path));
          fd.append("metadata", JSON.stringify({
            gridSplit: {
              fromMaterial: m.id,
              rows: detected ? 1 : rows,
              cols: detected ? detected.length : cols,
              row: row + 1,
              col: col + 1,
              sourceSlot: slot,
              autoTrim,
              ...(detected ? { detected: true, sourceRect: cellRect } : {}),
            },
          }));
          if (m.folder_id) fd.append("folderId", m.folder_id);
          await api.uploadMaterial(fd);
          ok++;
        } catch (e) {
          fail++;
          firstError ||= (e as Error).message;
        }
      }
      if (ok === 0 && firstError) throw new Error(firstError);
      onDone();
      onToast(
        fail
          ? t("msg.split_done_ok_ok_fail_failed", { ok, fail })
          : autoTrim && trimmed > 0
            ? t("msg.split_ok_materials_auto_trimmed_trimmed", { ok, trimmed })
            : t("msg.created_ok_materials", { ok })
      );
      onClose();
    } catch (e) {
      notify(t("msg.split_failed_msg", { msg: (e as Error).message }));
      setBusy(false);
      setProgress("");
    }
  };

  const regionStyle =
    region && imgSize
      ? {
          left: region.x * scaleX,
          top: region.y * scaleY,
          width: region.w * scaleX,
          height: region.h * scaleY,
        }
      : undefined;

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="modal pixel-panel gs-modal frame-mode"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gs-header">
          <div>
            <h2>{t("msg.grid_split")}</h2>
            <p>
              {t("msg.target_target_drag_grid_to_align_split_cells_into_materi", {
                target: slot === "processed" ? t("msg.matted") : t("msg.original"),
              })}
            </p>
          </div>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </header>

        <div className="gs-layout">
          <section className="gs-preview-pane">
            <div
              className="gs-wrap"
              ref={wrapRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                ref={imgRef}
                src={materialImageUrl(m.id, v, slot)}
                alt={m.name}
                draggable={false}
                onLoad={syncDisp}
              />
              {regionStyle && (
                <div className="gs-region" style={regionStyle}>
                  {detected && region
                    ? detected.map((rect, index) => (
                        <div
                          className="gs-detected-cell"
                          key={`d${index}`}
                          style={{
                            left: (rect.x - region.x) * scaleX,
                            top: (rect.y - region.y) * scaleY,
                            width: rect.w * scaleX,
                            height: rect.h * scaleY,
                          }}
                        >
                          <span>{index + 1}</span>
                        </div>
                      ))
                    : <>
                        {Array.from({ length: cols - 1 }, (_, i) => (
                          <div key={`v${i}`} className="gs-line v" style={{ left: `${((i + 1) / cols) * 100}%` }} />
                        ))}
                        {Array.from({ length: rows - 1 }, (_, i) => (
                          <div key={`h${i}`} className="gs-line h" style={{ top: `${((i + 1) / rows) * 100}%` }} />
                        ))}
                      </>}
                </div>
              )}
            </div>

            <div className="gs-preview-controls">
              <div className="form-inline gs-tools">
                <button
                  type="button"
                  className={`px-btn mini${detected ? " accent" : ""}`}
                  disabled={busy || !imgSize}
                  title={t("gridSplit.autoDetectHint")}
                  onClick={() => void autoDetectComponents()}
                >
                  <ScanSearch size={14} /> {t("gridSplit.autoDetect")}
                </button>
                {detected && (
                  <button type="button" className="px-btn mini" disabled={busy} onClick={() => setDetected(null)}>
                    {t("gridSplit.restoreGrid")}
                  </button>
                )}
                <IconBtn title={t("msg.fit_opaque_bounds")} disabled={busy || !imgSize || !!detected} onClick={() => void fitOpaque()}>
                  <Scan size={14} />
                </IconBtn>
                <button type="button" className="px-btn mini" disabled={busy || !imgSize} onClick={resetRegion}>
                  {t("msg.reset_to_full_image")}
                </button>
                <button type="button" className="px-btn mini" disabled={busy || !region || !!detected} onClick={() => nudge(-1, 0)}>
                  ←
                </button>
                <button type="button" className="px-btn mini" disabled={busy || !region || !!detected} onClick={() => nudge(1, 0)}>
                  →
                </button>
                <button type="button" className="px-btn mini" disabled={busy || !region || !!detected} onClick={() => nudge(0, -1)}>
                  ↑
                </button>
                <button type="button" className="px-btn mini" disabled={busy || !region || !!detected} onClick={() => nudge(0, 1)}>
                  ↓
                </button>
                {region && imgSize && (
                  <span className="gs-total">
                    {t("msg.region_x_y_w_h", { x: region.x, y: region.y, w: region.w, h: region.h })}
                  </span>
                )}
              </div>

              <div className="form-inline gs-grid-settings">
                <label className="px-check">
                  {t("msg.cols")}
                  <input
                    className="px-input num"
                    type="number"
                    min={1}
                    max={8}
                    value={cols}
                    disabled={busy || !!detected}
                    onChange={(e) => setCols(clampCell(Number(e.target.value)))}
                  />
                </label>
                <label className="px-check">
                  {t("msg.rows")}
                  <input
                    className="px-input num"
                    type="number"
                    min={1}
                    max={8}
                    value={rows}
                    disabled={busy || !!detected}
                    onChange={(e) => setRows(clampCell(Number(e.target.value)))}
                  />
                </label>
                <strong className="gs-total">{t("msg.total_cells", { total })}</strong>
              </div>

              <div className="gs-options">
                <label className="px-check">
                  <input type="checkbox" checked={autoTrim} disabled={busy} onChange={(e) => setAutoTrim(e.target.checked)} />
                  {t("msg.auto_trim_transparent_edges_per_cell")}
                </label>
                {!m.processed_path && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}
              </div>
            </div>
          </section>
        </div>

        <footer className="modal-actions gs-footer">
          <button type="button" className="px-btn" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </button>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={busy || !region}
            onClick={() => void split()}
          >
            <Grid3x3 size={14} /> {busy ? progress || t("msg.splitting") : t("msg.split_into_total_materials", { total })}
          </motion.button>
        </footer>
      </motion.div>
    </motion.div>
  );
}
