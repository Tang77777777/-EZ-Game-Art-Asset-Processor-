import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Layers3, ListTodo, PlugZap, Plus, RefreshCw, Save, Settings2, Sparkles, Stethoscope, Trash2, Wand2 } from "lucide-react";
import type {
  DoctorResponse,
  GenProvider,
  GenProviderType,
  ImageLayerSettings,
  MattingSettings,
  PromptEnhancer,
  ProviderTestResponse,
  VideoInputMode,
} from "@ezgameart/shared";
import { REMBG_MODELS, resolveVideoInputMode, VIDEO_INPUT_MODES } from "@ezgameart/shared";
import { api } from "../api";
import { refreshServerConfig, useServerConfig } from "../config";
import { askConfirm, notify } from "../notice";
import { t, useT } from "../i18n";
import PxSelect from "./PxSelect";
import PxSuggest from "./PxSuggest";

/** 新建/预设 provider 的输入形态默认留空，由服务端按模型名推断兜底 */
const NO_VIDEO_MODEL_MODES: Record<string, VideoInputMode> = {};

/** 编辑草稿：模型按能力分栏，用逗号分隔文本编辑，保存时才拆成数组；CLI 为结构化字段（免模板） */
interface ProviderDraft {
  id: string;
  name: string;
  type: GenProviderType;
  cliBin: string;
  cliPromptArg: string;
  cliOutputArg: string;
  cliModelArg: string;
  cliReferenceArg: string;
  cliExtraArgs: string;
  apiBaseUrl: string;
  apiKey: string;
  imageModelsText: string;
  videoModelsText: string;
  textModelsText: string;
  /** 每个视频模型的输入形态（键为模型名）；缺省项由服务端按名推断兜底 */
  videoModelModes: Record<string, VideoInputMode>;
  imageSize: string;
  videoSize: string;
}

/** 加强模型草稿（同 GenProvider 的 api 系字段，但只走 chat/completions） */
interface EnhancerDraft {
  id: string;
  name: string;
  providerId: string;
  model: string;
  legacy: boolean;
}

const MAT_DEFAULT: MattingSettings = { cliBin: "", cliInputArg: "", cliOutputArg: "", cliModelArg: "", model: "" };
const IMAGE_LAYERS_DEFAULT: ImageLayerSettings = {
  apiBaseUrl: "https://ai.gitee.com/v1",
  apiKey: "",
  model: "Qwen-Image-Layered",
};

const CLI_EMPTY = {
  cliBin: "",
  cliPromptArg: "",
  cliOutputArg: "",
  cliModelArg: "",
  cliReferenceArg: "",
  cliExtraArgs: "",
};

const VIDEO_MODEL = /(?:^|[-_])(t2v|i2v|r2v|video)(?:[-_]|$)|hailuo|happyhorse|minimax-h\d/i;

function toDraft(p: GenProvider): ProviderDraft {
  const legacyModels = p.apiModels ?? [];
  const legacyVideoModels = p.type === "api" || p.type === "gemini"
    ? []
    : legacyModels.filter((model) => VIDEO_MODEL.test(model));
  const legacyImageModels = legacyModels.filter((model) => !legacyVideoModels.includes(model));
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    cliBin: p.cliBin,
    cliPromptArg: p.cliPromptArg,
    cliOutputArg: p.cliOutputArg,
    cliModelArg: p.cliModelArg,
    cliReferenceArg: p.cliReferenceArg,
    cliExtraArgs: p.cliExtraArgs,
    apiBaseUrl: p.apiBaseUrl,
    apiKey: p.apiKey,
    videoModelModes: { ...(p.videoModelModes ?? {}) },
    imageModelsText: (p.imageModels ?? legacyImageModels).join(", "),
    videoModelsText: (p.videoModels ?? legacyVideoModels).join(", "),
    textModelsText: (p.textModels ?? []).join(", "),
    imageSize: p.imageSize ?? p.apiSize ?? "",
    videoSize: p.videoSize ?? p.apiSize ?? "",
  };
}

function fromDraft(d: ProviderDraft): GenProvider {
  return {
    id: d.id,
    name: d.name.trim() || d.id,
    type: d.type,
    cliBin: d.cliBin,
    cliPromptArg: d.cliPromptArg,
    cliOutputArg: d.cliOutputArg,
    cliModelArg: d.cliModelArg,
    cliReferenceArg: d.cliReferenceArg,
    cliExtraArgs: d.cliExtraArgs,
    apiBaseUrl: d.apiBaseUrl,
    apiKey: d.apiKey,
    imageModels: splitModelText(d.imageModelsText),
    videoModels: splitModelText(d.videoModelsText),
    textModels: splitModelText(d.textModelsText),
    // 只保留仍在视频模型列表里的声明，避免删掉模型后留下孤立键
    videoModelModes: pickDeclaredModes(splitModelText(d.videoModelsText), d.videoModelModes),
    imageSize: d.imageSize,
    videoSize: d.videoSize,
  };
}

/** 过滤输入形态声明：丢掉已不在模型列表中的键；空表返回 undefined 以免写入无用字段 */
function pickDeclaredModes(
  models: string[],
  modes: Record<string, VideoInputMode>
): Record<string, VideoInputMode> | undefined {
  const out: Record<string, VideoInputMode> = {};
  for (const model of models) {
    const mode = modes[model];
    if (mode) out[model] = mode;
  }
  return Object.keys(out).length ? out : undefined;
}

const splitModelText = (text: string) => text.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);

