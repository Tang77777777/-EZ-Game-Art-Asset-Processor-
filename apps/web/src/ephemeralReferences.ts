import { api } from "./api";
import { wsClient } from "./api/ws";

/**
 * 「临时引用」素材的隔离与回收。
 *
 * 背景：生成时想拿一张本地图当引用图，但引用图在服务端只能按 material / frame 的 id
 * 解析（见 providerAdapter.resolveReferencePaths）。最短路是把本地文件先上传成素材
 * ——`POST /api/materials/upload` 对单图是同步入库并返回 materialId，拿到就能用。
 *
 * 代价是会往素材库塞东西。所以这里做两件事：
 *   1. 全部塞进一个固定的「临时引用」文件夹，与用户自己的素材隔开；
 *   2. 关联的生成任务一结束就删掉。
 *
 * **不能在提交后立刻删。** referencePaths 是在入队时解析成绝对路径存进 job payload 的，
 * 但文件要等任务真正跑起来才读；提前删会让任务报「素材文件缺失」。所以只能等任务到达
 * 终态（done / error / cancelled）再回收。
 */

/** 固定文件夹名。这是持久化数据而非界面文案，因此不走 i18n（否则切语言就找不到旧文件夹）。 */
export const EPHEMERAL_FOLDER_NAME = "临时引用";

/**
 * 超过这个时长仍留在临时文件夹里的素材视为遗留，下次打开选择器时收走。
 * 浏览器在任务跑完前被关掉/刷新时，上面的 WS 回收就不会执行，需要这道兜底。
 * 6 小时远大于任何一次生成任务（分钟级），不会误删正在用的引用图。
 */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

let folderIdPromise: Promise<string> | null = null;

/** 查找临时引用文件夹；不存在返回 null（不创建） */
async function findEphemeralFolderId(): Promise<string | null> {
  const folders = await api.listFolders("material");
  return folders.find((f) => f.parent_id === null && f.name === EPHEMERAL_FOLDER_NAME)?.id ?? null;
}

/** 取得临时引用文件夹，不存在则创建。结果缓存，失败不缓存以便重试。 */
export async function ensureEphemeralFolder(): Promise<string> {
  if (!folderIdPromise) {
    folderIdPromise = (async () => {
      const existing = await findEphemeralFolderId();
      if (existing) return existing;
      const created = await api.createFolder("material", EPHEMERAL_FOLDER_NAME);
      return created.folder.id;
    })().catch((error: unknown) => {
      folderIdPromise = null;
      throw error;
    });
  }
  return folderIdPromise;
}

/**
 * 一组共用同一批引用图的任务。
 *
 * 必须按「组」而不是按单个任务回收：图片生成会被 createGenerationJobs 拆成 count 个
 * 任务（`/api/import/generate` 就返回 jobIds 数组），它们读的是同一批引用文件。
 * 只等第一个任务结束就删，剩下的任务会报「素材文件缺失」。
 */
interface PendingGroup {
  /** 还没到终态的任务 */
  remaining: Set<string>;
  materialIds: string[];
}

const groups: PendingGroup[] = [];
let unsubscribe: (() => void) | null = null;

function ensureSubscribed(): void {
  if (unsubscribe) return;
  wsClient.start();
  unsubscribe = wsClient.subscribe((message) => {
    if (message.type !== "job_done" && message.type !== "job_error" && message.type !== "job_cancelled") return;
    const jobId = (message.payload as { id?: string } | undefined)?.id;
    if (!jobId) return;
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index]!;
      if (!group.remaining.delete(jobId)) continue;
      if (group.remaining.size > 0) break; // 同组还有任务在跑，先别删
      groups.splice(index, 1);
      // 回收失败不打扰用户：素材留在隔离文件夹里，下次 purgeStaleEphemeral 会收
      void api.batchDeleteMaterials(group.materialIds).catch(() => {});
      break;
    }
  });
}

/**
 * 登记「这一组生成任务全部结束后，删掉这些临时引用素材」。
 *
 * 订阅挂在模块级而不是组件里：素材库的生成弹窗提交后立刻关闭，组件内的订阅会随卸载
 * 一起消失，回收就永远不会发生。
 */
export function cleanupEphemeralAfterJob(jobIds: string | string[], materialIds: string[]): void {
  const ids = (Array.isArray(jobIds) ? jobIds : [jobIds]).filter(Boolean);
  if (!materialIds.length || !ids.length) return;
  ensureSubscribed();
  groups.push({ remaining: new Set(ids), materialIds });
}

/** 收走遗留的临时引用素材（浏览器提前关闭导致 WS 回收没跑）。失败静默，不影响主流程。 */
export async function purgeStaleEphemeral(): Promise<void> {
  try {
    const folderId = await findEphemeralFolderId();
    if (!folderId) return;
    const materials = await api.listMaterials();
    const cutoff = Date.now() - STALE_AFTER_MS;
    const reserved = new Set<string>();
    for (const group of groups) for (const id of group.materialIds) reserved.add(id);
    const stale = materials
      .filter((m) => m.folder_id === folderId && m.created_at < cutoff && !reserved.has(m.id))
      .map((m) => m.id);
    if (stale.length) await api.batchDeleteMaterials(stale);
  } catch {
    /* 清理是尽力而为，不应阻断生成流程 */
  }
}
