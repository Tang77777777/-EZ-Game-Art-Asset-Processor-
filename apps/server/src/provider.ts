import type { GenProvider, GenProviderType, ImageLayerSettings, MattingSettings, PromptEnhancer, VideoInputMode } from "@ezgameart/shared";
import { GEN_PROVIDER_TYPES, VIDEO_INPUT_MODES } from "@ezgameart/shared";
import { db } from "./db";
import { readEnvTrimmed } from "./env";

// 生成 / 抠图 / 提示词加强的运行配置：设置页（settings 表）优先，环境变量兜底
// 生成 provider 为列表模型：CLI 与 API 系可配置多个共存，生成时按 id 选择、模型单独指定

/** 读 settings 表单个 key 并 JSON.parse；缺失/非法返回 null */
export function getSettingJson<T>(key: string): T | null {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

const ENV_GEN_CLI = () => readEnvTrimmed("GEN_CLI");

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : [];
const VIDEO_MODEL = /(?:^|[-_])(t2v|i2v|r2v|video)(?:[-_]|$)|hailuo|happyhorse|minimax-h\d/i;

export type RuntimeGenProvider = GenProvider & { apiModels: string[]; apiSize: string };

/**
 * 归一化视频模型输入形态声明：丢弃非法键值，空表返回 undefined。
 * settings 是用户可写的自由 JSON，这里必须挡住不认识的取值，
 * 否则会一路带到 generateApi 的分支判断里。
 */
function videoModelModes(raw: unknown): Record<string, VideoInputMode> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, VideoInputMode> = {};
  for (const [model, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (!model.trim()) continue;
    if (typeof mode !== "string") continue;
    if (!(VIDEO_INPUT_MODES as readonly string[]).includes(mode)) continue;
    out[model] = mode as VideoInputMode;
  }
  return Object.keys(out).length ? out : undefined;
}

/** 归一化一个 provider 条目（settings 里可能缺字段/类型不对） */
function normalizeProvider(raw: unknown): RuntimeGenProvider | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<GenProvider>;
  if (typeof p.id !== "string" || !p.id) return null;
  const type = GEN_PROVIDER_TYPES.includes(p.type as GenProviderType) ? (p.type as GenProviderType) : "cli";
  const legacy = strings(p.apiModels);
  const hasNewModels = Array.isArray(p.imageModels) || Array.isArray(p.videoModels) || Array.isArray(p.textModels);
  const legacyVideo = type === "api" || type === "gemini" ? [] : legacy.filter((m) => VIDEO_MODEL.test(m));
  const legacyImage = legacy.filter((m) => !legacyVideo.includes(m));
  const legacySize = str(p.apiSize);
  return {
    id: p.id,
    name: typeof p.name === "string" && p.name.trim() ? p.name.trim() : p.id,
    type,
    cliBin: str(p.cliBin),
    cliPromptArg: str(p.cliPromptArg),
    cliOutputArg: str(p.cliOutputArg),
    cliModelArg: str(p.cliModelArg),
    cliReferenceArg: str(p.cliReferenceArg),
    cliExtraArgs: str(p.cliExtraArgs),
    legacyTemplate: typeof p.legacyTemplate === "string" && p.legacyTemplate ? p.legacyTemplate : undefined,
    apiBaseUrl: str(p.apiBaseUrl),
    apiKey: str(p.apiKey),
    imageModels: hasNewModels ? strings(p.imageModels) : legacyImage,
    videoModels: hasNewModels ? strings(p.videoModels) : legacyVideo,
    textModels: hasNewModels ? strings(p.textModels) : [],
    videoModelModes: videoModelModes(p.videoModelModes),
    imageSize: str(p.imageSize) || legacySize,
    videoSize: str(p.videoSize) || legacySize,
    apiModels: legacy,
    apiSize: legacySize,
  };
}

/**
 * 全部生成 provider：settings 表 genProviders 列表；
 * 列表为空且 env EZGAMEART_GEN_CLI 有值时，合成一个 id="env" 的 CLI provider 兜底
 * （env 走遗留模板路径：{prompt} {output} {index} {reference} {model} 占位符）
 */
