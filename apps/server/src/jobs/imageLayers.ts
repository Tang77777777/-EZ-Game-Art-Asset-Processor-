import { existsSync, mkdirSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import type { MaterialRow } from "@ezgameart/shared";
import { db, getMaterial, STORAGE_ROOT, uid } from "../db";
import { getImageLayerSettings, imageLayerConfigured } from "../provider";
import { broadcast } from "../ws";
import { matteMaterial } from "./matting";
import { JobCancelledError } from "./run";

export interface ImageLayersPayload {
  materialId: string;
  /** 旧任务兼容：仅在独立配置尚不存在时用于定位原 Provider */
  providerId?: string;
  model?: string;
  layers: number;
  numInferenceSteps: number;
  trueCfgScale: number;
  negativePrompt?: string;
  seed: number;
  autoMatting?: boolean;
}

type LayerValue = string | { url?: unknown; b64_json?: unknown };
const ARRAY_KEYS = ["images", "layers", "output", "outputs"] as const;
const MAX_LAYER_BYTES = 50 * 1024 * 1024;

/** 只读取协议约定位置，避免把响应中的 id 等任意字符串误当图片。 */
export function parseLayerResponse(value: unknown): LayerValue[] {
  const roots: unknown[] = [value];
  if (value && typeof value === "object" && !Array.isArray(value)) roots.push((value as Record<string, unknown>).data);
  for (const root of roots) {
    if (Array.isArray(root)) return root.filter(isLayerValue);
    if (root && typeof root === "object") {
      for (const key of ARRAY_KEYS) {
        const list = (root as Record<string, unknown>)[key];
        if (Array.isArray(list)) return list.filter(isLayerValue);
      }
    }
  }
  return [];
}

function isLayerValue(v: unknown): v is LayerValue {
  if (typeof v === "string") return /^https?:\/\//i.test(v) || /^data:image\//i.test(v);
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (typeof o.url === "string" && (/^https?:\/\//i.test(o.url) || /^data:image\//i.test(o.url))) || typeof o.b64_json === "string";
}

function safeSummary(value: unknown): string {
  if (!value || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return `array(${value.length})`;
  return `object keys: ${Object.keys(value as object).slice(0, 8).join(", ")}`;
}

async function layerBytes(value: LayerValue, signal: AbortSignal): Promise<Uint8Array> {
  const raw = typeof value === "string" ? value : typeof value.url === "string" ? value.url : `data:image/png;base64,${value.b64_json}`;
  if (raw.startsWith("data:")) {
    const match = /^data:image\/[\w.+-]+;base64,([\s\S]+)$/i.exec(raw);
    if (!match) throw new Error("分层响应包含不支持的 data URL");
    // base64 解码前先按理论体积拦截，避免异常响应造成超大 Buffer 分配。
    if (match[1].length > Math.ceil(MAX_LAYER_BYTES * 4 / 3) + 4) throw new Error("单个图层超过 50MB 限制");
    const bytes = Uint8Array.from(Buffer.from(match[1], "base64"));
    if (bytes.byteLength > MAX_LAYER_BYTES) throw new Error("单个图层超过 50MB 限制");
    return bytes;
  }
  const response = await fetch(raw, { signal });
  if (!response.ok) throw new Error(`下载图层失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_LAYER_BYTES) throw new Error("单个图层超过 50MB 限制");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_LAYER_BYTES) throw new Error("单个图层超过 50MB 限制");
  return bytes;
}

async function providerError(response: Response): Promise<string> {
  const text = (await response.text()).slice(0, 2000);
  try {
    const body = JSON.parse(text) as { message?: unknown; error?: unknown };
    const detail = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error :
      body.error && typeof body.error === "object" && typeof (body.error as { message?: unknown }).message === "string"
        ? (body.error as { message: string }).message : "";
    return detail ? `图片分层服务失败（HTTP ${response.status}）：${detail}` : `图片分层服务失败（HTTP ${response.status}）`;
  } catch {
    return `图片分层服务失败（HTTP ${response.status}）`;
  }
}

export async function splitImageLayers(payload: ImageLayersPayload, report: (progress: string) => void, signal: AbortSignal) {
  let material = getMaterial(payload.materialId);
  if (!material) throw new Error("素材不存在");
  const hasProcessed = material.processed_path && existsSync(material.processed_path);
  if (payload.autoMatting && !hasProcessed) {
    report("正在抠图去背");
    await matteMaterial(payload.materialId, signal);
    material = getMaterial(payload.materialId);
    if (!material) throw new Error("抠图后素材不存在");
  }
  const input = material.processed_path && existsSync(material.processed_path) ? material.processed_path : material.raw_path;
  if (!input || !existsSync(input) || /\.(mp4|mov|webm|avi|gif)$/i.test(input)) throw new Error("只支持图片素材分层");
  const settings = getImageLayerSettings(payload.providerId);
  if (!imageLayerConfigured(settings)) throw new Error("图片分层服务未配置完整");
  const model = payload.model?.trim() || settings.model;
  if (signal.aborted) throw new JobCancelledError();
  report("正在调用图片分层服务");
  const form = new FormData();
  const ext = extname(input).toLowerCase() || ".png";
  form.append("image", Bun.file(input), `image${ext}`);
  form.append("model", model);
  form.append("layers", String(payload.layers));
  form.append("num_inference_steps", String(payload.numInferenceSteps));
  form.append("true_cfg_scale", String(payload.trueCfgScale));
  if (payload.negativePrompt) form.append("negative_prompt", payload.negativePrompt);
  form.append("seed", String(payload.seed));
  const response = await fetch(`${settings.apiBaseUrl.trim().replace(/\/+$/, "")}/images/layers`, {
    method: "POST", headers: { Authorization: `Bearer ${settings.apiKey.trim()}` }, body: form, signal,
  });
  if (!response.ok) throw new Error(await providerError(response));
  const json = await response.json() as unknown;
  const layers = parseLayerResponse(json);
  if (!layers.length) throw new Error(`图片分层响应中没有可识别图层（${safeSummary(json)}）`);

  const prepared: Array<{ id: string; dir: string; path: string; bytes: Uint8Array }> = [];
  try {
    for (let i = 0; i < layers.length; i++) {
      if (signal.aborted) throw new JobCancelledError();
      report(`正在保存图层 ${i + 1}/${layers.length}`);
      const id = uid();
      const dir = join(STORAGE_ROOT, "materials", id);
      prepared.push({ id, dir, path: join(dir, "raw.png"), bytes: await layerBytes(layers[i], signal) });
    }
    for (const item of prepared) { mkdirSync(item.dir, { recursive: true }); await Bun.write(item.path, item.bytes); }
    // Bun.write 不可取消；落库前再检查一次，确保已取消任务不会留下已提交素材。
    if (signal.aborted) throw new JobCancelledError();
    const insert = db.query("INSERT INTO materials (id, name, raw_path, status, source, folder_id, metadata, created_at) VALUES (?, ?, ?, 'raw', ?, ?, ?, ?)");
    db.transaction(() => prepared.forEach((item, i) => insert.run(
      item.id, `${material.name || "素材"} 图层 ${i + 1}`, item.path, "layers", material.folder_id,
      JSON.stringify({ fromMaterial: material.id, layerIndex: i, layerCount: prepared.length, provider: "imageLayers", model,
        layerSplit: { layers: payload.layers, numInferenceSteps: payload.numInferenceSteps, trueCfgScale: payload.trueCfgScale, negativePrompt: payload.negativePrompt ?? "", seed: payload.seed } }),
      Date.now() + i
    )))();
  } catch (error) {
    for (const item of prepared) rmSync(item.dir, { recursive: true, force: true });
    throw error;
  }
  broadcast("materials_changed", {});
}
