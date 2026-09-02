import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";

export interface CtxMenuItem {
  label: string;
  icon?: ReactNode;
  /** 危险项（删除等）红色 */
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}

interface Props {
  /** 光标位置（clientX/Y） */
  x: number;
  y: number;
  items: CtxMenuItem[];
  onClose: () => void;
}

/**
 * 通用右键菜单：fixed 定位在光标处（视口右/下边缘自动收拢）。
 * 点击菜单外 / Esc / 任意滚动 / 窗口失焦均关闭；点菜单项先关闭再执行动作（动作可开弹窗）。
 */
export default function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 首帧按光标位置渲染，测量后在绘制前收拢到视口内（无闪烁）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  return (
    <motion.div
      ref={ref}
      className="ctx-menu pixel-panel"
      style={{ left: pos.x, top: pos.y }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ duration: 0.1 }}
    >
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className={`ctx-item ${it.danger ? "danger" : ""}`}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            void it.onClick();
          }}
        >
          {it.icon}
          <span>{it.label}</span>
        </button>
      ))}
    </motion.div>
  );
}