export function getGenProviders(): RuntimeGenProvider[] {
  const saved = getSettingJson<unknown[]>("genProviders");
  const list = Array.isArray(saved) ? saved.map(normalizeProvider).filter((p): p is RuntimeGenProvider => p !== null) : [];
  if (list.length === 0 && ENV_GEN_CLI()) {
    return [
      {
        id: "env",
        name: "环境变量 CLI",
        type: "cli",
        cliBin: "",
        cliPromptArg: "",
        cliOutputArg: "",
        cliModelArg: "",
        cliReferenceArg: "",
        cliExtraArgs: "",
        legacyTemplate: ENV_GEN_CLI(),
        apiBaseUrl: "",
        apiKey: "",
        imageModels: [], videoModels: [], textModels: [], imageSize: "", videoSize: "", apiModels: [], apiSize: "",
      },
    ];
  }
  return list;
}

/** provider 关键字段是否齐备（模型在生成时单独指定，不在此要求） */
export function providerConfigured(p: GenProvider): boolean {
  if (p.type === "cli") return p.cliBin.trim().length > 0 || !!p.legacyTemplate?.trim();
  return !!(p.apiBaseUrl.trim() && p.apiKey.trim());
}

/**
 * 解析本次生成使用的 provider：
 * - 传了 providerId → 按 id 找（找不到返回 null，API 层 400）
 * - 没传 → 第一个 configured 的 provider，都没有则第一个
 */
export function resolveGenProvider(providerId?: string): GenProvider | null {
  const list = getGenProviders();
  if (providerId) return list.find((p) => p.id === providerId) ?? null;
  return list.find(providerConfigured) ?? list[0] ?? null;
}

/**
 * 图片分层独立配置。尚未保存新配置时，从旧 Provider 的 layerModels 读取一次运行时回退，
 * 让升级前已配置的分层能力继续可用；设置页会将这份值回填到新的 imageLayers 设置。
 */
export function getImageLayerSettings(legacyProviderId?: string): ImageLayerSettings {
  const saved = getSettingJson<Partial<ImageLayerSettings>>("imageLayers");
  if (saved && typeof saved === "object") {
    return { apiBaseUrl: str(saved.apiBaseUrl), apiKey: str(saved.apiKey), model: str(saved.model).trim() };
  }
  const providers = getSettingJson<unknown[]>("genProviders");
  const entries = Array.isArray(providers) ? providers : [];
  const findLegacy = (id?: string) => entries.find((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const p = raw as Record<string, unknown>;
    return p.type === "api" && (!id || p.id === id) && strings(p.layerModels).length > 0;
  }) as Record<string, unknown> | undefined;
  const legacy = (legacyProviderId ? findLegacy(legacyProviderId) : undefined) ?? findLegacy();
  return legacy
    ? { apiBaseUrl: str(legacy.apiBaseUrl), apiKey: str(legacy.apiKey), model: strings(legacy.layerModels)[0] ?? "" }
    : { apiBaseUrl: "", apiKey: "", model: "" };
}

export function imageLayerConfigured(settings: ImageLayerSettings): boolean {
  return !!(settings.apiBaseUrl.trim() && settings.apiKey.trim() && settings.model.trim());
}

/** 解析抠图配置：settings 表 matting 逐字段优先于 env / 默认值；cliTemplate env 模板走遗留路径 */
export function getMattingSettings(): MattingSettings & { envTemplate: string } {
  const saved = getSettingJson<Partial<MattingSettings>>("matting");
  return {
    cliBin: str(saved?.cliBin),
    cliInputArg: str(saved?.cliInputArg),
    cliOutputArg: str(saved?.cliOutputArg),
    cliModelArg: str(saved?.cliModelArg),
    model:
      typeof saved?.model === "string" && saved.model.trim()
        ? saved.model.trim()
        : readEnvTrimmed("MATTING_MODEL") || "u2net",
    envTemplate: readEnvTrimmed("MATTING_CLI"),
  };
}

