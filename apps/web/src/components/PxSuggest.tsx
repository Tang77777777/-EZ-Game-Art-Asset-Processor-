import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../i18n";

interface Props {
  value: string;
  /** 建议项（可自由输入，不限于列表） */
  suggestions: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}

type ListPos = { top: number; left: number; width: number; maxHeight: number; openUp: boolean };

/**
 * 带主题化建议下拉的输入框（替代原生 datalist——原生弹层不吃主题样式）：
 * 输入时按子串过滤建议；聚焦/点箭头展开全部（不按当前值过滤）；蒙层点击 / Esc 关闭；点建议项回填
 */
export default function PxSuggest({ value, suggestions, onChange, placeholder, className = "" }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<ListPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // 过滤词：仅输入时跟随键入内容；聚焦/点箭头展开时清空（否则已有值会把建议过滤光）
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions;
    return list.filter((s) => s !== value); // 已完全一致的建议不再占位
  }, [query, value, suggestions]);

  const updatePos = () => {
    const root = rootRef.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const gap = 6;
    const pad = 8;
    const below = window.innerHeight - r.bottom - gap - pad;
    const above = r.top - gap - pad;
    const want = Math.min(240, filtered.length * 36 + 8);
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
    if (!open || filtered.length === 0) {
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
  }, [open, filtered.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
    <div ref={rootRef} className={`px-suggest ${className}`}>
      <input
        className="px-input"
        value={value}
        placeholder={placeholder}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setQuery(e.target.value);
          setOpen(true);
        }}
      />
      <button
        type="button"
        className="px-suggest-toggle"
        title={t("msg.show_suggestions")}
        tabIndex={-1}
        onClick={() => {
          setQuery("");
          setOpen((o) => !o);
        }}
      >
        <ChevronDown size={14} />
      </button>
      {open && filtered.length > 0 && (
        <>
          <div className="px-select-mask" onClick={() => setOpen(false)} />
          <ul className={`px-select-list${pos?.openUp ? " up" : ""}`} style={listStyle}>
            {filtered.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className="px-select-opt"
                  onClick={() => {
                    onChange(s);
                    setQuery("");
                    setOpen(false);
                  }}
                >
                  {s}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
