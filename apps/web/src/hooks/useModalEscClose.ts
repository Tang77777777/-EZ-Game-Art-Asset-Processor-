import { useEffect } from "react";

/** 打开中的弹窗关闭回调栈（后进先出）；Esc 只关最上层 */
const escStack: Array<() => void> = [];

/**
 * 弹窗关闭约定：仅 Esc / 显式关闭或取消按钮关闭，点蒙层不关。
 * 嵌套弹窗时 Esc 只关闭最上层。
 */
export function useModalEscClose(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    escStack.push(onClose);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (escStack[escStack.length - 1] !== onClose) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      const i = escStack.lastIndexOf(onClose);
      if (i >= 0) escStack.splice(i, 1);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, enabled]);
}
