import type { JobType } from "@ezgameart/shared";
import { db, uid } from "./db";
import { broadcast } from "./ws";
import { extractFrames, generateMaterials, type ExtractPayload, type GeneratePayload } from "./jobs/extract";
import { getSettingJson } from "./provider";
import { readEnv } from "./env";
import { matteMaterial } from "./jobs/matting";
import { JobCancelledError } from "./jobs/run";
import { splitImageLayers, type ImageLayersPayload } from "./jobs/imageLayers";

export interface JobPayload {
  extract?: ExtractPayload;
  generate?: GeneratePayload;
  matting?: { materialId: string };
  imageLayers?: ImageLayersPayload;
}

// 任务负载只存内存（状态落 SQLite），重启后 queued/running 任务不会恢复
const payloads = new Map<string, JobPayload>();
const controllers = new Map<string, AbortController>();
const waiting: string[] = [];
let running = 0;

/**
 * 任务队列并发数：settings.queueConcurrency 优先（clamp 1~16），env EZGAMEART_QUEUE_CONCURRENCY 兜底，默认 2。
 * 每次实时读取，设置页改动即时生效（pump 频率低，单次轻量 DB 查询开销可忽略）。
 */
export function getQueueConcurrency(): number {
  const clamp = (n: number) => Math.max(1, Math.min(16, Math.floor(n)));
  const saved = getSettingJson<number>("queueConcurrency");
  if (typeof saved === "number" && saved >= 1) return clamp(saved);
  const env = Number(readEnv("QUEUE_CONCURRENCY"));
  if (Number.isFinite(env) && env >= 1) return clamp(env);
  return 2;
}

// 启动时把上次进程遗留的 queued/running 任务标记为中断（负载随内存丢失，不可能再继续）
db.query("UPDATE jobs SET status = 'error', error = '服务重启，任务中断' WHERE status IN ('queued', 'running')").run();

export function createJob(type: JobType, payload: JobPayload): string {
  const id = uid();
  db.query("INSERT INTO jobs (id, type, status, created_at) VALUES (?, ?, 'queued', ?)").run(id, type, Date.now());
  payloads.set(id, payload);
  waiting.push(id);
  broadcast("job_queued", { id, type });
  pump();
  return id;
}

/** 图片批量生成拆成独立任务，由全局队列统一控制并发；视频仍只创建一个任务。 */
export function createGenerationJobs(generate: GeneratePayload): string[] {
  const count = generate.mediaKind === "video" ? 1 : generate.count;
  return Array.from({ length: count }, (_, batchIndex) =>
    createJob("generate_materials", {
      generate: {
        ...generate,
        count: 1,
        batchCount: count,
        batchIndex,
      },
    })
  );
}

/**
 * 取消任务：queued 直接出队；running 触发 AbortSignal。
 * 返回 false 表示不存在或已结束不可取消。
 */
export function cancelJob(id: string): boolean {
  const job = db.query("SELECT id, type, status FROM jobs WHERE id = ?").get(id) as {
    id: string;
    type: string;
    status: string;
  } | null;
  if (!job) return false;
  if (job.status === "queued") {
    const idx = waiting.indexOf(id);
    if (idx >= 0) waiting.splice(idx, 1);
    setJob(id, "cancelled", "已取消", null);
    payloads.delete(id);
    broadcast("job_cancelled", { id, type: job.type });
    return true;
  }
  if (job.status === "running") {
    const c = controllers.get(id);
    if (c && !c.signal.aborted) c.abort();
    return true;
  }
  return false;
}

/** 同一素材是否已有排队或运行中的抠图任务。 */
export function findActiveMattingJob(materialId: string): string | null {
  for (const [jobId, payload] of payloads) {
    const m = payload.matting;
    if (!m || m.materialId !== materialId) continue;
    const row = db.query("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string } | null;
    if (row && (row.status === "queued" || row.status === "running")) return jobId;
  }
  return null;
}

/**
 * 入队抠图（同目标已有 queued/running 则拒绝，避免同一图无限重复抠）。
 * 返回 jobId，或已有任务 id（duplicate=true）。
 */
export function createMattingJob(
  materialId: string
): { jobId: string; duplicate: boolean } {
  const existing = findActiveMattingJob(materialId);
  if (existing) return { jobId: existing, duplicate: true };
  return { jobId: createJob("matting", { matting: { materialId } }), duplicate: false };
}

function enqueueMatting(materialId: string) {
  createMattingJob(materialId); // 已有进行中任务则忽略（拆帧/生成后的自动抠图）
}

function pump() {
  while (running < getQueueConcurrency() && waiting.length > 0) {
    const id = waiting.shift()!;
    // 可能已被取消但尚未移出（竞态兜底）
    const row = db.query("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string } | null;
    if (!row || row.status === "cancelled") {
      payloads.delete(id);
      continue;
    }
    running++;
    runJob(id).finally(() => {
      running--;
      pump();
    });
  }
}

function setJob(id: string, status: string, progress?: string | null, error?: string | null) {
  db.query("UPDATE jobs SET status = ?, progress = COALESCE(?, progress), error = COALESCE(?, error) WHERE id = ?").run(
    status,
    progress ?? null,
    error ?? null,
    id
  );
}

async function runJob(id: string) {
  const job = db.query("SELECT * FROM jobs WHERE id = ?").get(id) as {
    id: string;
    type: string;
  } | null;
  if (!job) return;
  const payload = payloads.get(id) ?? {};
  const ac = new AbortController();
  controllers.set(id, ac);
  const signal = ac.signal;

  // 相同 progress 文本去重（如视频轮询每 5s 的重复心跳），避免无谓 DB 写 + 全局广播
  let lastProgress = "";
  const report = (p: string) => {
    if (signal.aborted) return;
    if (p === lastProgress) return;
    lastProgress = p;
    setJob(id, "running", p);
    broadcast("job_progress", { id, progress: p });
  };
  setJob(id, "running", "开始处理");
  broadcast("job_running", { id });
  try {
    if (signal.aborted) throw new JobCancelledError();
    if (job.type === "extract_frames" && payload.extract) {
      await extractFrames(payload.extract, report, enqueueMatting, signal);
    } else if (job.type === "generate_materials" && payload.generate) {
      await generateMaterials(payload.generate, report, enqueueMatting, signal);
    } else if (job.type === "matting" && payload.matting) {
      if (signal.aborted) throw new JobCancelledError();
      const warn = await matteMaterial(payload.matting.materialId, signal);
      if (warn) report(warn); // 引擎缺失等警告写进 job.progress
    } else if (job.type === "image_layers" && payload.imageLayers) {
      await splitImageLayers(payload.imageLayers, report, signal);
    } else {
      throw new Error(`未知任务类型: ${job.type}`);
    }
    if (signal.aborted) throw new JobCancelledError();
    setJob(id, "done", "完成");
    broadcast("job_done", { id, type: job.type });
  } catch (err) {
    if (err instanceof JobCancelledError || signal.aborted) {
      setJob(id, "cancelled", "已取消", null);
      broadcast("job_cancelled", { id, type: job.type });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[job ${id}] ${job.type} 失败:`, msg);
      setJob(id, "error", null, msg);
      broadcast("job_error", { id, type: job.type, error: msg });
    }
  } finally {
    controllers.delete(id);
    payloads.delete(id);
  }
}