/** 归一化一个加强模型条目 */
function normalizeEnhancer(raw: unknown): PromptEnhancer | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Partial<PromptEnhancer>;
  if (typeof e.id !== "string" || !e.id) return null;
  return {
    id: e.id,
    name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : e.id,
    providerId: str(e.providerId),
    model: str(e.model) || str(e.apiModel),
    apiBaseUrl: str(e.apiBaseUrl) || undefined,
    apiKey: str(e.apiKey) || undefined,
    apiModel: str(e.apiModel) || undefined,
  };
}

/** 全部提示词加强模型（settings 表 promptEnhancers 列表） */
export function getPromptEnhancers(): PromptEnhancer[] {
  const saved = getSettingJson<unknown[]>("promptEnhancers");
  return Array.isArray(saved) ? saved.map(normalizeEnhancer).filter((e): e is PromptEnhancer => e !== null) : [];
}

/**
 * 解析加强模型关联的 provider。
 * 旧数据仅保存了模型名时，若该名称在现有 API provider 的文本模型中唯一，则自动恢复关联。
 * 名称重复时不猜测，仍要求用户在设置页明确选择连接。
 */
function resolveEnhancerProvider(e: PromptEnhancer): (RuntimeGenProvider & { type: EnhancerProviderType }) | null {
  const providers = getGenProviders().filter(
    (p): p is RuntimeGenProvider & { type: EnhancerProviderType } => p.type !== "cli"
  );
  if (e.providerId) return providers.find((p) => p.id === e.providerId) ?? null;

  const model = (e.apiModel || e.model).trim();
  const matches = providers.filter((p) => p.textModels.includes(model));
  return matches.length === 1 ? matches[0] : null;
}

export function enhancerConfigured(e: PromptEnhancer): boolean {
  return resolveEnhancerRuntime(e) !== null;
}

export type EnhancerProviderType = "api" | "dashscope" | "gemini" | "minimax";

export interface EnhancerRuntime { baseUrl: string; apiKey: string; model: string; providerType: EnhancerProviderType }

/**
 * 窄运行时解析：新配置复用 provider；旧配置继续使用独立凭证。
 * baseUrl 为各厂商 /models 探测用的原始根地址；chat/completions 路径由 enhance.ts 按 providerType 拼接。
 */
export function resolveEnhancerRuntime(e: PromptEnhancer): EnhancerRuntime | null {
  const p = resolveEnhancerProvider(e);
  if (p) {
    // CLI 无 chat/completions 端点，不支持；其余 API 系均可
    if (!providerConfigured(p) || !e.model.trim()) return null;
    const base = p.apiBaseUrl.trim().replace(/\/+$/, "");
    if (p.type === "dashscope") {
      return { baseUrl: `${normalizeDashscopeRoot(base)}/compatible-mode/v1`, apiKey: p.apiKey.trim(), model: e.model.trim(), providerType: p.type };
    }
    // api / gemini / minimax：baseUrl 保持原始根，chat 路径由 enhance.ts 按 type 拼接
    return { baseUrl: base, apiKey: p.apiKey.trim(), model: e.model.trim(), providerType: p.type };
  }
  const baseUrl = e.apiBaseUrl?.trim().replace(/\/+$/, "") ?? "";
  const apiKey = e.apiKey?.trim() ?? "";
  const model = (e.apiModel || e.model).trim();
  return baseUrl && apiKey && model ? { baseUrl, apiKey, model, providerType: "api" } : null;
}

function normalizeDashscopeRoot(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/compatible-mode\/v1$/i, "").replace(/\/api\/v1$/i, "");
}

/** 解析本次加强使用的模型：按 id 找，缺省第一个配置齐备的 */
export function resolveEnhancer(enhancerId?: string): PromptEnhancer | null {
  const list = getPromptEnhancers();
  if (enhancerId) return list.find((e) => e.id === enhancerId) ?? null;
  return list.find(enhancerConfigured) ?? list[0] ?? null;
}
