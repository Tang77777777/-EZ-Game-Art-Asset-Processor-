import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../i18n";

export interface PxSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  value: string;
  options: PxSelectOption[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}

type ListPos = { top: number; left: number; width: number; maxHeight: number; openUp: boolean };

/**
 * 像素风下拉选择（替代原生 select）：
 * 列表用 fixed 定位，避免被 .modal 的 overflow 裁切；下方空间不足时向上展开。
 */
export default function PxSelect({ value, options, onChange, placeholder, className = "", disabled }: Props) {
  const t = useT();
  const ph = placeholder ?? t("msg.select");
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<ListPos | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);

  const updatePos = () => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const gap = 6;
    const pad = 8;
    const below = window.innerHeight - r.bottom - gap - pad;
    const above = r.top - gap - pad;
    const want = Math.min(240, options.length * 36 + 8);
    const openUp = below < Math.min(120, want) && above > below;
    const maxHeight = Math.max(96, Math.min(240, openUp ? above : below));
    setPos({
      top: openUp ? r.top - gap : r.bottom + gap,
      left: r.left,
      width: r.width,
      maxHeight,
      openUp,
    });
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePos();
    const onReposition = () => updatePos();
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const listStyle: CSSProperties = pos
    ? pos.openUp
      ? {
          top: pos.top,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
          transform: "translateY(-100%)",
        }
      : {
          top: pos.top,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
        }
    : { visibility: "hidden" };

  return (
    <div ref={wrapRef} className={`px-select ${className}${open ? " open" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className="px-select-btn"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={current ? "" : "px-select-ph"}>{current?.label ?? ph}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <ul className={`px-select-list${pos?.openUp ? " up" : ""}`} style={listStyle} role="listbox">
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`px-select-opt${o.value === value ? " on" : ""}`}
                disabled={o.disabled}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
