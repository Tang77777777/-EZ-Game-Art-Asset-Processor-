import { motion } from "motion/react";
import { Languages } from "lucide-react";
import { getLang, setLang, useT } from "../i18n";

/** 界面语言切换按钮：中文 ⇄ English */
export default function LangToggle() {
  const t = useT();
  const lang = getLang();
  return (
    <motion.button
      type="button"
      whileHover={{ scale: 1.12 }}
      whileTap={{ scale: 0.85 }}
      className="icon-btn"
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
      title={t("msg.language_click_to_switch")}
    >
      <Languages size={16} />
      <span style={{ fontSize: 11, marginLeft: 2 }}>{lang === "zh" ? "中" : "EN"}</span>
    </motion.button>
  );
}
