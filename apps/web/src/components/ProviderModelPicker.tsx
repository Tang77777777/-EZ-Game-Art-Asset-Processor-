import type { GenProviderInfo } from "@ezgameart/shared";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { isProviderEligible, resolveProviderSelection } from "../providerSelection";
import PxSelect from "./PxSelect";

export { resolveProviderSelection } from "../providerSelection";

interface Props {
  providerId: string;
  model: string;
  onProviderChange: (id: string) => void;
  onModelChange: (m: string) => void;
  /** 视频模式：只列出支持视频生成的 provider（CLI / 百炼 / MiniMax） */
  videoOnly?: boolean;
  /** 视频模式且有引用图时，优先选 i2v（如 happyhorse-1.1-i2v） */
  preferI2v?: boolean;
}

const TYPE_LABEL: Record<GenProviderInfo["type"], string> = {
  cli: "CLI",
  api: "API",
  dashscope: "msg.bailian",
  gemini: "banana",
  minimax: "MiniMax",
};

/** 生成弹窗共用：provider 选择（设置页可配多个，CLI/API 共存）+ 生成时单独选模型 */
export default function ProviderModelPicker({
  providerId,
  model,
  onProviderChange,
  onModelChange,
  videoOnly,
  preferI2v,
}: Props) {
  const t = useT();
  const cfg = useServerConfig();
  const providers = (cfg?.gen.providers ?? []).filter((p) => isProviderEligible(p, { videoOnly }));

  const selection = resolveProviderSelection(providers, providerId, model, { videoOnly, preferI2v });
  if (cfg && !selection.providerId) {
    return videoOnly ? (
      <div className="hint warn">{t("msg.no_video_gen_provider_cli_bailian_minimax_add_in_setting")}</div>
    ) : (
      <div className="hint warn">{t("msg.no_gen_provider_add_cli_api_providers_in_settings")}</div>
    );
  }
  const provider = providers.find((p) => p.id === selection.providerId);
  if (!provider) return null;
  const effectiveModel = selection.model ?? "";

  return (
    <div className="form-row">
      <label>{t("msg.gen_provider_model_manage_in_settings")}</label>
      <div className="form-inline">
        <PxSelect
          value={provider.id}
          options={providers.map((p) => ({
            value: p.id,
            label: `${p.name}（${t(TYPE_LABEL[p.type])}${p.configured ? "" : t("msg.incomplete")}）`,
            disabled: !p.configured,
          }))}
          onChange={(id) => {
            onProviderChange(id);
            onModelChange("");
          }}
        />
        {provider.type !== "cli" ? (
          (videoOnly ? provider.videoModels : provider.imageModels).length > 0 ? (
            <PxSelect value={effectiveModel} options={(videoOnly ? provider.videoModels : provider.imageModels).map((m) => ({ value: m, label: m }))} onChange={onModelChange} />
          ) : (
            <input
              className="px-input"
              placeholder={t("msg.model_name_required")}
              value={model}
              onChange={(e) => onModelChange(e.target.value)}
            />
          )
        ) : (
          <input
            className="px-input"
            placeholder={t("msg.model_via_model_arg_name_optional")}
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
          />
        )}
      </div>
    </div>
  );
}
