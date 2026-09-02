import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { cycleThemeMode, getThemeMode, onThemeChange, type ThemeMode } from "../theme";
import { useT } from "../i18n";

const MODE_META: Record<ThemeMode, { label: string; Icon: typeof Sun }> = {
  light: { label: "theme.light", Icon: Sun },
  dark: { label: "theme.dark", Icon: Moon },
};

/** 主题切换按钮：二态循环（深色 ↔ 浅色） */
export default function ThemeToggle() {
  const t = useT();
  // 主题切换会触发重渲染，让图标和辅助文本同步更新
  const [mode, setMode] = useState<ThemeMode>(getThemeMode);
  useEffect(() => onThemeChange(() => setMode(getThemeMode())), []);

  const { Icon } = MODE_META[mode];
  const targetLabel = mode === "dark" ? t("theme.light") : t("theme.dark");
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.12 }}
      whileTap={{ scale: 0.85, rotate: -20 }}
      className="icon-btn"
      aria-label={targetLabel}
      aria-pressed={mode === "dark"}
      onClick={() => {
        cycleThemeMode();
        setMode(getThemeMode());
      }}
      title={t("msg.theme_switch_to", { label: targetLabel })}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={mode}
          initial={{ rotate: -90, opacity: 0 }}
          animate={{ rotate: 0, opacity: 1 }}
          exit={{ rotate: 90, opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ display: "inline-flex" }}
        >
          <Icon size={16} />
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