/** 常用厂商预设：一键带出类型 / Base URL / 模型 / 尺寸格式，只需填 key 改名 */
const PRESETS: Array<{ label: string; draft: Omit<ProviderDraft, "id"> }> = [
  {
    label: "OpenAI",
    draft: {
      ...CLI_EMPTY,
      name: "OpenAI",
      type: "api",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKey: "",
      imageModelsText: "gpt-image-1", videoModelsText: "", textModelsText: "gpt-4o-mini",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "1024x1024", videoSize: "",
    },
  },
  {
    label: "msg.bailian",
    draft: {
      ...CLI_EMPTY,
      name: "settings.name.bailian_token_plan",
      type: "dashscope",
      apiBaseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com",
      apiKey: "",
      imageModelsText: "wan2.7-image, wan2.7-image-pro", videoModelsText: "happyhorse-1.1-t2v, happyhorse-1.1-i2v, happyhorse-1.1-r2v", textModelsText: "qwen-plus",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "2K", videoSize: "720P",
    },
  },
  {
    label: "banana",
    draft: {
      ...CLI_EMPTY,
      name: "banana（Gemini）",
      type: "gemini",
      apiBaseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "",
      imageModelsText: "gemini-2.5-flash-image, gemini-3-pro-image-preview", videoModelsText: "", textModelsText: "gemini-2.5-flash",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "1:1", videoSize: "",
    },
  },
  {
    label: "MiniMax",
    draft: {
      ...CLI_EMPTY,
      name: "MiniMax",
      type: "minimax",
      apiBaseUrl: "https://api.minimaxi.com",
      apiKey: "",
      imageModelsText: "image-01", videoModelsText: "MiniMax-Hailuo-2.3, MiniMax-H3", textModelsText: "MiniMax-Text-01, abab6.5s-chat",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "1:1", videoSize: "16:9",
    },
  },
  {
    label: "settings.preset.volc",
    draft: {
      ...CLI_EMPTY,
      name: "settings.name.volc_seedream",
      type: "api",
      apiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      apiKey: "",
      imageModelsText: "doubao-seedream-4-0-250828", videoModelsText: "", textModelsText: "",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "", videoSize: "",
    },
  },
  {
    label: "settings.preset.custom_cli",
    draft: {
      ...CLI_EMPTY,
      name: "settings.name.untitled_cli",
      type: "cli",
      apiBaseUrl: "",
      apiKey: "",
      imageModelsText: "", videoModelsText: "", textModelsText: "",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "", videoSize: "",
    },
  },
  {
    label: "settings.preset.custom_api",
    draft: {
      ...CLI_EMPTY,
      name: "settings.name.untitled_api",
      type: "api",
      apiBaseUrl: "",
      apiKey: "",
      imageModelsText: "", videoModelsText: "", textModelsText: "",
      videoModelModes: NO_VIDEO_MODEL_MODES,
      imageSize: "", videoSize: "",
    },
  },
];

/** 卡片类型徽标文案 */
const TYPE_LABEL: Record<GenProviderType, string> = {
  cli: "CLI",
  api: "API",
  dashscope: "msg.bailian",
  gemini: "banana",
  minimax: "MiniMax",
};

/** 各 API 系类型的表单 placeholder 与接口说明 */
const API_TYPE_META: Record<Exclude<GenProviderType, "cli">, { baseUrlPh: string; modelsPh: string; sizePh: string; hint: string }> = {
  api: {
    baseUrlPh: "settings.ph.api_base",
    modelsPh: "gpt-image-1, doubao-seedream-4-0-250828",
    sizePh: "1024x1024",
    hint: "settings.hint.api",
  },
  dashscope: {
    baseUrlPh: "settings.ph.dashscope_base",
    modelsPh: "wan2.7-image, wan2.7-image-pro, happyhorse-1.1-t2v, happyhorse-1.1-i2v",
    sizePh: "settings.ph.dashscope_size",
    hint: "msg.token_plan_base_https_token_plan_cn_beijing_maas_aliyunc",
  },
  gemini: {
    baseUrlPh: "https://generativelanguage.googleapis.com",
    modelsPh: "gemini-2.5-flash-image, gemini-3-pro-image-preview",
    sizePh: "1:1",
    hint: "settings.hint.gemini",
  },
  minimax: {
    baseUrlPh: "https://api.minimaxi.com",
    modelsPh: "image-01, MiniMax-Hailuo-2.3, MiniMax-H3",
    sizePh: "16:9",
    hint: "msg.minimax_image_01_v1_image_generation_subject_reference_v",
  },
};

function engineText(cfg: ReturnType<typeof useServerConfig>): string {
  if (!cfg) return t("msg.detecting_engine");
  switch (cfg.matting.engine) {
    case "custom-cli":
      return t("msg.engine_custom_cli");
    case "rembg-bundled":
      return t("msg.engine_rembg_model", { model: cfg.matting.model });
    case "rembg-path":
      return t("msg.engine_rembg_model_path", { model: cfg.matting.model });
    default:
      return t("msg.no_matting_engine_will_copy_original_only");
  }
}

