import { useRef, useState, useCallback } from "react";
import { AnimatePresence, motion } from "motion/react";
import { LoaderCircle, Pause, Play } from "lucide-react";
import { useT } from "../i18n";

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0:00";
  const m = Math.floor(s / 60);
  const sec = Math.floor(s - m * 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

interface Props {
  src: string;
  /** 强制重新加载的 key */
  videoKey?: string;
  className?: string;
}

/** 像素风自定义视频播放器：棋盘背景 + 点击播放/暂停 + 主题进度条 */
export default function VideoPlayer({ src, videoKey, className = "" }: Props) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video || loadState !== "ready") return;
    if (video.paused) void video.play();
    else video.pause();
  }, [loadState]);

  const seek = (e: React.PointerEvent) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const bar = e.currentTarget as HTMLDivElement;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    video.currentTime = ratio * duration;
  };

  return (
    <div className={`vp ${className}`}>
      <div className={`vp-player ${loadState}`} onClick={togglePlay}>
        <video
          key={videoKey}
          ref={videoRef}
          className="vp-video"
          src={src}
          playsInline
          preload="metadata"
          onLoadedMetadata={(e) => {
            const d = Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0;
            setDuration(d);
            setLoadState("ready");
          }}
          onCanPlay={() => setLoadState("ready")}
          onError={() => setLoadState("error")}
          onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
        <AnimatePresence>
          {loadState === "loading" && (
            <motion.div key="loading" className="vp-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <motion.span animate={{ rotate: 360 }} transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}>
                <LoaderCircle size={28} />
              </motion.span>
            </motion.div>
          )}
          {loadState === "error" && (
            <motion.div key="error" className="vp-state error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <span>{t("videoExtract.loadFailed")}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="vp-transport">
        <motion.button type="button" className="vp-play-btn" whileTap={{ scale: 0.92 }} disabled={loadState !== "ready"} onClick={togglePlay}>
          {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
        </motion.button>
        <div
          className="vp-seek"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seek(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seek(e);
          }}
        >
          <div className="vp-seek-fill" style={{ width: `${duration ? (current / duration) * 100 : 0}%` }} />
        </div>
        <div className="vp-timecode">
          <strong>{formatTime(current)}</strong>
          <span>/ {formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
}
