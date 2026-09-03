// 类型统一来自 @ezgameart/shared，这里再导出方便组件单点引入
import type {
  DoctorResponse,
  EnhancePromptResponse,
  Job,
  JobCreatedResponse,
  JobResponse,
  JobsResponse,
  Folder,
  FolderKind,
  FoldersResponse,
  FolderResponse,
  Material,
  MaterialCreatedResponse,
  MaterialResponse,
  MaterialsResponse,
  OkResponse,
  ProviderTestRequest,
  ProviderTestResponse,
  ProviderModelsRequest,
  ProviderModelsResponse,
  ServerConfig,
  WSMessage,

  GenerationIntent,
  VideoInputMode,
} from "@ezgameart/shared";

export type { DoctorCheck, Job, Material, Folder, FolderKind, WSMessage, GenerationIntent } from "@ezgameart/shared";
export { materialFileUrl, materialImageUrl } from "./api/mediaUrls";
export { wsClient } from "./api/ws";

// ---- fetch 封装 ----
async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

const json = (body: unknown) => ({
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** 生成请求体（引用图按 id 解析路径防注入；旧版单引用字段继续兼容） */
interface GenerateBody {
  prompt: string;
  count: number;
  autoMatting?: boolean;
  /** 素材命名基准（仅 /api/materials/generate；缺省服务端取 prompt 前 24 字符） */
  name?: string;
  referenceMaterialId?: string;

  /** 有序引用图，最多 10 张；来源只有素材库。 */
  references?: Array<{ kind: "material"; id: string }>;

  providerId?: string;
  model?: string;
  /** 生成尺寸（api 系覆盖 provider 默认；空 = 用 provider 配置） */
  size?: string;
  /** 视频模式：只生成视频素材，不抽帧（抽帧走素材详情） */
  mediaKind?: "image" | "video";
  /**
   * 本次请求的视频输入形态，由填写的槽位派生。
   * 服务端靠它区分「首尾同帧循环」与「只要首帧」——单看引用图张数分不出来。
   * 缺省时服务端回退设置页声明与模型名推断。
   */
  videoInputMode?: VideoInputMode;
  /** @deprecated 视频生成不再抽帧 */
  fps?: number;
  /** 落入的素材文件夹（null/缺省 = 未分组） */
  folderId?: string | null;
  intent?: GenerationIntent;
}

export interface LayerMaterialBody {
  layers: number;
  numInferenceSteps: number;
  trueCfgScale: number;
  negativePrompt?: string;
  seed: number;
  autoMatting?: boolean;
}

export const api = {
  getJob: (id: string) => req<JobResponse>(`/api/jobs/${id}`).then((r) => r.job),
  listJobs: () => req<JobsResponse>("/api/jobs").then((r) => r.jobs),
  cancelJob: (id: string) => req<OkResponse>(`/api/jobs/${id}/cancel`, { method: "POST" }),
  getConfig: () => req<ServerConfig>("/api/config"),
  getDoctor: () => req<DoctorResponse>("/api/doctor"),
  testProvider: (body: ProviderTestRequest) =>
    req<ProviderTestResponse>("/api/provider/test", { method: "POST", ...json(body) }),
  listProviderModels: (body: ProviderModelsRequest) =>
    req<ProviderModelsResponse>("/api/provider/models", { method: "POST", ...json(body) }),

  enhancePrompt: (enhancerId: string | undefined, prompt: string, style: string, mediaKind?: "image" | "video", referenceImageCount?: number) =>
    req<EnhancePromptResponse>("/api/enhance-prompt", { method: "POST", ...json({ enhancerId, prompt, style, mediaKind, referenceImageCount }) }),


  // ---- 界面偏好设置（服务端持久化） ----
  getSettings: () => req<Record<string, unknown>>("/api/settings"),
  putSetting: (key: string, value: unknown) =>
    req<OkResponse>(`/api/settings/${key}`, { method: "PUT", ...json({ value }) }),

  // ---- 素材库 ----
  listMaterials: () => req<MaterialsResponse>("/api/materials").then((r) => r.materials),
  renameMaterial: (id: string, name: string) =>
    req<MaterialResponse>(`/api/materials/${id}`, { method: "PATCH", ...json({ name }) }),
  uploadMaterial: (fd: FormData) =>
    req<JobCreatedResponse | MaterialCreatedResponse>("/api/materials/upload", { method: "POST", body: fd }),
  generateMaterial: (body: GenerateBody) =>
    req<JobCreatedResponse>("/api/materials/generate", { method: "POST", ...json(body) }),
  matteMaterial: (id: string) => req<JobCreatedResponse>(`/api/materials/${id}/matting`, { method: "POST" }),
  layerMaterial: (id: string, body: LayerMaterialBody) =>
    req<JobCreatedResponse>(`/api/materials/${id}/layers`, { method: "POST", ...json(body) }),
  /** 视频/GIF 素材抽帧 → 每帧一个新素材；timestamps 定点（仅视频），否则 fps 整段 */
  extractMaterial: (
    id: string,
    body?: { fps?: number; timestamps?: number[]; autoMatting?: boolean; folderId?: string | null }
  ) => req<JobCreatedResponse>(`/api/materials/${id}/extract`, { method: "POST", ...json(body ?? {}) }),
  unmatteMaterial: (id: string) => req<MaterialResponse>(`/api/materials/${id}/unmatting`, { method: "POST" }),
  batchMatteMaterials: (ids: string[]) =>
    req<OkResponse & { count: number; skipped: number }>("/api/materials/batch-matting", {
      method: "POST",
      ...json({ ids }),
    }),
  replaceMaterialImage: (id: string, file: Blob, slot: "raw" | "processed") => {
    const fd = new FormData();
    fd.append("file", file, "crop.png");
    fd.append("slot", slot);
    return req<MaterialResponse>(`/api/materials/${id}/replace-image`, { method: "POST", body: fd });
  },
  batchDeleteMaterials: (ids: string[]) =>
    req<OkResponse & { deleted: number }>("/api/materials/batch-delete", { method: "POST", ...json({ ids }) }),
  listFolders: (kind: FolderKind) =>
    req<FoldersResponse>(`/api/folders?kind=${kind}`).then((r) => r.folders),
  createFolder: (kind: FolderKind, name: string, parentId?: string | null) =>
    req<FolderResponse>("/api/folders", { method: "POST", ...json({ kind, name, parentId: parentId ?? null }) }),
  patchFolder: (id: string, body: { name?: string; parentId?: string | null }) =>
    req<OkResponse>(`/api/folders/${id}`, { method: "PATCH", ...json(body) }),
  deleteFolder: (id: string) => req<OkResponse>(`/api/folders/${id}`, { method: "DELETE" }),
  batchDeleteFolders: (kind: FolderKind, ids: string[]) =>
    req<OkResponse & { deleted: number }>("/api/folders/batch-delete", {
      method: "POST",
      ...json({ kind, ids }),
    }),
  moveItems: (kind: FolderKind, ids: string[], folderId: string | null) =>
    req<OkResponse & { moved: number }>("/api/folders/move-items", {
      method: "POST",
      ...json({ kind, ids, folderId }),
    }),
};
