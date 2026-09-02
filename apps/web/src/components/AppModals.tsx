import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { dismissNotice, settleConfirm, useNoticeState } from "../notice";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";

/** 全局通知条 + 确认弹窗（挂载在 App 根部；像素风，替代浏览器默认弹窗） */
export default function AppModals() {
  const { notices, confirm } = useNoticeState();
  const t = useT();
  const confirmTextId = useId();
  useModalEscClose(() => settleConfirm(false), !!confirm);

  return (
    <>
      {/* 通知条：底部居中堆叠，点击关闭 */}
      <div className="toast-stack">
        <AnimatePresence>
          {notices.map((n) => (
            <motion.div
              key={n.id}
              className={`toast pixel-panel toast-item ${n.kind}`}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 16 }}
              onClick={() => dismissNotice(n.id)}
            >
              {n.kind === "error" ? <CircleAlert size={14} /> : <Info size={14} />}
              <span>{n.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      {/* 确认弹窗 */}
      <AnimatePresence>
        {confirm && (
          <motion.div
            className="modal-mask confirm-mask"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => settleConfirm(false)}
          >
            <motion.div
              className="modal pixel-panel confirm-modal"
              role="alertdialog"
              aria-modal="true"
              aria-label={t("common.confirm")}
              aria-describedby={confirmTextId}
              initial={{ scale: 0.92, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.92, y: 24 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="confirm-text">
                <AlertTriangle size={18} />
                <span id={confirmTextId}>{confirm.text}</span>
              </div>
              <div className="modal-actions">
                <button type="button" className="px-btn" onClick={() => settleConfirm(false)}>
                  {t("common.cancel")}
                </button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn danger"
                  autoFocus
                  onClick={() => settleConfirm(true)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") settleConfirm(true);
                  }}
                >
                  {t("msg.ok_f526c8")}
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