/** 设置页：生成 provider 列表（CLI/API 多个共存，生成时选择）+ 抠图配置 + 体检 */
export default function SettingsPage() {
  const t = useT();
  const [drafts, setDrafts] = useState<ProviderDraft[]>([]);
  const [mat, setMat] = useState<MattingSettings>(MAT_DEFAULT);
  const [imageLayers, setImageLayers] = useState<ImageLayerSettings>(IMAGE_LAYERS_DEFAULT);
  const [enhancers, setEnhancers] = useState<EnhancerDraft[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savingMat, setSavingMat] = useState(false);
  const [savingImageLayers, setSavingImageLayers] = useState(false);
  const [queueConcurrency, setQueueConcurrency] = useState(2);
  const [savingQueue, setSavingQueue] = useState(false);
  const [savingEnh, setSavingEnh] = useState(false);
  const [tests, setTests] = useState<Record<string, { testing: boolean; result: ProviderTestResponse | null }>>({});
  // 「获取模型」拉取结果：models 为拉到的全量列表（可过滤点选），error 时保持手填
  const [modelLists, setModelLists] = useState<Record<string, { loading: boolean; models: string[] | null; error: string | null }>>({});
  const [modelFilters, setModelFilters] = useState<Record<string, string>>({});
  const [modelTargets, setModelTargets] = useState<Record<string, "image" | "video" | "text">>({});
  const [doctor, setDoctor] = useState<DoctorResponse | null>(null);
  const [doctorLoading, setDoctorLoading] = useState(false);
  const cfg = useServerConfig();

  // 打开时回填 settings 表中的值（env 兜底在服务端，这里只编辑设置页自己的值）
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        const list = Array.isArray(s["genProviders"])
          ? (s["genProviders"] as Array<GenProvider & { layerModels?: unknown }>)
          : [];
        const providerDrafts = list.map(toDraft);
        setDrafts(providerDrafts);
        const m = s["matting"] as Partial<MattingSettings> | undefined;
        if (m && typeof m === "object") setMat({ ...MAT_DEFAULT, ...m });
        const standaloneLayers = s["imageLayers"] as Partial<ImageLayerSettings> | undefined;
        if (standaloneLayers && typeof standaloneLayers === "object") {
          setImageLayers({ ...IMAGE_LAYERS_DEFAULT, ...standaloneLayers });
        } else {
          const legacy = list.find((p) => p.type === "api" && Array.isArray(p.layerModels) && p.layerModels.some((model) => typeof model === "string"));
          const legacyModel = legacy && Array.isArray(legacy.layerModels)
            ? legacy.layerModels.find((model): model is string => typeof model === "string")
            : undefined;
          if (legacy && legacyModel) setImageLayers({ apiBaseUrl: legacy.apiBaseUrl, apiKey: legacy.apiKey, model: legacyModel });
        }
        const enh = Array.isArray(s["promptEnhancers"]) ? (s["promptEnhancers"] as PromptEnhancer[]) : [];
        setEnhancers(
          enh.map((e) => {
            const model = e.model || e.apiModel || "";
            const modelMatches = list.filter((p) => p.type !== "cli" && (p.textModels ?? []).includes(model));
            const match = e.providerId
              || list.find((p) => e.apiBaseUrl && e.apiKey && p.apiBaseUrl === e.apiBaseUrl && p.apiKey === e.apiKey)?.id
              // 旧记录没有 providerId/凭证时，仅在模型名唯一时恢复关联，避免错用连接。
              || (modelMatches.length === 1 ? modelMatches[0].id : "");
            return { id: e.id, name: e.name, providerId: match, model, legacy: !match && !!e.apiBaseUrl };
          })
        );
        const qc = s["queueConcurrency"];
        if (typeof qc === "number" && qc >= 1) setQueueConcurrency(qc);
      })
      .catch((e) => notify(t("msg.load_settings_failed_msg", { msg: (e as Error).message })));
  }, []);

  const runDoctorCheck = () => {
    setDoctorLoading(true);
    api
      .getDoctor()
      .then(setDoctor)
      .catch((e) => notify(t("msg.doctor_failed_msg", { msg: (e as Error).message })))
      .finally(() => setDoctorLoading(false));
  };
  useEffect(() => {
    runDoctorCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchDraft = (id: string, patch: Partial<ProviderDraft>) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const addPreset = (preset: (typeof PRESETS)[number]) =>
    setDrafts((prev) => [{ ...preset.draft, id: crypto.randomUUID(), name: t(preset.draft.name) }, ...prev]);

  /** 任意卡片保存/删除都整表写入 genProviders */
  const persist = async (list: ProviderDraft[]): Promise<boolean> => {
    try {
      await api.putSetting("genProviders", list.map(fromDraft));
      await refreshServerConfig();
      return true;
    } catch (e) {
      notify(t("msg.save_failed_msg", { msg: (e as Error).message }));
      return false;
    }
  };

  const saveOne = async (id: string) => {
    setSavingId(id);
    const ok = await persist(drafts);
    setSavingId(null);
    if (ok) {
      setSavedId(id);
      window.setTimeout(() => setSavedId((s) => (s === id ? null : s)), 2000);
      runDoctorCheck();
    }
  };

  const removeOne = async (id: string) => {
    const d = drafts.find((x) => x.id === id);
    if (!(await askConfirm(t("msg.delete_provider_name", { name: d?.name ?? id })))) return;
    const next = drafts.filter((x) => x.id !== id);
    if (await persist(next)) {
      setDrafts(next);
      notify(t("msg.provider_deleted"), "info");
      runDoctorCheck();
    }
  };

  const testOne = async (d: ProviderDraft) => {
    setTests((prev) => ({ ...prev, [d.id]: { testing: true, result: null } }));
    try {
      const result = await api.testProvider({
        type: d.type === "cli" ? undefined : d.type,
        apiBaseUrl: d.apiBaseUrl,
        apiKey: d.apiKey,
        apiModel: splitModels(d.imageModelsText)[0] ?? splitModels(d.videoModelsText)[0] ?? splitModels(d.textModelsText)[0],
      });
      setTests((prev) => ({ ...prev, [d.id]: { testing: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [d.id]: { testing: false, result: { ok: false, error: (e as Error).message } } }));
    }
  };

  /** modelsText 逗号分隔文本 ↔ 数组 */
  const splitModels = (text: string) =>
    text.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean);

  /** 获取模型：用表单当前 baseUrl/key 拉模型列表（不要求已保存），拉到后渲染点选 chips */
  const fetchModels = async (d: ProviderDraft) => {
    if (d.type === "cli") return;
    setModelLists((prev) => ({ ...prev, [d.id]: { loading: true, models: null, error: null } }));
    try {
      const r = await api.listProviderModels({ type: d.type, apiBaseUrl: d.apiBaseUrl, apiKey: d.apiKey });
      setModelLists((prev) => ({
        ...prev,
        [d.id]: { loading: false, models: r.models ?? null, error: r.ok ? null : (r.error ?? t("msg.fetch_failed")) },
      }));
    } catch (e) {
      setModelLists((prev) => ({ ...prev, [d.id]: { loading: false, models: null, error: (e as Error).message } }));
    }
  };

  /** 点选 chip：已在列表则移除，否则追加（保留手输项） */
  const toggleModel = (d: ProviderDraft, model: string) => {
    const target = modelTargets[d.id] ?? "image";
    const field = `${target}ModelsText` as const;
    const list = splitModels(d[field]);
    const next = list.includes(model) ? list.filter((m) => m !== model) : [...list, model];
    patchDraft(d.id, { [field]: next.join(", ") });
  };

  const saveMatting = async () => {
    setSavingMat(true);
    try {
      await api.putSetting("matting", mat);
      await refreshServerConfig();
      notify(t("msg.matting_config_saved"), "info");
      runDoctorCheck();
    } catch (e) {
      notify(t("msg.save_failed_msg", { msg: (e as Error).message }));
    } finally {
      setSavingMat(false);
    }
  };

  const saveImageLayerSettings = async () => {
    setSavingImageLayers(true);
    try {
      await api.putSetting("imageLayers", imageLayers);
      await refreshServerConfig();
      notify(t("layers.configSaved"), "info");
      runDoctorCheck();
    } catch (e) {
      notify(t("msg.save_failed_msg", { msg: (e as Error).message }));
    } finally {
      setSavingImageLayers(false);
    }
  };

  const saveQueue = async () => {
    const n = Math.max(1, Math.min(16, Math.floor(Number(queueConcurrency)) || 1));
    setQueueConcurrency(n);
    setSavingQueue(true);
    try {
      await api.putSetting("queueConcurrency", n);
      await refreshServerConfig();
      notify(t("msg.queue_concurrency_saved"), "info");
    } catch (e) {
      notify(t("msg.save_failed_msg", { msg: (e as Error).message }));
    } finally {
      setSavingQueue(false);
    }
  };

  const testImageLayerSettings = async () => {
    const key = "image-layers";
    setTests((prev) => ({ ...prev, [key]: { testing: true, result: null } }));
    try {
      const result = await api.testProvider({
        type: "api",
        apiBaseUrl: imageLayers.apiBaseUrl,
        apiKey: imageLayers.apiKey,
        apiModel: imageLayers.model,
      });
      setTests((prev) => ({ ...prev, [key]: { testing: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [key]: { testing: false, result: { ok: false, error: (e as Error).message } } }));
    }
  };

  // ---- 提示词加强模型 ----
  const patchEnhancer = (id: string, patch: Partial<EnhancerDraft>) =>
    setEnhancers((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));

  const addEnhancer = () =>
    setEnhancers((prev) => [
      { id: crypto.randomUUID(), name: t("msg.untitled_enhancer"), providerId: "", model: "", legacy: false },
      ...prev,
    ]);

  const persistEnhancers = async (list: EnhancerDraft[]): Promise<boolean> => {
    try {
      await api.putSetting("promptEnhancers", list.map(({ id, name, providerId, model }) => ({ id, name, providerId, model })));
      await refreshServerConfig();
      return true;
    } catch (e) {
      notify(t("msg.save_failed_msg", { msg: (e as Error).message }));
      return false;
    }
  };

  const saveEnhancers = async () => {
    setSavingEnh(true);
    if (await persistEnhancers(enhancers)) {
      notify(t("msg.enhancers_saved"), "info");
      runDoctorCheck();
    }
    setSavingEnh(false);
  };

  const removeEnhancer = async (id: string) => {
    const e = enhancers.find((x) => x.id === id);
    if (!(await askConfirm(t("msg.delete_enhancer_name", { name: e?.name ?? id })))) return;
    const next = enhancers.filter((x) => x.id !== id);
    if (await persistEnhancers(next)) {
      setEnhancers(next);
      notify(t("msg.enhancer_deleted"), "info");
      runDoctorCheck();
    }
  };

  /** 加强模型测试：OpenAI 兼容 chat 端点普遍有 /models，复用 provider 测试 */
  const testEnhancer = async (e: EnhancerDraft) => {
    const key = `enh-${e.id}`;
    setTests((prev) => ({ ...prev, [key]: { testing: true, result: null } }));
    try {
      const provider = drafts.find((d) => d.id === e.providerId);
      const result = await api.testProvider({
        type: provider && provider.type !== "cli" ? provider.type as "api" | "dashscope" | "gemini" | "minimax" : undefined,
        apiBaseUrl: provider?.apiBaseUrl ?? "",
        apiKey: provider?.apiKey ?? "",
        apiModel: e.model,
      });
      setTests((prev) => ({ ...prev, [key]: { testing: false, result } }));
    } catch (err) {
      setTests((prev) => ({ ...prev, [key]: { testing: false, result: { ok: false, error: (err as Error).message } } }));
    }
  };

  return (
    <div className="page settings-page">
      <header className="home-header">
        <h1>
          <Settings2 size={24} /> {t("msg.settings")}
        </h1>
        <p className="subtitle">{t("msg.gen_providers_cli_api_pick_model_at_gen_time_matting_doc")}</p>
      </header>

      <div className="settings-layout">
        <aside className="settings-rail" aria-label={t("msg.settings")}>
          <span className="settings-rail-kicker">{t("msg.settings")}</span>
          <nav className="settings-rail-nav">
            <a href="#settings-generation"><Settings2 size={14} /> {t("msg.gen_providers")}</a>
            <a href="#settings-layers"><Layers3 size={14} /> {t("layers.settingsTitle")}</a>
            <a href="#settings-matting"><Wand2 size={14} /> {t("msg.matting")}</a>
            <a href="#settings-queue"><ListTodo size={14} /> {t("msg.queue_concurrency")}</a>
            <a href="#settings-enhancers"><Sparkles size={14} /> {t("msg.prompt_enhancers")}</a>
            <a href="#settings-doctor"><Stethoscope size={14} /> {t("msg.doctor")}</a>
          </nav>
        </aside>

        <main className="settings-content">

      {/* ===== 生成 Provider 列表 ===== */}
      <section id="settings-generation" className="settings-sec">
        <h3>
          <Settings2 size={14} /> {t("msg.gen_providers")}
        </h3>

        <div className="preset-row">
          <span>{t("msg.quick_add")}</span>
          {PRESETS.map((p) => (
            <button key={p.label} type="button" className="px-btn mini" onClick={() => addPreset(p)}>
              <Plus size={12} /> {t(p.label)}
            </button>
          ))}
        </div>

        {drafts.length === 0 && (
          <div className="hint">
            {t("msg.no_providers_yet_use_presets_above_cli_openai_compatible")}{" "}
            <code>EZGAMEART_GEN_CLI</code> {t("msg.fallback_when_list_is_empty")}
          </div>
        )}

        {drafts.map((d) => {
          const tst = tests[d.id];
          const ml = modelLists[d.id];
          return (
            <div key={d.id} className="provider-card">
              <div className="provider-head">
                <span className={`provider-type ${d.type}`}>{t(TYPE_LABEL[d.type])}</span>
                <input
                  className="px-input provider-name"
                  value={d.name}
                  onChange={(e) => patchDraft(d.id, { name: e.target.value })}
                />
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn mini accent"
                  disabled={savingId != null}
                  onClick={() => saveOne(d.id)}
                >
                  <Save size={12} /> {savingId === d.id ? t("msg.saving") : savedId === d.id ? t("msg.saved") : t("common.save")}
                </motion.button>
                <button type="button" className="px-btn mini danger" onClick={() => removeOne(d.id)}>
                  <Trash2 size={12} /> {t("common.delete")}
                </button>
              </div>

              {d.type === "cli" ? (
                <>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>{t("msg.command_path_name_or_absolute_path")}</span>
                        <input
                          className="px-input"
                          placeholder={t("msg.mygen_or_abs_path_mygen")}
                          value={d.cliBin}
                          onChange={(e) => patchDraft(d.id, { cliBin: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("msg.prompt_arg_name")}</span>
                        <input
                          className="px-input"
                          placeholder={t("msg.prompt_blank_positional")}
                          value={d.cliPromptArg}
                          onChange={(e) => patchDraft(d.id, { cliPromptArg: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("msg.output_arg_name")}</span>
                        <input
                          className="px-input"
                          placeholder={t("msg.o_or_output")}
                          value={d.cliOutputArg}
                          onChange={(e) => patchDraft(d.id, { cliOutputArg: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>{t("msg.model_arg_name_optional")}</span>
                        <input
                          className="px-input"
                          placeholder={t("msg.model_blank_omit_model")}
                          value={d.cliModelArg}
                          onChange={(e) => patchDraft(d.id, { cliModelArg: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("msg.reference_arg_name_optional")}</span>
                        <input
                          className="px-input"
                          placeholder={t("msg.ref_blank_no_reference")}
                          value={d.cliReferenceArg}
                          onChange={(e) => patchDraft(d.id, { cliReferenceArg: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>{t("msg.extra_fixed_args_optional")}</span>
                        <input
                          className="px-input"
                          placeholder={t("msg.steps_20_appended_as_is")}
                          value={d.cliExtraArgs}
                          onChange={(e) => patchDraft(d.id, { cliExtraArgs: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="hint">
                    {t("msg.no_need_to_hand_write_any")} {t("settings.placeholder_token")}
                    {t("msg.assembled_from_the_table_above_at_run_time")} <code>argv</code>
                    {t("msg.command_argname_value_no_shell_blank_arg_name_positional")}
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>Base URL</span>
                        <input
                          className="px-input"
                          placeholder={t(API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].baseUrlPh)}
                          value={d.apiBaseUrl}
                          onChange={(e) => patchDraft(d.id, { apiBaseUrl: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>API Key</span>
                        <input
                          className="px-input"
                          type="password"
                          autoComplete="off"
                          placeholder="sk-…"
                          value={d.apiKey}
                          onChange={(e) => patchDraft(d.id, { apiKey: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="form-inline">
                      <label className="field">
                        <span>{t("settings.imageModels")}</span>
                        <div className="models-fetch-row">
                          <input
                            className="px-input"
                            placeholder={API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].modelsPh}
                            value={d.imageModelsText}
                            onChange={(e) => patchDraft(d.id, { imageModelsText: e.target.value })}
                          />
                          <button
                            type="button"
                            className="px-btn mini"
                            disabled={ml?.loading}
                            onClick={() => fetchModels(d)}
                          >
                            <RefreshCw size={12} /> {ml?.loading ? t("msg.fetching") : t("msg.fetch_models")}
                          </button>
                        </div>
                      </label>
                      <label className="field">
                        <span>{t("settings.imageSize")}</span>
                        <input
                          className="px-input num"
                          placeholder={t(API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].sizePh)}
                          value={d.imageSize}
                          onChange={(e) => patchDraft(d.id, { imageSize: e.target.value })}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="form-row"><div className="form-inline">
                    <label className="field"><span>{t("settings.videoModels")}</span><input className="px-input" disabled={d.type === "api" || d.type === "gemini"} value={d.videoModelsText} onChange={(e) => patchDraft(d.id, { videoModelsText: e.target.value })} placeholder={d.type === "api" || d.type === "gemini" ? t("settings.videoUnsupported") : "happyhorse-1.1-t2v"} /></label>
                    <label className="field"><span>{t("settings.videoSize")}</span><input className="px-input num" disabled={d.type === "api" || d.type === "gemini"} value={d.videoSize} onChange={(e) => patchDraft(d.id, { videoSize: e.target.value })} placeholder="16:9 / 720P" /></label>
                    <label className="field"><span>{t("settings.textModels")}</span><input className="px-input" value={d.textModelsText} onChange={(e) => patchDraft(d.id, { textModelsText: e.target.value })} placeholder="gpt-4o-mini / qwen-plus" /></label>
                  </div></div>

                  {/* 视频模型的输入形态：显式声明，不靠模型名猜。
                      留空时服务端按名推断兜底，但厂商命名无规律，建议逐个声明。 */}
                  {d.type === "dashscope" && splitModels(d.videoModelsText).length > 0 && (
                    <div className="form-row settings-video-modes">
                      <span className="settings-video-modes-title">{t("settings.videoInputMode")}</span>
                      <p className="muted">{t("settings.videoInputModeHint")}</p>
                      {splitModels(d.videoModelsText).map((model) => {
                        const declared = d.videoModelModes[model];
                        const effective = resolveVideoInputMode(model, d.videoModelModes);
                        return (
                          <label key={model} className="field settings-video-mode-row">
                            <span title={model}>{model}</span>
                            <select
                              className="px-input"
                              value={declared ?? ""}
                              onChange={(event) => {
                                const value = event.target.value;
                                const next = { ...d.videoModelModes };
                                if (value) next[model] = value as VideoInputMode;
                                else delete next[model];
                                patchDraft(d.id, { videoModelModes: next });
                              }}
                            >
                              <option value="">{t("settings.videoInputModeAuto", { mode: t(`settings.videoInputMode.${effective}`) })}</option>
                              {VIDEO_INPUT_MODES.map((mode) => (
                                <option key={mode} value={mode}>{t(`settings.videoInputMode.${mode}`)}</option>
                              ))}
                            </select>
                          </label>
                        );
                      })}
                    </div>
                  )}
                  {ml?.error && <div className="hint">{t("msg.fetch_models_failed_err_you_can_type_manually", { err: ml.error })}</div>}
                  {ml?.models && (
                    <div className="model-fetch">
                      <PxSelect
                        value={modelTargets[d.id] ?? "image"}
                        options={[
                          { value: "image", label: t("settings.classifyImage") },
                          { value: "video", label: t("settings.classifyVideo") },
                          { value: "text", label: t("settings.classifyText") },
                        ]}
                        onChange={(v) => setModelTargets((prev) => ({ ...prev, [d.id]: v as "image" | "video" | "text" }))}
                      />
                      <input
                        className="px-input model-filter"
                        placeholder={t("msg.filter_models_count_click_to_add_remove", { count: ml.models.length })}
                        value={modelFilters[d.id] ?? ""}
                        onChange={(e) =>
                          setModelFilters((prev) => ({ ...prev, [d.id]: e.target.value }))
                        }
                      />
                      <div className="model-chips">
                        {ml.models
                          .filter((m) => {
                            const q = (modelFilters[d.id] ?? "").trim().toLowerCase();
                            return !q || m.toLowerCase().includes(q);
                          })
                          .map((m) => {
                            const active = splitModels(d[`${modelTargets[d.id] ?? "image"}ModelsText`]).includes(m);
                            return (
                              <button
                                key={m}
                                type="button"
                                className={`model-chip${active ? " active" : ""}`}
                                onClick={() => toggleModel(d, m)}
                              >
                                {m}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                  <div className="provider-test">
                    <button
                      type="button"
                      className="px-btn mini"
                      disabled={tst?.testing}
                      onClick={() => testOne(d)}
                    >
                      <PlugZap size={12} /> {tst?.testing ? t("msg.testing") : t("msg.test_connection")}
                    </button>
                    {tst?.result && (
                      <span className={`engine-status ${tst.result.ok ? "ok" : "bad"}`}>
                        <span className="dot" />
                        {tst.result.ok
                          ? tst.result.note ??
                            `${t("msg.ok_msms", { ms: tst.result.latencyMs ?? 0 })}${
                              tst.result.modelsFound === true
                                ? t("msg.in_model_list")
                                : tst.result.modelsFound === false
                                  ? t("msg.but_first_model_not_in_list")
                                  : ""
                            }`
                          : t("msg.failed_err", { err: tst.result.error ?? t("msg.unknown_error") })}
                      </span>
                    )}
                  </div>
                  <div className="hint">{t(API_TYPE_META[d.type as Exclude<GenProviderType, "cli">].hint)}</div>
                </>
              )}
            </div>
          );
        })}
      </section>

      {/* ===== 图片分层 ===== */}
      <section id="settings-layers" className="settings-sec">
        <h3>
          <Layers3 size={14} /> {t("layers.settingsTitle")}
          <span className={`engine-status ${cfg?.imageLayers.configured ? "ok" : "bad"}`}>
            <span className="dot" />
            {cfg?.imageLayers.configured ? t("layers.configuredModel", { model: cfg.imageLayers.model }) : t("layers.notConfigured")}
          </span>
        </h3>
        <div className="hint">{t("layers.settingsHint")}</div>
        <div className="form-row">
          <div className="form-inline">
            <label className="field">
              <span>Base URL</span>
              <input className="px-input" placeholder="https://ai.gitee.com/v1" value={imageLayers.apiBaseUrl} onChange={(e) => setImageLayers((s) => ({ ...s, apiBaseUrl: e.target.value }))} />
            </label>
            <label className="field">
              <span>API Key</span>
              <input className="px-input" type="password" autoComplete="off" placeholder="sk-…" value={imageLayers.apiKey} onChange={(e) => setImageLayers((s) => ({ ...s, apiKey: e.target.value }))} />
            </label>
            <label className="field">
              <span>{t("layers.model")}</span>
              <input className="px-input" placeholder="Qwen-Image-Layered" value={imageLayers.model} onChange={(e) => setImageLayers((s) => ({ ...s, model: e.target.value }))} />
            </label>
          </div>
        </div>
        <div className="provider-test">
          <button type="button" className="px-btn mini" disabled={tests["image-layers"]?.testing} onClick={testImageLayerSettings}>
            <PlugZap size={12} /> {tests["image-layers"]?.testing ? t("msg.testing") : t("msg.test_connection")}
          </button>
          {tests["image-layers"]?.result && (
            <span className={`engine-status ${tests["image-layers"].result!.ok ? "ok" : "bad"}`}>
              <span className="dot" />
              {tests["image-layers"].result!.ok
                ? t("msg.ok_msms", { ms: tests["image-layers"].result!.latencyMs ?? 0 })
                : t("msg.failed_err", { err: tests["image-layers"].result!.error ?? t("msg.unknown_error") })}
            </span>
          )}
        </div>
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button type="button" whileTap={{ scale: 0.95 }} className="px-btn accent" disabled={savingImageLayers} onClick={saveImageLayerSettings}>
            <Save size={14} /> {savingImageLayers ? t("msg.saving") : t("layers.saveConfig")}
          </motion.button>
        </div>
      </section>

      {/* ===== 抠图 ===== */}
      <section id="settings-matting" className="settings-sec">
        <h3>
          <Wand2 size={14} /> {t("msg.matting")}
          <span className={`engine-status ${cfg && cfg.matting.engine !== "none" ? "ok" : "bad"}`}>
            <span className="dot" />
            {engineText(cfg)}
          </span>
        </h3>
        <div className="form-row">
          <label>{t("msg.custom_matting_command_blank_auto_venv_matting_path_remb")}</label>
          <div className="form-inline">
            <label className="field">
              <span>{t("msg.command")}</span>
              <input
                className="px-input"
                placeholder={t("msg.mymatte_or_abs_path_mymatte")}
                value={mat.cliBin}
                onChange={(e) => setMat((s) => ({ ...s, cliBin: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("msg.input_image_arg_name")}</span>
              <input
                className="px-input"
                placeholder={t("msg.blank_positional")}
                value={mat.cliInputArg}
                onChange={(e) => setMat((s) => ({ ...s, cliInputArg: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("msg.output_image_arg_name")}</span>
              <input
                className="px-input"
                placeholder={t("msg.e_g_o")}
                value={mat.cliOutputArg}
                onChange={(e) => setMat((s) => ({ ...s, cliOutputArg: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>{t("msg.model_arg_name")}</span>
              <input
                className="px-input num"
                placeholder={t("msg.e_g_m")}
                value={mat.cliModelArg}
                onChange={(e) => setMat((s) => ({ ...s, cliModelArg: e.target.value }))}
              />
            </label>
          </div>
        </div>
        <div className="form-row">
          <label>{t("msg.default_model_gen_upload_matting_blank_env_u2net")}</label>
          <PxSuggest
            placeholder="u2net"
            suggestions={[...REMBG_MODELS]}
            value={mat.model}
            onChange={(v) => setMat((s) => ({ ...s, model: v }))}
          />
          {cfg && (
            <div className="hint">
              {t("msg.active_model")}<code>{cfg.matting.model}</code>（
              {cfg.matting.modelCached ? t("msg.cached_in_storage_models") : t("msg.not_cached_first_run_downloads_100mb")}）
            </div>
          )}
        </div>
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={savingMat}
            onClick={saveMatting}
          >
            <Save size={14} /> {savingMat ? t("msg.saving") : t("msg.save_matting_config")}
          </motion.button>
        </div>
      </section>

      {/* ===== 任务队列 ===== */}
      <section id="settings-queue" className="settings-sec">
        <h3>
          <ListTodo size={14} /> {t("msg.queue_concurrency")}
        </h3>
        <div className="form-row">
          <label>{t("msg.queue_concurrency_desc")}</label>
          <div className="form-inline">
            <label className="field">
              <span>{t("msg.queue_concurrency")}</span>
              <input
                className="px-input num"
                type="number"
                min={1}
                max={16}
                value={queueConcurrency}
                onChange={(e) => setQueueConcurrency(Number(e.target.value))}
              />
            </label>
          </div>
          <div className="hint">
            {t("msg.queue_concurrency_hint")}
            {cfg && (
              <>
                （{t("msg.current")}：<code>{cfg.queueConcurrency}</code>）
              </>
            )}
          </div>
        </div>
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={savingQueue}
            onClick={saveQueue}
          >
            <Save size={14} /> {savingQueue ? t("msg.saving") : t("msg.save_queue_config")}
          </motion.button>
        </div>
      </section>

      {/* ===== 提示词加强模型 ===== */}
      <section id="settings-enhancers" className="settings-sec">
        <h3>
          <Sparkles size={14} /> {t("msg.prompt_enhancers")}
          <span className="settings-head-actions">
            <button type="button" className="px-btn mini" onClick={addEnhancer}>
              <Plus size={12} /> {t("msg.add")}
            </button>
          </span>
        </h3>
        <div className="hint">
          {t("msg.for_enhance_prompt_in_gen_dialog_rewrite_short_desc_into")}{" "}
          <code>chat/completions</code>{" "}
          {t("msg.apis_openai_bailian_qwen_deepseek_side_by_side_compare_y")}
        </div>
        {enhancers.map((e) => {
          const tst = tests[`enh-${e.id}`];
          return (
            <div key={e.id} className="provider-card">
              <div className="provider-head">
                <span className="provider-type enhancer">{t("msg.enhance")}</span>
                <input
                  className="px-input provider-name"
                  value={e.name}
                  onChange={(e2) => patchEnhancer(e.id, { name: e2.target.value })}
                />
                <button type="button" className="px-btn mini danger" onClick={() => removeEnhancer(e.id)}>
                  <Trash2 size={12} /> {t("common.delete")}
                </button>
              </div>
              <div className="form-row">
                <div className="form-inline">
                  <label className="field"><span>{t("settings.providerConnection")}</span>
                    <PxSelect
                      value={e.providerId}
                      options={[
                        { value: "", label: t("settings.selectConnection") },
                        ...drafts.filter((d) => d.type !== "cli").map((d) => ({ value: d.id, label: d.name })),
                      ]}
                      onChange={(v) => patchEnhancer(e.id, { providerId: v, legacy: false, model: "" })}
                    />
                  </label>
                  <label className="field">
                    <span>{t("msg.model")}</span>
                    {splitModels(drafts.find((d) => d.id === e.providerId)?.textModelsText ?? "").length ? <PxSelect value={e.model} options={[{ value: "", label: t("settings.selectModel") }, ...splitModels(drafts.find((d) => d.id === e.providerId)?.textModelsText ?? "").map((m) => ({ value: m, label: m }))]} onChange={(v) => patchEnhancer(e.id, { model: v })} /> : <input className="px-input" placeholder="gpt-4o-mini / qwen-plus" value={e.model} onChange={(e2) => patchEnhancer(e.id, { model: e2.target.value })} />}
                  </label>
                </div>
              </div>
              {e.legacy && <div className="hint warn">{t("settings.legacyEnhancerSelectConnection")}</div>}
              <div className="provider-test">
                <button type="button" className="px-btn mini" disabled={tst?.testing} onClick={() => testEnhancer(e)}>
                  <PlugZap size={12} /> {tst?.testing ? t("msg.testing") : t("msg.test_connection")}
                </button>
                {tst?.result && (
                  <span className={`engine-status ${tst.result.ok ? "ok" : "bad"}`}>
                    <span className="dot" />
                    {tst.result.ok
                      ? `${t("msg.ok_msms", { ms: tst.result.latencyMs ?? 0 })}${
                          tst.result.modelsFound === true
                            ? t("msg.in_model_list")
                            : tst.result.modelsFound === false
                              ? t("msg.but_not_in_model_list")
                              : ""
                        }`
                      : t("msg.failed_err", { err: tst.result.error ?? t("msg.unknown_error") })}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <div className="modal-actions" style={{ justifyContent: "flex-start" }}>
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={savingEnh}
            onClick={saveEnhancers}
          >
            <Save size={14} /> {savingEnh ? t("msg.saving") : t("msg.save_enhancers")}
          </motion.button>
        </div>
      </section>

      {/* ===== 体检 ===== */}
      <section id="settings-doctor" className="settings-sec">
        <h3>
          <Stethoscope size={14} /> {t("msg.doctor")}
          <span className="settings-head-actions">
            <button type="button" className="px-btn mini" disabled={doctorLoading} onClick={runDoctorCheck}>
              {doctorLoading ? t("msg.checking") : t("msg.recheck")}
            </button>
          </span>
        </h3>
        {doctor === null ? (
          <div className="hint">{t("msg.checking_481ee2")}</div>
        ) : (
          <ul className="doctor-list">
            {doctor.checks.map((c) => (
              <li key={c.id} className="doctor-item">
                <span className={`engine-status ${c.ok ? "ok" : "bad"}`}>
                  <span className="dot" />
                  {c.label}
                </span>
                <span className="doctor-detail">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
        </main>
      </div>
    </div>
  );
}
