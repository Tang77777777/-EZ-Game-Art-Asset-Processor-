// ===== 枚举常量（前后端唯一事实源）=====

export const MATERIAL_SOURCES = [
  "cli",
  "api",
  "dashscope",
  "gemini",
  "minimax",
  "layers",
  "upload",
  "gif",
  "mp4",
  "image",
  "extract",
  "duplicate",
  "raster",
] as const;
export type MaterialSource = (typeof MATERIAL_SOURCES)[number];

export const JOB_TYPES = ["extract_frames", "generate_materials", "matting", "image_layers"] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Qwen-Image-Layered /images/layers 当前服务端允许的单次图层数 */
export const IMAGE_LAYER_COUNT_MIN = 1;
export const IMAGE_LAYER_COUNT_MAX = 4;

export const JOB_STATUSES = ["queued", "running", "done", "error", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const MATERIAL_STATUSES = ["raw", "matted"] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

// 单成员：本产品只有素材库目录树；保留数组形态是因为 folders.kind 已持久化且入参需校验
export const FOLDER_KINDS = ["material"] as const;
export type FolderKind = (typeof FOLDER_KINDS)[number];

export const GENERATION_INTENTS = ["frame-image", "frame-sheet", "frame-video"] as const;
export type GenerationIntent = (typeof GENERATION_INTENTS)[number];

/** 抠图引擎（服务端启动时探测一次，解析顺序 a→d） */
export const MATTING_ENGINES = ["custom-cli", "rembg-bundled", "rembg-path", "none"] as const;
export type MattingEngine = (typeof MATTING_ENGINES)[number];

/** rembg 常用模型（设置页 datalist 建议项，仍可自由输入任意模型名） */
export const REMBG_MODELS = [
  "u2net",
  "u2netp",
  "u2net_human_seg",
  "isnet-general-use",
  "isnet-anime",
  "birefnet-general",
  "birefnet-portrait",
] as const;

/** 生成 provider 类型：CLI 模板 / OpenAI 兼容 API / 百炼 DashScope 原生 / Gemini（banana）/ MiniMax */
export const GEN_PROVIDER_TYPES = ["cli", "api", "dashscope", "gemini", "minimax"] as const;
export type GenProviderType = (typeof GEN_PROVIDER_TYPES)[number];

/**
 * 一个生成 provider（存 settings 表 key=genProviders 的数组元素）。
 * CLI / OpenAI 兼容 / DashScope 原生 / Gemini / MiniMax 可配置多个共存；生成时按 id 选择，模型在生成时单独指定。
 * CLI 为结构化字段（免手写 {占位符} 模板）：参数名留空表示对应值作位置参数传入
 */
export interface GenProvider {
  id: string;
  name: string;
  type: GenProviderType;
  /** type=cli：可执行命令（PATH 名或绝对路径） */
  cliBin: string;
  /** type=cli：prompt 参数名（如 --prompt；留空 = 位置参数） */
  cliPromptArg: string;
  /** type=cli：输出文件参数名（如 -o / --output；留空 = 位置参数，跟在 prompt 后） */
  cliOutputArg: string;
  /** type=cli：模型参数名（如 --model；留空则不下发模型） */
  cliModelArg: string;
  /** type=cli：引用图参数名（如 --ref；留空则该 CLI 不支持引用图，选了引用图创建任务时 400） */
  cliReferenceArg: string;
  /** type=cli：追加的固定参数（按空白切分原样拼接，可空） */
  cliExtraArgs: string;
  /** type=cli：遗留命令模板（env EZGAMEART_GEN_CLI 兜底及旧数据兼容；设置页不再暴露） */
  legacyTemplate?: string;
  /** type=api：OpenAI 兼容 baseUrl；type=dashscope：DashScope 原生 baseUrl（可含工作区子域） */
  apiBaseUrl: string;
  apiKey: string;
  /** 按能力分类的模型列表（新配置唯一写入字段） */
  imageModels: string[];
  videoModels: string[];
  textModels: string[];
  /**
   * 每个视频模型的输入形态声明，键为模型名。
   * 缺省时按模型名推断（见 resolveVideoInputMode），但那只是兜底——
   * 厂商每出新模型就换一套命名，能力应当由用户在设置页显式声明。
   */
  videoModelModes?: Record<string, VideoInputMode>;
  imageSize: string;
  videoSize: string;
  /** @deprecated 仅用于读取旧配置 */
  apiModels?: string[];
  /** @deprecated 仅用于读取旧配置 */
  apiSize?: string;
}

/** 提示词加强模型（存 settings 表 key=promptEnhancers 的数组元素；OpenAI 兼容 chat/completions） */
export interface PromptEnhancer {
  id: string;
  name: string;
  providerId: string;
  model: string;
  /** @deprecated 旧配置独立凭证兼容 */
  apiBaseUrl?: string;
  /** @deprecated 旧配置独立凭证兼容 */
  apiKey?: string;
  /** @deprecated 旧配置独立模型兼容 */
  apiModel?: string;
}

/**
 * 生成尺寸预设（生成弹窗下拉；空串 = 用 provider 设置页配的 apiSize 默认）。
 * 各厂商尺寸格式不同，按 provider 类型分档；CLI 无尺寸概念不下发
 */
export const GEN_SIZE_PRESETS: Record<Exclude<GenProviderType, "cli">, Array<{ value: string; label: string }>> = {
  api: [
    { value: "", label: "size.default" },
    { value: "1024x1024", label: "size.1024x1024" },
    { value: "1536x1024", label: "size.1536x1024" },
    { value: "1024x1536", label: "size.1024x1536" },
  ],
  dashscope: [
    { value: "", label: "size.default" },
    { value: "2K", label: "size.2k_wan" },
    { value: "1K", label: "size.1k" },
    { value: "4K", label: "size.4k_pro" },
    { value: "1328*1328", label: "size.1328x1328" },
    { value: "1664*928", label: "size.1664x928" },
    { value: "928*1664", label: "size.928x1664" },
  ],
  gemini: [
    { value: "", label: "size.default" },
    { value: "1:1", label: "size.1_1" },
    { value: "3:2", label: "size.3_2" },
    { value: "2:3", label: "size.2_3" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
  ],
  minimax: [
    { value: "", label: "size.default" },
    { value: "1:1", label: "size.1_1" },
    { value: "3:2", label: "size.3_2" },
    { value: "2:3", label: "size.2_3" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
  ],
};

/** 视频生成尺寸/比例预设（与图片档位分开；透传给各家 video API） */
export const GEN_VIDEO_SIZE_PRESETS: Record<Exclude<GenProviderType, "cli">, Array<{ value: string; label: string }>> = {
  api: [
    { value: "", label: "size.default" },
    { value: "1280*720", label: "size.1280x720" },
    { value: "1920*1080", label: "size.1920x1080" },
  ],
  dashscope: [
    { value: "", label: "size.default" },
    { value: "720P", label: "size.720p" },
    { value: "1080P", label: "size.1080p" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
    { value: "1:1", label: "size.1_1" },
  ],
  gemini: [
    { value: "", label: "size.default" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
    { value: "1:1", label: "size.1_1" },
  ],
  minimax: [
    { value: "", label: "size.default" },
    { value: "16:9", label: "size.16_9" },
    { value: "9:16", label: "size.9_16" },
    { value: "1:1", label: "size.1_1" },
    { value: "1080P", label: "size.1080p" },
    { value: "768P", label: "size.768p" },
  ],
};

/**
 * 把 size / 比例字符串解析成预览用宽高（逻辑像素），供 UI 比例框示意。
 * 无法识别时回退 1:1。
 */
export function parseSizePreview(size: string): { w: number; h: number; label: string } {
  const s = size.trim();
  if (!s) return { w: 1, h: 1, label: "default" };
  const ratio = /^(\d+)\s*:\s*(\d+)$/.exec(s);
  if (ratio) return { w: Number(ratio[1]), h: Number(ratio[2]), label: s };
  const wh = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(s);
  if (wh) return { w: Number(wh[1]), h: Number(wh[2]), label: `${wh[1]}×${wh[2]}` };
  const up = s.toUpperCase();
  if (up === "1K") return { w: 1024, h: 1024, label: "1K ≈1024²" };
  if (up === "2K") return { w: 2048, h: 2048, label: "2K ≈2048²" };
  if (up === "4K") return { w: 4096, h: 4096, label: "4K ≈4096²" };
  if (up === "480P") return { w: 854, h: 480, label: "480P" };
  if (up === "720P") return { w: 1280, h: 720, label: "720P" };
  if (up === "768P") return { w: 1366, h: 768, label: "768P" };
  if (up === "1080P") return { w: 1920, h: 1080, label: "1080P" };
  return { w: 1, h: 1, label: s };
}

/** GET /api/config 下发的 provider 摘要（不含 apiKey） */
export interface GenProviderInfo {
  id: string;
  name: string;
  type: GenProviderType;
  imageModels: string[];
  videoModels: string[];
  textModels: string[];
  /** 每个视频模型的输入形态声明（键为模型名）；前端据此决定是否展示引用图选择器 */
  videoModelModes?: Record<string, VideoInputMode>;
  /** 关键字段是否齐备（cli=命令非空；api 系=baseUrl/key 齐全） */
  configured: boolean;
  /** 是否支持视频生成（文生视频 → 逐帧切割）：cli/dashscope/minimax 支持 */
  video: boolean;
  /** 设置页默认尺寸（弹窗空选时预览用；不下发 key） */
  imageSize?: string;
  videoSize?: string;
}

/** 各 provider 类型是否支持视频生成（服务端 /api/config 摘要与前端弹窗过滤共用） */
/**
 * 视频模型的输入形态，对应 DashScope 的 input.media[].type：
 * - text            纯文生视频，不接引用图
 * - firstFrame      单张首帧驱动（first_frame，最多 1 张）
 * - firstLastFrame  首尾帧驱动（first_frame + last_frame，各最多 1 张）
 * - referenceImage  参考图 / 主体保持（reference_image，最多 10 张）
 *
 * 官方硬约束：`reference_*` / `file` / `link` 与 `first_frame` / `last_frame`
 * **互斥**，不能在同一请求里混用。所以这里必须是单选枚举，不能做成多个布尔开关。
 * 依据：https://help.aliyun.com/en/model-studio/wan3-video-generation-api-reference
 *
 * 参考视频（reference_video）故意不做：文档中它的定位是视频编辑、风格改绘与
 * 视频延展，不是「生成一段像素动画」的入口。
 */
export const VIDEO_INPUT_MODES = ["text", "firstFrame", "firstLastFrame", "referenceImage"] as const;
export type VideoInputMode = (typeof VIDEO_INPUT_MODES)[number];

/**
 * 解析某个视频模型的输入形态。
 *
 * 优先取用户在设置页的显式声明；没有声明时才按模型名推断，以兼容旧配置。
 * **不要依赖名称推断**——厂商命名毫无规律（wanx2.1-i2v-turbo / wan2.5-t2v /
 * wan3.0-video / wan2.2-kf2），历史上正好因此漏判过：wan3.0-video 三条正则
 * 全不匹配，被当成纯文生视频，用户选的引用图被静默丢弃。
 */
export function resolveVideoInputMode(
  model: string,
  declared?: Record<string, VideoInputMode> | null
): VideoInputMode {
  const explicit = declared?.[model];
  if (explicit && (VIDEO_INPUT_MODES as readonly string[]).includes(explicit)) return explicit;
  // kf2 = keyframe-to-video，本身就是首尾帧模型，不要归到单首帧
  if (/kf2|first[-_]?(and[-_]?)?last/i.test(model)) return "firstLastFrame";
  if (/i2v|first[-_]?frame/i.test(model)) return "firstFrame";
  if (/r2v|reference/i.test(model)) return "referenceImage";
  return "text";
}

/** 该输入形态是否接受引用图 */
export function videoInputModeAcceptsReferences(mode: VideoInputMode): boolean {
  return mode !== "text";
}

/**
 * 生成面板该不该给出「起始帧 / 结束帧」两个具名槽位。
 *
 * 只有**显式声明**为 text（纯文生）或 referenceImage（主体保持，可多张）才不给。
 * 未声明一律给——因为槽位留空就等于纯文生，多给一个可选入口没有代价；
 * 反过来若默认不给，用户就必须先跑一趟设置页才能用首帧驱动，而厂商命名
 * 又推断不出能力（wan3.0-video 就是典型），等于把能力藏起来了。
 */
export function videoModeOffersKeyframes(declared?: VideoInputMode | null): boolean {
  return declared !== "text" && declared !== "referenceImage";
}

/**
 * 由用户实际填写的槽位派生本次请求的输入形态。
 *
 * 这是「形态不再靠声明、而是看你填了什么」的落点：
 * - 起始帧留空 → 纯文生（保留面板原有的文生视频能力，不做硬必填）
 * - 只填起始帧 → 首帧驱动
 * - 填了结束帧，或勾了「复制为结束帧」 → 首尾帧
 *
 * loop 必须作为独立入参传进来，不能由服务端从「只收到 1 张」反推：
 * 那样分不清「要循环」和「只想首帧驱动」，会把后者也强行套上循环。
 */
export function deriveVideoInputMode(input: { hasFirst: boolean; hasLast: boolean; loop: boolean }): VideoInputMode {
  if (!input.hasFirst) return "text";
  if (input.hasLast || input.loop) return "firstLastFrame";
  return "firstFrame";
}

/**
 * 该输入形态允许的引用图张数上限；0 表示不接受。
 * firstLastFrame 允许只给 1 张——此时首尾同帧，产出可无缝循环的动画。
 */
export function videoInputModeMaxReferences(mode: VideoInputMode): number {
  if (mode === "firstFrame") return 1;
  if (mode === "firstLastFrame") return 2;
  if (mode === "referenceImage") return 10;
  return 0;
}

export const PROVIDER_VIDEO_SUPPORT: Record<GenProviderType, boolean> = {
  cli: true, // 产物按魔数检测：是视频自动逐帧拆帧
  api: false,
  dashscope: true,
  gemini: false,
  minimax: true,
};

/**
 * 百炼 / Token Plan Base URL 归一：
 * 用户常粘贴 OpenAI 兼容地址 `…/compatible-mode/v1`，而生图/视频走原生 `…/api/v1/services/…`。
 * 剥掉尾斜杠、`/compatible-mode/v1`、`/api/v1`，得到 host 根（如 `https://token-plan.cn-beijing.maas.aliyuncs.com`）。
 */
export function normalizeDashscopeBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/compatible-mode\/v1$/i, "")
    .replace(/\/api\/v1$/i, "");
}

/** MiniMax image-* / 百炼 wan*-image、qwen-image：明显是文生图，视频模式下应避开 */
export function isLikelyImageOnlyModel(model: string): boolean {
  const m = model.trim();
  if (/^image[-_]?\d/i.test(m)) return true;
  // wan2.7-image / wan2.7-image-pro / qwen-image-*（排除 *-i2v/-t2v/-r2v）
  if (/(^|[-_])image(-|$)/i.test(m) || /qwen-image/i.test(m)) return true;
  return false;
}

/** 视频模式下从模型列表挑首选（跳过图模；优先 t2v，有引用图时优先 i2v） */
export function pickPreferredVideoModel(models: string[], opts?: { preferI2v?: boolean }): string {
  const nonImage = models.filter((m) => !isLikelyImageOnlyModel(m));
  if (opts?.preferI2v) {
    const i2v = nonImage.find((m) => /i2v/i.test(m));
    if (i2v) return i2v;
  }
  const t2v = nonImage.find((m) => /t2v/i.test(m));
  if (t2v) return t2v;
  const preferred = nonImage.find((m) => /hailuo|happyhorse|minimax-h\d|r2v|video/i.test(m));
  return preferred ?? nonImage[0] ?? models[0] ?? "";
}

/** 设置页「图片分层」独立配置（存 settings 表 key=imageLayers） */
export interface ImageLayerSettings {
  /** OpenAI 兼容风格的服务根地址，执行时调用其 /images/layers */
  apiBaseUrl: string;
  apiKey: string;
  model: string;
}

/** 设置页「抠图」配置（存 settings 表 key=matting，逐字段优先于环境变量）；CLI 为结构化字段（免模板） */
export interface MattingSettings {
  /** 抠图命令（PATH 名或绝对路径；留空走自动探测 rembg） */
  cliBin: string;
  /** 输入图参数名（留空 = 位置参数） */
  cliInputArg: string;
  /** 输出图参数名（留空 = 位置参数，跟在输入后） */
  cliOutputArg: string;
  /** 模型参数名（留空则不下发模型） */
  cliModelArg: string;
  /** rembg 模型名，留空用 env / 默认 u2net */
  model: string;
}

/** GET /api/config 响应 */
export interface ServerConfig {
  matting: {
    engine: MattingEngine;
    model: string;
    /** engine=none 时给用户的安装提示 */
    hint: string | null;
    /** 当前模型是否已缓存到 storage/models（未缓存则首次抠图会自动下载） */
    modelCached: boolean;
  };
  imageLayers: {
    configured: boolean;
    model: string;
  };
  gen: {
    /** 全部已配置 provider（不含 apiKey）；生成时按 id 选择 */
    providers: GenProviderInfo[];
  };
  /** 提示词加强模型摘要（不含 apiKey）；为空表示未配置 */
  promptEnhancers: Array<{ id: string; name: string; model: string }>;
  /** 任务队列并发数（settings.queueConcurrency 优先，env 兜底，默认 2） */
  queueConcurrency: number;
}

/**
 * 提示词加强的候选风格（前后端唯一事实源）。
 * id 传给服务端；directive 由服务端拼进系统提示词（前端只用 id/label 做下拉）
 */
export const ENHANCE_STYLES = [
  { id: "pixel", label: "enhance.pixel", directive: "pixel art 风格，retro game sprite，limited color palette，crisp clusters" },
  { id: "anime", label: "enhance.anime", directive: "anime / cel-shaded 风格，clean lineart，vibrant colors" },
  { id: "illustration", label: "enhance.illustration", directive: "hand-drawn illustration 风格，painterly texture，soft brush strokes" },
  { id: "3d", label: "enhance.3d", directive: "3D render 风格，Pixar-like，soft studio lighting，octane render" },
  { id: "realistic", label: "enhance.realistic", directive: "photorealistic 风格，detailed texture，natural lighting" },
  { id: "general", label: "enhance.general", directive: "不限定风格，重点丰富主体外观、姿态、视角与氛围" },
] as const;
export type EnhanceStyleId = (typeof ENHANCE_STYLES)[number]["id"];

/**
 * 多动作 / 连续帧生成预设（素材详情「多动作生成」用）。
 * - 图片：按顺序追加帧（可重复）→ 一次生成连续动作拼图表 → 网格切分
 * - 视频：点选一个动作注入提示词 → 文生视频素材 → 素材库单独抽帧（无需拼图/切分）
 * prompt 为英文动作基调；完整文案由 buildActionSheetPrompt / buildActionVideoPrompt 组装。
 */
export const ACTION_PRESETS = [
  { id: "idle", label: "action.idle", prompt: "idle fitting the character" },
  { id: "walk", label: "action.walk", prompt: "walk fitting the character" },
  { id: "run", label: "action.run", prompt: "run fitting the character" },
  { id: "jump", label: "action.jump", prompt: "jump fitting the character" },
  { id: "attack", label: "action.attack", prompt: "attack fitting the character and equipment" },
  { id: "cast", label: "action.cast", prompt: "cast fitting the character and abilities" },
  { id: "hurt", label: "action.hurt", prompt: "hit reaction fitting the character" },
  { id: "death", label: "action.death", prompt: "defeat fitting the character" },
] as const;
export type ActionPresetId = (typeof ACTION_PRESETS)[number]["id"];

/** 角色 8 向图固定顺序：3×3 环形布局，中心格留空，按从左到右、从上到下读取。 */
export const CHARACTER_DIRECTION_PRESETS = [
  { id: "back-left", label: "direction.backLeft", prompt: "back-left three-quarter view" },
  { id: "back", label: "direction.back", prompt: "back view" },
  { id: "back-right", label: "direction.backRight", prompt: "back-right three-quarter view" },
  { id: "left", label: "direction.left", prompt: "left profile view" },
  { id: "right", label: "direction.right", prompt: "right profile view" },
  { id: "front-left", label: "direction.frontLeft", prompt: "front-left three-quarter view" },
  { id: "front", label: "direction.front", prompt: "front view" },
  { id: "front-right", label: "direction.frontRight", prompt: "front-right three-quarter view" },
] as const;

/** 视频定点抽帧最多时间点数（前后端一致） */
export const EXTRACT_TIMESTAMPS_MAX = 64;

/**
 * 抽帧的采样规则。
 *
 * - `fps`      按固定帧率铺时间点，与视频原生帧率无关
 * - `interval` 每 N 个原生帧取 1 个，等效帧率 = 原生帧率 / N
 *
 * 两者的区别在于「参照物」：fps 参照绝对时间，interval 参照视频自身的帧。
 * 想要「把这段视频抽稀一半」只有 interval 能准确表达。
 */
export const EXTRACT_SAMPLINGS = ["fps", "interval"] as const;
export type ExtractSampling = (typeof EXTRACT_SAMPLINGS)[number];

/** 间隔抽帧的 N 值上限；再大就不如直接调区间 */
export const EXTRACT_INTERVAL_MAX = 60;

/** 原生帧率探测失败时的假定值，UI 必须标注这是估计值 */
export const ASSUMED_SOURCE_FPS = 30;

/** 拼图表最多格数（与网格切分上限对齐） */
export const ACTION_SHEET_MAX_FRAMES = 16;

/** 视频模式：点选注入单个动作（不做拼图表那套 n 帧槽位） */
export const ACTION_VIDEO_MAX_ACTIONS = 1;

/** 按帧数推荐拼图行列（尽量铺满、少空白格） */
export function suggestActionSheetGrid(frameCount: number): { cols: number; rows: number } {
  const n = Math.max(1, Math.min(ACTION_SHEET_MAX_FRAMES, Math.floor(frameCount) || 1));
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n === 3) return { cols: 3, rows: 1 };
  if (n === 4) return { cols: 4, rows: 1 }; // 连续帧优先单行，读序更直观
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: Math.ceil(n / 4) };
}

/**
 * 组装「连续动作拼图表」prompt：短文案优先（MiniMax 等厂商限 ~1500 字符）。
 * 引用图锁角色 + 行列 + 有序帧；强调帧间连续。角色描述/附加描述会被截断。
 */
export function buildActionSheetPrompt(opts: {
  /** 有序帧序列（可含重复动作 id） */
  frames: Array<{ id: string; label: string; prompt: string }>;
  cols: number;
  rows: number;
  characterPrompt?: string | null;
  extra?: string | null;
}): string {
  const cols = Math.max(1, Math.min(8, Math.floor(opts.cols) || 1));
  const rows = Math.max(1, Math.min(8, Math.floor(opts.rows) || 1));
  const frames = opts.frames.slice(0, cols * rows);
  const n = frames.length;
  const sameAction = n > 0 && frames.every((f) => f.id === frames[0]!.id);
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

  const a0 = frames[0];
  const head = sameAction && a0
    ? `Same character as reference. One ${rows}×${cols} sprite sheet: ${n}-frame continuous ${a0.prompt} cycle, L→R then T→B. Identical look each panel; smooth motion; last loops to first. Plain/transparent bg, no text.`
    : `Same character as reference. One ${rows}×${cols} sprite sheet: ${n}-frame continuous sequence, L→R then T→B. Identical look; smooth panel-to-panel motion. Plain/transparent bg, no text.`;

  const parts = [head];
  const character = opts.characterPrompt?.trim();
  if (character) parts.push(`Char: ${clip(character, 160)}`);
  if (n > 0) {
    parts.push(`Frames: ${frames.map((f, i) => `${i + 1}:${f.id}/${f.prompt}`).join("; ")}`);
  }
  const empty = cols * rows - n;
  if (empty > 0) parts.push(`Blank last ${empty} panel(s).`);
  const extra = opts.extra?.trim();
  if (extra) parts.push(clip(extra, 600));
  // 再保险：整体压到 1400，给 MiniMax 1500 限留余量
  return clip(parts.join(" "), 1400);
}

/** 组装角色 8 向图 prompt：固定姿势、正交镜头和 3×3 环形方向，中心格留空。 */
export function buildCharacterDirectionSheetPrompt(opts: {
  characterPrompt?: string | null;
  extra?: string | null;
}): string {
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  const parts = [
    "Same character as reference. Create exactly one 8-direction character turnaround sprite sheet arranged as 3 columns × 3 rows with 9 equal cells. MANDATORY: every occupied cell must show a visibly different full-body orientation; use all eight distinct 45-degree body headings exactly once, with no repeated or duplicated view. Cell order is fixed: top-left BACK-LEFT (rear and left side visible); top-center BACK (back faces viewer); top-right BACK-RIGHT (rear and right side visible); middle-left LEFT (left profile); center EMPTY; middle-right RIGHT (right profile); bottom-left FRONT-LEFT (face/chest and left side visible); bottom-center FRONT (face/chest toward viewer); bottom-right FRONT-RIGHT (face/chest and right side visible). Rotate the entire character around the vertical axis—not only the head or eyes—while keeping an identical neutral standing pose. Preserve identity, outfit, equipment, colors, proportions, scale, eye level, orthographic camera and lighting. One full character centered per occupied cell, no overlap; center cell completely empty; plain/transparent background; no text, labels, borders or watermark. Do not fill all cells with the reference orientation.",
  ];
  const character = opts.characterPrompt?.trim();
  if (character) parts.push(`Appearance only (ignore pose, view and composition in this description): ${clip(character, 180)}`);
  const extra = opts.extra?.trim();
  if (extra) parts.push(clip(extra, 120));
  return clip(parts.join(" "), 1400);
}

/**
 * 组装「动作视频」prompt：点选一个动作注入，生成一段连续短片（抽帧在素材库单独做）。
 * 不做拼图格点；强调该动作循环与角色一致。
 */
export function buildActionVideoPrompt(opts: {
  actions: Array<{ id: string; label: string; prompt: string }>;
  characterPrompt?: string | null;
  extra?: string | null;
}): string {
  const a0 = opts.actions[0];
  const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
  if (!a0) return clip("Pixel art game character idle loop. Plain bg, no text.", 1400);

  const parts = [
    `Pixel art game character performing continuous ${a0.prompt} loop. Show the entire character, every limb, accessory, and extremity fully inside the frame at all times; use a slightly wide locked camera and keep about 15% empty safe margin on every edge. Keep the complete action trajectory inside this safe area; never touch or cross the frame boundary and never crop any body part, including at the widest pose. Keep identity consistent; smooth motion; clear silhouette; plain or simple bg; no text, no UI, no watermark.`,
  ];
  const character = opts.characterPrompt?.trim();
  if (character) parts.push(`Char: ${clip(character, 200)}`);
  const extra = opts.extra?.trim();
  if (extra) parts.push(clip(extra, 600));
  return clip(parts.join(" "), 1400);
}

/** POST /api/enhance-prompt 请求/响应 */
export interface EnhancePromptRequest {
  /** 缺省用第一个已配置的加强模型 */
  enhancerId?: string;
  prompt: string;
  /** 目标风格（ENHANCE_STYLES 的 id）；缺省/未知值按 pixel 处理 */
  style?: string;
  mediaKind?: "image" | "video";
  /** 生成时已选择的有序引用图数量，用于切换文生图/图生图/多图模板语义。 */
  referenceImageCount?: number;
}

export interface EnhancePromptResponse {
  enhanced: string;
  enhancerName: string;
}

/** GET /api/doctor 单项检查 */
export interface DoctorCheck {
  id: string;
  ok: boolean;
  label: string;
  detail: string;
}

export interface DoctorResponse {
  checks: DoctorCheck[];
}

/** POST /api/provider/test 请求（用表单当前值测试，不要求已保存） */
export interface ProviderTestRequest {
  /** api/gemini/dashscope 实发探测（dashscope 走 compatible-mode/v1/models）；minimax 无轻量探测端点，仅校验字段 */
  type?: "api" | "dashscope" | "gemini" | "minimax";
  apiBaseUrl: string;
  apiKey: string;
  apiModel?: string;
}

/** POST /api/provider/test 响应：连通性 + 延迟 + 模型是否在列表中 */
export interface ProviderTestResponse {
  ok: boolean;
  status?: number;
  latencyMs?: number;
  /** true=模型在 /models 列表中；false=不在；undefined=响应非标准模型列表 */
  modelsFound?: boolean;
  error?: string;
  /** 附加说明（如 minimax 未实发请求） */
  note?: string;
}

/** POST /api/provider/models 请求（用表单当前值拉模型列表，不要求已保存） */
export interface ProviderModelsRequest {
  type: "api" | "dashscope" | "gemini" | "minimax";
  apiBaseUrl: string;
  apiKey: string;
}

/** POST /api/provider/models 响应：模型 id 列表（失败带 error） */
export interface ProviderModelsResponse {
  ok: boolean;
  models?: string[];
  status?: number;
  error?: string;
}

/** WS 广播消息类型 */
export const WS_EVENTS = [
  "job_queued",
  "job_running",
  "job_progress",
  "job_done",
  "job_error",
  "job_cancelled",
  "material_updated",
  "materials_changed",
  "folders_changed",
  "settings_changed",
] as const;
export type WSEventType = (typeof WS_EVENTS)[number];

/** 服务端 settings 表白名单 key。`layout` 随编辑器分栏一并移除，不再接受写入。 */
export const SETTING_KEYS = [
  "theme",
  "lang",
  "genProviders",
  "matting",
  "imageLayers",
  "promptEnhancers",
  "queueConcurrency",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface WSMessage<T = unknown> {
  type: WSEventType;
  payload?: T;
}

/** 素材来源对应的主题色。 */
export const SOURCE_COLORS: Record<MaterialSource, string> = {
  cli: "#8be9fd",
  api: "#50fa7b",
  dashscope: "#ffb86c",
  gemini: "#f1fa8c",
  minimax: "#ff79c6",
  layers: "#00d4aa",
  upload: "#6272a4",
  gif: "#bd93f9",
  mp4: "#ff5555",
  image: "#a4ffff",
  extract: "#8be9fd",
  duplicate: "#caa9fa",
  raster: "#caa9fa",
};

// ===== 实体（API 输出形态：tags/metadata 已解析为 JSON）=====


export interface Folder {
  id: string;
  kind: FolderKind;
  parent_id: string | null;
  name: string;
  sort: number;
  created_at: number;
}











export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  progress: string | null;
  error: string | null;
  created_at: number;
}


// ===== 素材库 =====

export interface Material {
  id: string;
  name: string;
  raw_path: string | null;
  processed_path: string | null;
  status: MaterialStatus;
  source: MaterialSource;
  folder_id: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
  /** 由路径推断：视频素材不可抠图/剪裁，需先抽帧 */
  kind: "image" | "video";
}

/** DB 行形态 */
export interface MaterialRow extends Omit<Material, "status" | "source" | "metadata"> {
  status: string;
  source: string;
  metadata: string;
}

// ===== 请求 / 响应 =====


export interface JobResponse {
  job: Job;
}
export interface JobsResponse {
  jobs: Job[];
}
export interface JobCreatedResponse {
  jobId: string;
  /** 批量请求拆出的全部任务 id；jobId 始终等于第一项。 */
  jobIds?: string[];
}
export interface OkResponse {
  ok: boolean;
}
export interface MaterialsResponse {
  materials: Material[];
}
export interface MaterialResponse {
  material: Material;
}
export interface MaterialCreatedResponse {
  materialId: string;
}
export interface FoldersResponse {
  folders: Folder[];
}
export interface FolderResponse {
  folder: Folder;
}
