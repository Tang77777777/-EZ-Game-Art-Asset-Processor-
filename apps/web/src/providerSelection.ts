import type { GenProviderInfo } from "@ezgameart/shared";
import { pickPreferredVideoModel } from "@ezgameart/shared";

export interface ProviderSelectionOptions { videoOnly?: boolean; preferI2v?: boolean }

export function isProviderEligible(provider: GenProviderInfo, options: ProviderSelectionOptions = {}) {
  return options.videoOnly
    ? provider.type === "cli" || (!!provider.video && provider.videoModels.length > 0)
    : provider.type === "cli" || provider.imageModels.length > 0 || provider.type === "api";
}

/** Picker、尺寸和提交共用的唯一选择规则；永不回退到未配置项。 */
export function resolveProviderSelection(
  providers: GenProviderInfo[], providerId: string, model: string, options: ProviderSelectionOptions = {}
): { providerId?: string; model?: string } {
  const configured = providers.filter((provider) => provider.configured && isProviderEligible(provider, options));
  const explicit = configured.find((provider) => provider.id === providerId);
  const withModels = configured.find((provider) => (options.videoOnly ? provider.videoModels : provider.imageModels).length > 0);
  const provider = explicit
    ?? withModels
    ?? configured.find((provider) => provider.type === "cli")
    ?? configured.find((provider) => provider.type === "api");
  if (!provider) return {};
  const models = options.videoOnly ? provider.videoModels : provider.imageModels;
  let selectedModel = model.trim();
  if (models.length && !models.includes(selectedModel)) {
    selectedModel = options.videoOnly ? pickPreferredVideoModel(models, { preferI2v: options.preferI2v }) : models[0]!;
  }
  return { providerId: provider.id, model: selectedModel || undefined };
}
