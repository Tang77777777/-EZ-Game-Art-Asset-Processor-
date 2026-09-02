import type { MattingEngine } from "@ezgameart/shared";
import { useServerConfig } from "../config";
import { useT, t } from "../i18n";

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
}

function engineText(engine: MattingEngine, model: string): string {
  switch (engine) {
    case "custom-cli":
      return t("msg.engine_custom_cli");
    case "rembg-bundled":
      return t("msg.engine_rembg_model", { model });
    case "rembg-path":
      return t("msg.engine_rembg_model_path", { model });
    default:
      return "";
  }
}

/** 「抠图去背」显眼开关行 + 引擎状态指示（绿点可用 / 红点缺失） */
export default function MattingOption({ checked, onChange }: Props) {
  useT(); // 订阅语言切换，engineText 用模块级 t 读实时语言
  const cfg = useServerConfig();
  const engine = cfg?.matting.engine;
  const available = engine != null && engine !== "none";

  return (
    <div className="matting-option">
      <label className="px-check matting-check">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="matting-label">{t("msg.matte_remove_background")}</span>
      </label>
      <span className={`engine-status ${available ? "ok" : "bad"}`}>
        <span className="dot" />
        {engine == null ? t("msg.detecting_engine") : available ? engineText(engine, cfg!.matting.model) : t("msg.no_matting_engine_will_copy_original_only")}
      </span>
    </div>
  );
}
