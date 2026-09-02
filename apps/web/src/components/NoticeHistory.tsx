import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, CircleAlert, Info, Trash2 } from "lucide-react";
import { clearNoticeHistory, markNoticeHistorySeen, useNoticeState } from "../notice";
import { getLocale, useT } from "../i18n";
import IconBtn from "./IconBtn";

/**
 * 右上角消息历史：查看已弹出过的 notify；未读角标；打开即标已读。
 * 挂在 TopNav / 编辑器顶栏均可。
 */
export default function NoticeHistory() {
  const t = useT();
  const { history, unread } = useNoticeState();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    markNoticeHistorySeen();
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((o) => {
      if (!o) markNoticeHistorySeen();
      return !o;
    });
  };

  return (
    <div className="notice-hist" ref={wrapRef}>
      <motion.button
        type="button"
        whileHover={{ scale: 1.12 }}
        whileTap={{ scale: 0.85 }}
        className={`icon-btn notice-hist-btn ${open ? "on" : ""}`}
        title={t("msg.message_history")}
        aria-expanded={open}
        aria-controls={panelId}
        aria-haspopup="dialog"
        onClick={toggle}
      >
        <Bell size={16} />
        {unread > 0 && <span className="notice-hist-badge">{unread > 9 ? "9+" : unread}</span>}
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            id={panelId}
            className="notice-hist-panel pixel-panel"
            role="dialog"
            aria-modal="false"
            aria-labelledby={titleId}
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: 0.12 }}
          >
            <div className="notice-hist-head">
              <span id={titleId}>{t("msg.message_history")}</span>
              <IconBtn
                title={t("msg.clear_history")}
                disabled={history.length === 0}
                onClick={() => {
                  clearNoticeHistory();
                }}
              >
                <Trash2 size={13} />
              </IconBtn>
            </div>
            {history.length === 0 ? (
              <div className="notice-hist-empty">{t("msg.no_messages_yet")}</div>
            ) : (
              <ul className="notice-hist-list">
                {[...history].reverse().map((h) => (
                  <li key={h.id} className={`notice-hist-item ${h.kind}`}>
                    {h.kind === "error" ? <CircleAlert size={13} /> : <Info size={13} />}
                    <div className="notice-hist-body">
                      <div className="notice-hist-text">{h.text}</div>
                      <div className="notice-hist-time">{new Date(h.at).toLocaleString(getLocale())}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
