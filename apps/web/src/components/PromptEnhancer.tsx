import { useEffect, useState } from "react";
import { Wand2, X } from "lucide-react";
import { ENHANCE_STYLES } from "@ezgameart/shared";
import { api } from "../api";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import PxSelect from "./PxSelect";

interface Props {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  mediaKind?: "image" | "video";

  referenceImageCount?: number;

}

interface EnhanceResult {
  original: string;
  enhanced: string;
  enhancerName: string;
  styleLabel: string;
}

/**
 * 提示词输入行 + 「优化提示词」：调用设置页配置的加强模型，
 * 原/优化后提示词并排展示，由用户点按钮决定用哪版（原文永不覆盖）
 */

export default function PromptEnhancer({ label, placeholder, value, onChange, mediaKind = "image", referenceImageCount = 0 }: Props) {

  const t = useT();
  const cfg = useServerConfig();
  const enhancers = cfg?.promptEnhancers ?? [];
  const [enhancerId, setEnhancerId] = useState("");
  const [style, setStyle] = useState<string>(ENHANCE_STYLES[0].id);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<EnhanceResult | null>(null);

  useEffect(() => setResult(null), [mediaKind, referenceImageCount]);

  const run = async () => {
    if (!value.trim() || busy) return;
    if (enhancers.length === 0) {
      notify(t("msg.no_prompt_enhancer_add_one_in_settings"));
      return;
    }
    setBusy(true);
    try {

      const r = await api.enhancePrompt(enhancerId || undefined, value.trim(), style, mediaKind, referenceImageCount);

      // original 快照保留发起时的原文，之后用户怎么改输入框都不影响对比
      setResult({
        original: value.trim(),
        enhanced: r.enhanced,
        enhancerName: r.enhancerName,
        styleLabel: ENHANCE_STYLES.find((s) => s.id === style)?.label ?? style,
      });
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form-row">
      <label>{label}</label>
      <textarea
        className="px-input px-textarea enhance-prompt"
        rows={3}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="form-inline enhance-bar">
        <PxSelect
          className="enhance-style"
          value={style}
          options={ENHANCE_STYLES.map((s) => ({ value: s.id, label: t(s.label) }))}
          onChange={(next) => {
            setStyle(next);
            setResult(null);
          }}
        />
        {enhancers.length > 1 && (
          <PxSelect
            className="enhance-model"
            value={enhancerId || enhancers[0]?.id || ""}
            options={enhancers.map((e) => ({ value: e.id, label: e.name }))}
            onChange={(next) => {
              setEnhancerId(next);
              setResult(null);
            }}
          />
        )}
        <button
          type="button"
          className="px-btn mini enhance-btn"
          disabled={busy || !value.trim()}
          title={enhancers.length ? t("msg.enhance_with_name", { name: enhancers.find((e) => e.id === (enhancerId || enhancers[0]?.id))?.name ?? "" }) : t("msg.add_a_prompt_enhancer_in_settings_first")}
          onClick={run}
        >
          <Wand2 size={12} /> {busy ? t("msg.enhancing") : t("msg.enhance_prompt")}
        </button>
      </div>

      {result && (
        <div className="enhance-panel">
          <div className="enhance-head">
            <span>{t("msg.enhanced_by_enhancer_style_which_to_use_original_kept", { enhancer: result.enhancerName, style: t(result.styleLabel) })}</span>
            <IconBtn title={t("msg.close_compare")} onClick={() => setResult(null)}>
              <X size={14} />
            </IconBtn>
          </div>
          <div className="enhance-grid">
            <div className="enhance-block">
              <div className="enhance-tag">{t("msg.original_prompt")}</div>
              <div className="enhance-text">{result.original}</div>
              <button
                type="button"
                className={`px-btn mini ${value === result.original ? "accent" : ""}`}
                onClick={() => onChange(result.original)}
              >
                {value === result.original ? t("msg.in_use") : t("msg.use_original")}
              </button>
            </div>
            <div className="enhance-block">
              <div className="enhance-tag new">{t("msg.enhanced")}</div>
              <div className="enhance-text">{result.enhanced}</div>
              <button
                type="button"
                className={`px-btn mini ${value === result.enhanced ? "accent" : ""}`}
                onClick={() => onChange(result.enhanced)}
              >
                {value === result.enhanced ? t("msg.in_use") : t("msg.use_enhanced")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
