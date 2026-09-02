import { motion } from "motion/react";
import { Package, Settings, Zap } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import LangToggle from "./LangToggle";
import NoticeHistory from "./NoticeHistory";
import { useT } from "../i18n";

type Page = "pipeline" | "materials" | "settings";

interface Props {
  current: Page;
  onNav: (page: Page) => void;
}

/**
 * 顶部一级导航：加工流水线 / 素材库 / 设置。
 *
 * 品牌位是纯标识；流水线页签是唯一的首页导航入口。
 */
export default function TopNav({ current, onNav }: Props) {
  const t = useT();
  const tabs = [
    { id: "pipeline" as const, icon: Zap, label: t("nav.pipeline") },
    { id: "materials" as const, icon: Package, label: t("msg.materials") },
    { id: "settings" as const, icon: Settings, label: t("msg.settings") },
  ];

  return (
    <nav className="top-nav">
      <div className="brand brand--static">
        <span className="brand-mark">
          <Zap size={16} />
        </span>
        <span>{t("app.name")}</span>
      </div>
      <div className="nav-tabs">
        {tabs.map(({ id, icon: Icon, label }) => (
          <motion.button
            key={id}
            type="button"
            className={`nav-tab ${current === id ? "active" : ""}`}
            whileTap={{ scale: 0.96 }}
            onClick={() => onNav(id)}
          >
            <Icon size={14} />
            <span>{label}</span>
            {current === id && <motion.span className="nav-active-rail" layoutId="nav-active-rail" />}
          </motion.button>
        ))}
      </div>
      <div className="spacer" />
      <div className="nav-tools">
        <NoticeHistory />
        <LangToggle />
        <ThemeToggle />
      </div>
    </nav>
  );
}
