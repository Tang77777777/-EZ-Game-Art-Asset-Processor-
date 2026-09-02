import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EXTRACT_TIMESTAMPS_MAX } from "@ezgameart/shared";
import { Film, Keyboard, LoaderCircle, Pause, Play, Plus, RotateCcw, SkipBack, SkipForward, Trash2, X } from "lucide-react";
import { api, materialFileUrl, type Material } from "../api";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";

interface Props {
  material: Material;
  v: number;
  onClose: () => void;
  onToast: (msg: string) => void;
}

type Mark = {
  id: string;
  /** 秒 */
  t: number;
  /** 缩略图 object URL；排队中为 null */
  thumb: string | null;
};

const THUMB_MAX = 96;
const FRAME_STEP = 1 / 24;
let markSeq = 0;
const nextMarkId = () => `m${++markSeq}`;

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00.00";
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, "0")}`;
}

/** 区间 + fps → 时间点列表（含端点，去重，截断上限） */
export function fillTimestamps(start: number, end: number, fps: number): number[] {
  const a = Math.max(0, Math.min(start, end));
  const b = Math.max(start, end);
  const step = 1 / Math.max(1, fps);
  const out: number[] = [];
  const seen = new Set<number>();
  for (let t = a; t <= b + 1e-9; t += step) {
    const key = Math.round(t * 1000);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key / 1000);
    if (out.length >= EXTRACT_TIMESTAMPS_MAX) break;
  }
  if (out.length < EXTRACT_TIMESTAMPS_MAX) {
    const endKey = Math.round(b * 1000);
    if (!seen.has(endKey)) out.push(endKey / 1000);
  }
  return out;
}

/**
 * 视频抽帧编辑器：播放/scrub 打点 + 区间 fps 快捷；
 * 缩略图串行 seek 截取（主线程，单队列）；提交只传 timestamps 给服务端。
 */
export default function VideoExtractModal({ material: m, v, onClose, onToast }: Props) {
  const t = useT();
  useModalEscClose(onClose);
  const videoRef = useRef<HTMLVideoElement>(null);
  const thumbVideoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 });
  const [marks, setMarks] = useState<Mark[]>([]);
  const [autoMatting, setAutoMatting] = useState(true);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);
  const [fillFps, setFillFps] = useState(8);
  const [submitting, setSubmitting] = useState(false);
  const [thumbPending, setThumbPending] = useState(0);

  // 串行截图队列（同时仅 1 次 seek）
  const queueRef = useRef<Array<{ id: string; t: number }>>([]);
  const busyRef = useRef(false);
  const marksRef = useRef(marks);
  marksRef.current = marks;

  const src = `${materialFileUrl(m.id, v, "raw")}&play=${loadAttempt}`;

  const revokeThumb = (url: string | null) => {
    if (url) URL.revokeObjectURL(url);
  };

  useEffect(() => {
    return () => {
      marksRef.current.forEach((mk) => revokeThumb(mk.thumb));
      queueRef.current = [];
      videoRef.current?.pause();
      thumbVideoRef.current?.pause();
    };
  }, []);

  const captureAt = useCallback(async (time: number): Promise<string | null> => {
    const video = thumbVideoRef.current;
    if (!video) return null;
    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          cleanup();
          reject(new Error("metadata timeout"));
        }, 8000);
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onErr = () => {
          cleanup();
          reject(new Error("metadata failed"));
        };
        const cleanup = () => {
          window.clearTimeout(timer);
          video.removeEventListener("loadedmetadata", onReady);
          video.removeEventListener("error", onErr);
        };
        video.addEventListener("loadedmetadata", onReady);
        video.addEventListener("error", onErr);
      });
    }
    if (!Number.isFinite(video.duration) || video.duration <= 0) return null;

    await new Promise<void>((resolve, reject) => {
      const onSeeked = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error("seek failed"));
      };
      const cleanup = () => {
        video.removeEventListener("seeked", onSeeked);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("seeked", onSeeked);
      video.addEventListener("error", onErr);
      const target = Math.min(Math.max(0, time), Math.max(0, video.duration - 0.001));
      if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) {
        cleanup();
        resolve();
        return;
      }
      video.currentTime = target;
    });

    const vw = video.videoWidth || 1;
    const vh = video.videoHeight || 1;
    const scale = Math.min(1, THUMB_MAX / Math.max(vw, vh));
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    let canvas = canvasRef.current;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvasRef.current = canvas;
    }
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(video, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, "image/jpeg", 0.72));
    return blob ? URL.createObjectURL(blob) : null;
  }, []);

  const pumpQueue = useCallback(async () => {
    if (busyRef.current) return;
    const next = queueRef.current.shift();
    if (!next) {
      setThumbPending(0);
      return;
    }
    busyRef.current = true;
    setThumbPending(queueRef.current.length + 1);
    try {
      const url = await captureAt(next.t);
      setMarks((prev) => {
        if (!prev.some((mk) => mk.id === next.id)) {
          if (url) URL.revokeObjectURL(url);
          return prev;
        }
        return prev.map((mk) => (mk.id === next.id ? { ...mk, thumb: url } : mk));
      });
    } catch {
      /* 缩略图失败不阻断打点 */
    } finally {
      busyRef.current = false;
      setThumbPending(queueRef.current.length);
      void pumpQueue();
    }
  }, [captureAt]);

  const enqueueThumb = useCallback(
    (id: string, time: number) => {
      queueRef.current.push({ id, t: time });
      setThumbPending(queueRef.current.length + (busyRef.current ? 1 : 0));
      void pumpQueue();
    },
    [pumpQueue]
  );

  const addMarkAt = useCallback(
    (time: number) => {
      if (!duration || loadState !== "ready") return;
      if (marks.length >= EXTRACT_TIMESTAMPS_MAX) {
        notify(t("videoExtract.maxMarks", { n: EXTRACT_TIMESTAMPS_MAX }), "info");
        return;
      }
      const key = Math.round(Math.min(Math.max(0, time), duration || time) * 1000);
      if (marks.some((mk) => Math.round(mk.t * 1000) === key)) {
        notify(t("videoExtract.duplicateMark"), "info");
        return;
      }
      const id = nextMarkId();
      const tSec = key / 1000;
      setMarks((prev) => [...prev, { id, t: tSec, thumb: null }].sort((a, b) => a.t - b.t));
      enqueueThumb(id, tSec);
    },
    [duration, enqueueThumb, loadState, marks, t]
  );

  const removeMark = (id: string) => {
    setMarks((prev) => {
      const hit = prev.find((mk) => mk.id === id);
      revokeThumb(hit?.thumb ?? null);
      return prev.filter((mk) => mk.id !== id);
    });
    queueRef.current = queueRef.current.filter((q) => q.id !== id);
  };

  const clearMarks = () => {
    marks.forEach((mk) => revokeThumb(mk.thumb));
    queueRef.current = [];
    setMarks([]);
    setThumbPending(0);
  };

  const fillRange = () => {
    const end = Math.min(rangeEnd || duration, duration);
    const times = fillTimestamps(Math.min(rangeStart, duration), end, fillFps);
    if (times.length === 0) return;
    clearMarks();
    const next: Mark[] = times.slice(0, EXTRACT_TIMESTAMPS_MAX).map((sec) => ({
      id: nextMarkId(),
      t: sec,
      thumb: null,
    }));
    setMarks(next);
    for (const mk of next) enqueueThumb(mk.id, mk.t);
    if (times.length >= EXTRACT_TIMESTAMPS_MAX) {
      notify(t("videoExtract.truncatedToMax", { n: EXTRACT_TIMESTAMPS_MAX }), "info");
    }
  };

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || loadState !== "ready") return;
    if (video.paused) void video.play();
    else video.pause();
  }, [loadState]);

  const seekBy = useCallback((delta: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(0, video.currentTime + delta), duration || video.duration || 0);
  }, [duration]);

  const onScrub = (value: number) => {
    const video = videoRef.current;
    if (!video) return;
    const next = Math.min(Math.max(0, value), duration || 0);
    video.currentTime = next;
    setCurrent(next);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // M 是弹窗级取帧快捷键：拖动时间轴或点击按钮后控件仍有焦点，也必须生效。
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        addMarkAt(videoRef.current?.currentTime ?? 0);
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, button, [contenteditable]")) return;
      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBy(-FRAME_STEP);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBy(FRAME_STEP);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addMarkAt, seekBy, togglePlay]);

  const estimatedCount = useMemo(() => {
    if (!duration) return 0;
    return fillTimestamps(Math.min(rangeStart, duration), Math.min(rangeEnd || duration, duration), fillFps).length;
  }, [duration, fillFps, rangeEnd, rangeStart]);

  const progress = duration > 0 ? Math.min(100, Math.max(0, (current / duration) * 100)) : 0;

  const retryLoad = () => {
    setPlaying(false);
    setLoadState("loading");
    setDuration(0);
    setCurrent(0);
    setLoadAttempt((n) => n + 1);
  };

  useEffect(() => {
    if (loadState !== "loading") return;
    const timer = window.setTimeout(() => setLoadState("error"), 12000);
    return () => window.clearTimeout(timer);
  }, [loadState, src]);

  const submit = async () => {
    if (marks.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      await api.extractMaterial(m.id, {
        timestamps: marks.map((mk) => mk.t),
        autoMatting,
        folderId: m.folder_id,
      });
      onToast(t("videoExtract.queued", { n: marks.length }));
      onClose();
    } catch (e) {
      notify(t("msg.extract_failed_msg", { msg: (e as Error).message }));
      setSubmitting(false);
    }
  };

  return (
    <motion.div className="modal-mask ve-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="modal pixel-panel ve-modal"
        role="dialog"
        aria-modal="true"
        initial={{ scale: 0.96, y: 20, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.96, y: 20, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ve-head">
          <div className="ve-title-block">
            <span className="ve-eyebrow">{t("videoExtract.workspace")}</span>
            <h2>{t("videoExtract.title")}</h2>
            <p>{t("videoExtract.hint", { name: m.name, max: EXTRACT_TIMESTAMPS_MAX })}</p>
          </div>
          <div className="ve-head-meta">
            <span className={`ve-status ${loadState}`}>
              <span className="dot" />
              {t(`videoExtract.${loadState}`)}
            </span>
            {duration > 0 && (
              <span className="ve-clip-meta">
                {videoSize.width}×{videoSize.height} · {formatTime(duration)}
              </span>
            )}
            <IconBtn onClick={onClose} title={t("common.close")}>
              <X size={17} />
            </IconBtn>
          </div>
        </header>

        <div className="ve-workspace">
          <section className="ve-preview-column">
            <div className={`ve-player ${loadState}`} onClick={togglePlay}>
              <video
                key={src}
                ref={videoRef}
                className="ve-video"
                src={src}
                playsInline
                preload="auto"
                onLoadedMetadata={(e) => {
                  const video = e.currentTarget;
                  const d = Number.isFinite(video.duration) ? video.duration : 0;
                  setDuration(d);
                  setRangeEnd(d);
                  setVideoSize({ width: video.videoWidth, height: video.videoHeight });
                  setLoadState("ready");
                }}
                onCanPlay={() => setLoadState("ready")}
                onError={() => setLoadState("error")}
                onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onEnded={() => setPlaying(false)}
              />
              <AnimatePresence mode="wait">
                {loadState === "loading" && (
                  <motion.div key="loading" className="ve-player-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <motion.span animate={{ rotate: 360 }} transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}>
                      <LoaderCircle size={28} />
                    </motion.span>
                    <span>{t("videoExtract.loadingHint")}</span>
                  </motion.div>
                )}
                {loadState === "error" && (
                  <motion.div key="error" className="ve-player-state error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Film size={30} />
                    <strong>{t("videoExtract.loadFailed")}</strong>
                    <span>{t("videoExtract.loadFailedHint")}</span>
                    <button type="button" className="px-btn mini" onClick={retryLoad}>
                      <RotateCcw size={13} /> {t("videoExtract.retry")}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="ve-transport">
              <div className="ve-transport-buttons">
                <IconBtn disabled={!duration} onClick={() => seekBy(-FRAME_STEP)} title={t("videoExtract.stepBack")}>
                  <SkipBack size={15} />
                </IconBtn>
                <motion.button type="button" className="ve-play-btn" whileTap={{ scale: 0.92 }} disabled={!duration} onClick={togglePlay}>
                  {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
                </motion.button>
                <IconBtn disabled={!duration} onClick={() => seekBy(FRAME_STEP)} title={t("videoExtract.stepForward")}>
                  <SkipForward size={15} />
                </IconBtn>
              </div>
              <div className="ve-timecode">
                <strong>{formatTime(current)}</strong>
                <span>/ {formatTime(duration)}</span>
              </div>
              <label className="ve-precise">
                <span>{t("videoExtract.preciseTime")}</span>
                <input
                  className="px-input num"
                  type="number"
                  min={0}
                  max={duration || 0}
                  step={0.001}
                  value={Number(current.toFixed(3))}
                  disabled={!duration}
                  onChange={(e) => onScrub(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="ve-timeline">
              <div className="ve-timeline-progress" style={{ width: `${progress}%` }} />
              {duration > 0 &&
                marks.map((mk, i) => (
                  <button
                    key={mk.id}
                    type="button"
                    className="ve-timeline-mark"
                    style={{ left: `${Math.min(100, (mk.t / duration) * 100)}%` }}
                    title={`${i + 1} · ${formatTime(mk.t)}`}
                    onClick={() => onScrub(mk.t)}
                  />
                ))}
              <input
                className="ve-scrub"
                type="range"
                min={0}
                max={duration || 0}
                step={0.001}
                value={Math.min(current, duration || 0)}
                disabled={!duration}
                aria-label={t("videoExtract.timeline")}
                onChange={(e) => onScrub(Number(e.target.value))}
              />
            </div>
            <div className="ve-shortcuts">
              <Keyboard size={13} />
              <span>{t("videoExtract.shortcuts")}</span>
              <kbd>Space</kbd>
              <kbd>←</kbd>
              <kbd>→</kbd>
              <kbd>M</kbd>
            </div>
          </section>

          <aside className="ve-side">
            <section className="ve-panel ve-quick-panel">
              <div className="ve-panel-head">
                <div>
                  <span className="ve-panel-kicker">01</span>
                  <h3>{t("videoExtract.quickMark")}</h3>
                </div>
                <span className="ve-count">{marks.length}/{EXTRACT_TIMESTAMPS_MAX}</span>
              </div>
              <p>{t("videoExtract.quickMarkHint")}</p>
              <div className="ve-current-frame">
                <span>{t("videoExtract.currentFrame")}</span>
                <strong>{formatTime(current)}</strong>
              </div>
              <motion.button
                type="button"
                className="px-btn accent ve-mark-now"
                whileTap={{ scale: 0.96 }}
                disabled={!duration || submitting || marks.length >= EXTRACT_TIMESTAMPS_MAX}
                onClick={() => addMarkAt(videoRef.current?.currentTime ?? current)}
              >
                <Plus size={15} /> {t("videoExtract.mark")}
                <kbd>M</kbd>
              </motion.button>
            </section>

            <section className="ve-panel ve-range">
              <div className="ve-panel-head">
                <div>
                  <span className="ve-panel-kicker">02</span>
                  <h3>{t("videoExtract.batchTitle")}</h3>
                </div>
                <span className="ve-count">≈ {estimatedCount}</span>
              </div>
              <p>{t("videoExtract.batchHint")}</p>
              <div className="ve-range-grid">
                <label className="ve-num">
                  <span>{t("videoExtract.start")}</span>
                  <input
                    className="px-input num"
                    type="number"
                    min={0}
                    max={duration || 0}
                    step={0.01}
                    value={rangeStart}
                    disabled={submitting}
                    onChange={(e) => setRangeStart(Number(e.target.value))}
                  />
                  <button type="button" disabled={!duration || submitting} onClick={() => setRangeStart(current)}>
                    {t("videoExtract.useCurrent")}
                  </button>
                </label>
                <label className="ve-num">
                  <span>{t("videoExtract.end")}</span>
                  <input
                    className="px-input num"
                    type="number"
                    min={0}
                    max={duration || 0}
                    step={0.01}
                    value={rangeEnd}
                    disabled={submitting}
                    onChange={(e) => setRangeEnd(Number(e.target.value))}
                  />
                  <button type="button" disabled={!duration || submitting} onClick={() => setRangeEnd(current)}>
                    {t("videoExtract.useCurrent")}
                  </button>
                </label>
                <label className="ve-num">
                  <span>FPS</span>
                  <input
                    className="px-input num"
                    type="number"
                    min={1}
                    max={24}
                    value={fillFps}
                    disabled={submitting}
                    onChange={(e) => setFillFps(Math.min(24, Math.max(1, Number(e.target.value) || 1)))}
                  />
                  <span className="ve-num-note">{t("videoExtract.estimated", { n: estimatedCount })}</span>
                </label>
              </div>
              <button type="button" className="px-btn ve-fill-btn" disabled={submitting || !duration} onClick={fillRange}>
                {t("videoExtract.applyFill")}
              </button>
            </section>
          </aside>
        </div>

        <section className="ve-selection">
          <div className="ve-selection-head">
            <div>
              <span className="ve-eyebrow">{t("videoExtract.selection")}</span>
              <h3>{t("videoExtract.marks", { n: marks.length, max: EXTRACT_TIMESTAMPS_MAX })}</h3>
            </div>
            <div className="ve-selection-actions">
              {thumbPending > 0 && <span className="ve-thumb-status">{t("videoExtract.thumbQueue", { n: thumbPending })}</span>}
              {marks.length > 0 && (
                <button type="button" className="ve-clear" disabled={submitting} onClick={clearMarks}>
                  <Trash2 size={12} /> {t("common.clear")}
                </button>
              )}
            </div>
          </div>
          <div className={`ve-marks ${marks.length === 0 ? "empty" : ""}`}>
            {marks.length === 0 ? (
              <div className="ve-empty-selection">
                <Plus size={18} />
                <span>{t("videoExtract.marksEmpty")}</span>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {marks.map((mk, i) => (
                  <motion.div
                    layout
                    key={mk.id}
                    className="ve-mark"
                    title={formatTime(mk.t)}
                    initial={{ opacity: 0, scale: 0.88, x: 12 }}
                    animate={{ opacity: 1, scale: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.88 }}
                  >
                    <button type="button" className="ve-mark-thumb" disabled={submitting} onClick={() => onScrub(mk.t)}>
                      {mk.thumb ? <img src={mk.thumb} alt="" draggable={false} /> : <span className="ve-mark-ph">…</span>}
                    </button>
                    <span className="ve-mark-i">{String(i + 1).padStart(2, "0")}</span>
                    <span className="ve-mark-t">{formatTime(mk.t)}</span>
                    <IconBtn disabled={submitting} onClick={() => removeMark(mk.id)} title={t("common.delete")}>
                      <X size={12} />
                    </IconBtn>
                  </motion.div>
                ))}
              </AnimatePresence>
            )}
          </div>
        </section>

        <footer className="ve-footer">
          <MattingOption checked={autoMatting} onChange={setAutoMatting} />
          <span className="ve-footer-summary">{t("videoExtract.readyCount", { n: marks.length })}</span>
          <motion.button
            type="button"
            className="px-btn accent ve-submit"
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.96 }}
            disabled={marks.length === 0 || submitting}
            onClick={() => void submit()}
          >
            <Film size={15} /> {submitting ? t("common.submitting") : t("videoExtract.submit", { n: marks.length })}
          </motion.button>
        </footer>

        <video ref={thumbVideoRef} className="ve-thumb-source" src={src} muted playsInline preload="auto" aria-hidden />
      </motion.div>
    </motion.div>
  );
}
