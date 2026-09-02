import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, ChevronUp, Download, Images, Loader2, Play, Sparkles, Trash2, Video, Wand2 } from "lucide-react";
import {
  ASSUMED_SOURCE_FPS,
  EXTRACT_INTERVAL_MAX,
  EXTRACT_SAMPLINGS,
  EXTRACT_TIMESTAMPS_MAX,
  type ExtractSampling,
} from "@ezgameart/shared";
import { api, materialFileUrl, materialImageUrl, type DoctorCheck, type Material } from "../api";
import { useServerConfig } from "../config";
import { transformedFrameRectBounds } from "../frameGeometry";
import { useT } from "../i18n";
import { detectBackgroundColor, findOpaqueBounds, removeColorKey } from "../imageops/client";
import { DEFAULT_COLOR_KEY_TOLERANCE, type RgbColor } from "../imageops/ops";
import { notify } from "../notice";
import { packSprites, type AtlasFormat, type AtlasMeta, type SpriteCell } from "../spritePack";
import { createZip } from "../zip";
import { buildFrameTimestamps, intervalEffectiveFps, type FrameTimestampOptions } from "../videoFrames";
import GenerateMaterialPanel, { type GeneratedMaterialRequest } from "./GenerateMaterialPanel";

type PipelineSource = "images" | "video" | "generate";
type PipelineStep = "source" | "select" | "extract" | "process" | "export";
type ProcessMode = "colorkey" | "matting" | "skip";

const STEP_FLOW: Record<PipelineSource, PipelineStep[]> = {
  images: ["source", "process", "export"],
  video: ["source", "extract", "process", "export"],
  generate: ["source", "select", "extract", "process", "export"],
};

interface PipelineFrame {
  id: string;
  name: string;
  raw: Blob;
  processed: Blob | null;
  previewUrl: string;
}

/**
 * 注意：不要用 /api/doctor 判断「是否配了生成 provider」。
 * doctor 的 id 是动态的——providers 为空时发一条 id="gen"（必然 ok:false），
 * 一旦配置了就改成每个 provider 一条 id=`gen-${p.id}`。按 "gen" 精确匹配
 * 只可能命中「未配置」那一条，配置得再好也永远判成未配置（曾踩过）。
 * provider 状态一律读 useServerConfig()：它是共享缓存，且设置页保存后会调
 * refreshServerConfig() 通知订阅者，因此能实时更新而不是只在挂载时探测一次。
 */
interface Capabilities {
  loaded: boolean;
  matting: boolean;
}

interface VideoInfo {
  duration: number;
  width: number;
  height: number;
  /** 探测到的原生帧率；null = 测不出来（走 ASSUMED_SOURCE_FPS 估计） */
  fps: number | null;
}

const IDENTITY_TRANSFORM = { offset_x: 0, offset_y: 0, rotation: 0, scale: 1 };
const MATTING_POLL_INTERVAL = 1500;
const MATTING_TIMEOUT = 5 * 60 * 1000;
// 绿幕是最常见的色键素材背景，用户仍可通过原生颜色选择器改为白色或其他颜色。
const DEFAULT_LITE_KEY_COLOR: RgbColor = { r: 0, g: 255, b: 0 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function checkOk(checks: DoctorCheck[], id: string): boolean {
  return checks.find((check) => check.id === id)?.ok ?? false;
}

function toHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function fromHex(hex: string): RgbColor {
  const value = hex.replace("#", "");
  return { r: parseInt(value.slice(0, 2), 16) || 0, g: parseInt(value.slice(2, 4), 16) || 0, b: parseInt(value.slice(4, 6), 16) || 0 };
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function download(blob: Blob, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
}

function makeFrame(blob: Blob, name: string, index: number): PipelineFrame {
  return { id: `${Date.now()}-${index}-${name}`, name: name.replace(/\.[^.]+$/, "") || `frame_${index + 1}`, raw: blob, processed: null, previewUrl: URL.createObjectURL(blob) };
}

async function readVideoInfo(file: Blob): Promise<VideoInfo> {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("视频元数据读取超时")), 10000);
      video.onloadedmetadata = () => { window.clearTimeout(timer); resolve(); };
      video.onerror = () => { window.clearTimeout(timer); reject(new Error("浏览器无法解码该视频")); };
    });
    const fps = await detectSourceFps(video);
    return { duration: Number.isFinite(video.duration) ? video.duration : 0, width: video.videoWidth, height: video.videoHeight, fps };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 探测视频原生帧率，供「每 N 帧取 1 帧」把帧号换算成时间。
 *
 * HTML5 没有直接读帧率的接口，但 requestVideoFrameCallback 会带上每一帧的
 * mediaTime，相邻两帧的 mediaTime 差就是帧间隔。这里静音播放几帧就够了，
 * 不需要走完整段视频。
 *
 * 返回 null 表示测不出来（Firefox 没有这个接口、或视频起播失败），
 * 调用方要如实告诉用户当前用的是估计值，不能假装知道。
 */
async function detectSourceFps(video: HTMLVideoElement): Promise<number | null> {
  type FrameMeta = { mediaTime: number };
  type WithCallback = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: (now: number, meta: FrameMeta) => void) => number;
    cancelVideoFrameCallback?: (handle: number) => void;
  };
  const target = video as WithCallback;
  if (typeof target.requestVideoFrameCallback !== "function") return null;

  const previousMuted = video.muted;
  video.muted = true;
  const times: number[] = [];
  let handle = 0;

  try {
    await new Promise<void>((resolve) => {
      // 采到 6 帧就够算中位间隔；1.5s 内没采够就用手上的数据收工
      const timer = window.setTimeout(resolve, 1500);
      const step = (_now: number, meta: FrameMeta) => {
        times.push(meta.mediaTime);
        if (times.length >= 6) {
          window.clearTimeout(timer);
          resolve();
          return;
        }
        handle = target.requestVideoFrameCallback!(step);
      };
      handle = target.requestVideoFrameCallback!(step);
      video.play().catch(() => {
        // 自动播放被拦或解码失败：让超时兜底，不要卡住整个读取流程
      });
    });
  } finally {
    if (handle && typeof target.cancelVideoFrameCallback === "function") target.cancelVideoFrameCallback(handle);
    video.pause();
    video.currentTime = 0;
    video.muted = previousMuted;
  }

  const deltas: number[] = [];
  for (let index = 1; index < times.length; index++) {
    const delta = times[index]! - times[index - 1]!;
    if (delta > 1e-4) deltas.push(delta);
  }
  if (!deltas.length) return null;
  // 取中位数而非均值：起播头几帧的间隔常被解码抖动拉偏
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)]!;
  const fps = Math.round(1 / median);
  return fps >= 1 && fps <= 240 ? fps : null;
}

async function captureVideoFrames(file: Blob, timestamps: number[], onProgress?: (done: number, total: number) => void): Promise<PipelineFrame[]> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(file);
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  const canvas = document.createElement("canvas");
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("视频加载超时")), 12000);
      video.onloadedmetadata = () => { window.clearTimeout(timer); resolve(); };
      video.onerror = () => { window.clearTimeout(timer); reject(new Error("浏览器无法解码该视频")); };
    });
    canvas.width = video.videoWidth || 1;
    canvas.height = video.videoHeight || 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建视频画布");
    ctx.imageSmoothingEnabled = false;
    const frames: PipelineFrame[] = [];
    for (let index = 0; index < timestamps.length; index++) {
      const target = Math.min(Math.max(0, timestamps[index]!), Math.max(0, video.duration - 0.001));
      await new Promise<void>((resolve, reject) => {
        const onSeeked = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(new Error(`视频定位失败 @ ${target.toFixed(3)}s`)); };
        const cleanup = () => { video.removeEventListener("seeked", onSeeked); video.removeEventListener("error", onError); };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", onError, { once: true });
        if (Math.abs(video.currentTime - target) < 0.001 && video.readyState >= 2) { cleanup(); resolve(); } else video.currentTime = target;
      });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("视频帧编码失败");
      frames.push(makeFrame(blob, `frame_${String(index + 1).padStart(4, "0")}.png`, index));
      onProgress?.(index + 1, timestamps.length);
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

export default function PipelinePage() {
  const t = useT();
  const [caps, setCaps] = useState<Capabilities>({ loaded: false, matting: false });
  const serverConfig = useServerConfig();
  /** 是否已有可用的生成 provider；随设置页保存实时更新 */
  const hasGenProvider = (serverConfig?.gen?.providers ?? []).some((provider) => provider.configured);
  const [source, setSource] = useState<PipelineSource | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [frames, setFrames] = useState<PipelineFrame[]>([]);
  const [mode, setMode] = useState<ProcessMode>("colorkey");
  const [keyColor, setKeyColor] = useState<RgbColor>(DEFAULT_LITE_KEY_COLOR);
  const [tolerance, setTolerance] = useState(DEFAULT_COLOR_KEY_TOLERANCE);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState("");
  const [format, setFormat] = useState<AtlasFormat>("spritesheet");
  const [fps, setFps] = useState(8);
  const [cellWidth, setCellWidth] = useState(0);
  const [cellHeight, setCellHeight] = useState(0);
  const [columns, setColumns] = useState(0);
  const [rows, setRows] = useState(0);
  const [spacing, setSpacing] = useState(0);
  const [maxDimension, setMaxDimension] = useState(16384);
  const [busy, setBusy] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewMeta, setPreviewMeta] = useState<AtlasMeta | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  /** 当前正被拖拽悬停的来源上传区（null = 没有） */
  const [dragSource, setDragSource] = useState<"images" | "video" | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [extractStrategy, setExtractStrategy] = useState<ExtractSampling>("fps");
  const [extractFps, setExtractFps] = useState(8);
  /** 每 N 个原生帧取 1 个；4 是抽稀动画的常用起点（24fps → 6fps） */
  const [extractInterval, setExtractInterval] = useState(4);
  const [maxFrames, setMaxFrames] = useState(24);
  const [rangeStart, setRangeStart] = useState(0);
  const [rangeEnd, setRangeEnd] = useState(0);

  const [generatedCandidates, setGeneratedCandidates] = useState<Material[]>([]);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedCandidateKind, setSelectedCandidateKind] = useState<"image" | "video" | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);

  const framesRef = useRef<PipelineFrame[]>(frames);
  framesRef.current = frames;
  const workspaceFolderRef = useRef<string | null>(null);
  const [pipelineFolderId, setPipelineFolderId] = useState<string | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  videoUrlRef.current = videoUrl;
  previewUrlRef.current = previewUrl;

  useEffect(() => {
    let alive = true;
    api.getDoctor().then((res) => { if (alive) setCaps({ loaded: true, matting: checkOk(res.checks, "matting-engine") }); }).catch(() => alive && setCaps((prev) => ({ ...prev, loaded: true })));
    return () => { alive = false; };
  }, []);

  useEffect(() => () => {
    framesRef.current.forEach((frame) => URL.revokeObjectURL(frame.previewUrl));
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  useEffect(() => {
    if (caps.loaded && !caps.matting && mode === "matting") setMode("colorkey");
  }, [caps.loaded, caps.matting, mode]);

  const steps = useMemo(() => (source ? STEP_FLOW[source] : STEP_FLOW.images), [source]);
  const step = steps[Math.min(stepIndex, steps.length - 1)]!;
  const processedCount = frames.filter((frame) => frame.processed).length;
  const selectedCandidate = generatedCandidates.find((item) => item.id === selectedCandidateId) ?? null;

  const replaceFrames = useCallback((next: PipelineFrame[]) => {
    setFrames((prev) => { const keep = new Set(next.map((frame) => frame.previewUrl)); prev.forEach((frame) => { if (!keep.has(frame.previewUrl)) URL.revokeObjectURL(frame.previewUrl); }); return next; });
  }, []);

  const resetWorkspace = useCallback(() => {
    replaceFrames([]);
    setStepIndex(0);
    setSelectedCandidateId(null);
    setSelectedCandidateKind(null);
    setGeneratedCandidates([]);
    setVideoFile(null);
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoUrl(null);
    setVideoInfo(null);
    setRangeStart(0);
    setRangeEnd(0);
    setProgress("");
    setCandidateLoading(false);
  }, [replaceFrames, videoUrl]);

  const selectSource = (next: PipelineSource) => {
    if (source !== next) resetWorkspace();
    setSource(next);
    if (next === "generate") void ensureWorkspaceFolder();
  };

  const addFiles = useCallback(async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const picked = [...fileList].filter((file) => file.type.startsWith("image/"));
    if (!picked.length) { notify(t("pipeline.noImagePicked")); return; }
    picked.sort((a, b) => naturalCompare(a.name, b.name));
    const added = picked.map((file, index) => makeFrame(file, file.name, index));
    setFrames((prev) => [...prev, ...added]);
    if (!framesRef.current.length && added[0]) { const guessed = await detectBackgroundColor(added[0].raw).catch(() => null); if (guessed) setKeyColor(guessed); }
  }, [t]);

  const removeFrame = (id: string) => replaceFrames(framesRef.current.filter((frame) => frame.id !== id));
  const moveFrame = (id: string, delta: number) => {
    const list = [...framesRef.current];
    const from = list.findIndex((frame) => frame.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;
    [list[from], list[to]] = [list[to]!, list[from]!];
    setFrames(list);
  };

  const ensureWorkspaceFolder = async (): Promise<string | null> => {
    if (workspaceFolderRef.current) return workspaceFolderRef.current;
    const created = await api.createFolder("material", t("pipeline.workspaceFolderName", { date: new Date().toLocaleString() })).catch(() => null);
    workspaceFolderRef.current = created?.folder.id ?? null;
    setPipelineFolderId(workspaceFolderRef.current);
    return workspaceFolderRef.current;
  };

  const waitForJob = async (jobId: string, label: string) => {
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(t("pipeline.jobTimeout"));
      const job = await api.getJob(jobId);
      setProgress(job.progress ? `${label}：${job.progress}` : label);
      if (job.status === "done") return;
      if (job.status === "error" || job.status === "cancelled") throw new Error(job.error ?? t("pipeline.jobFailed"));
      await sleep(750);
    }
  };

  const uploadFrames = async (folderId: string | null, withProcessed: boolean, onProgress?: (done: number) => void) => {
    const ids: string[] = [];
    for (const [index, frame] of frames.entries()) {
      const form = new FormData();
      form.append("file", frame.raw, `${frame.name || `frame_${index}`}.png`);
      if (withProcessed && frame.processed) form.append("processedFile", frame.processed, "processed.png");
      if (folderId) form.append("folderId", folderId);
      const result = await api.uploadMaterial(form);
      if (!("materialId" in result)) throw new Error(t("pipeline.uploadUnexpected"));
      ids.push(result.materialId);
      onProgress?.(index + 1);
    }
    return ids;
  };

  const runAiMatting = async () => {
    if (!frames.length || processing) return;
    setProcessing(true);
    let uploaded: string[] = [];
    try {
      const folderId = await ensureWorkspaceFolder();
      setProgress(t("pipeline.mattingUploading", { done: 0, total: frames.length }));
      uploaded = await uploadFrames(folderId, false, (done) => setProgress(t("pipeline.mattingUploading", { done, total: frames.length })));
      const queued = await api.batchMatteMaterials(uploaded);
      if (queued.count === 0) throw new Error(t("pipeline.mattingNothingQueued"));
      const pending = new Set(uploaded);
      const deadline = Date.now() + MATTING_TIMEOUT;
      while (pending.size) {
        if (Date.now() > deadline) throw new Error(t("pipeline.mattingTimeout"));
        await sleep(MATTING_POLL_INTERVAL);
        const all = await api.listMaterials();
        const byId = new Map(all.map((item) => [item.id, item]));
        for (const id of [...pending]) { const material = byId.get(id); if (!material) throw new Error(t("pipeline.mattingMaterialGone")); if (material.status === "matted") pending.delete(id); }
        setProgress(t("pipeline.mattingProgress", { done: uploaded.length - pending.size, total: uploaded.length }));
      }
      const results: Blob[] = [];
      for (const id of uploaded) { const response = await fetch(materialImageUrl(id, Date.now(), "processed", undefined, true)); if (!response.ok) throw new Error(t("pipeline.mattingFetchFailed", { msg: `HTTP ${response.status}` })); results.push(await response.blob()); }
      setFrames((prev) => prev.map((frame, index) => { const processed = results[index]; if (!processed) return frame; URL.revokeObjectURL(frame.previewUrl); return { ...frame, processed, previewUrl: URL.createObjectURL(processed) }; }));
      notify(t("pipeline.processDone", { n: results.length }), "info");
    } catch (error) { notify(t("pipeline.mattingFailed", { msg: (error as Error).message })); }
    finally { if (uploaded.length) await api.batchDeleteMaterials(uploaded).catch(() => undefined); setProgress(""); setProcessing(false); }
  };

  const runColorKey = async () => {
    if (!frames.length || processing) return;
    setProcessing(true);
    try {
      const next: PipelineFrame[] = [];
      for (const frame of frames) { const processed = await removeColorKey(frame.raw, { color: keyColor, tolerance }); URL.revokeObjectURL(frame.previewUrl); next.push({ ...frame, processed, previewUrl: URL.createObjectURL(processed) }); }
      setFrames(next);
      notify(t("pipeline.processDone", { n: next.length }), "info");
    } catch (error) { notify(t("pipeline.processFailed", { msg: (error as Error).message })); }
    finally { setProcessing(false); }
  };

  const resetProcessing = () => setFrames(framesRef.current.map((frame) => { URL.revokeObjectURL(frame.previewUrl); return { ...frame, processed: null, previewUrl: URL.createObjectURL(frame.raw) }; }));

  /**
   * 抽帧参数的唯一拼装处。预览用的 extractTimestamps 和真正执行的 runExtract
   * 必须完全一致，此前两处各写一遍同样的表达式，改一处漏一处就会出现
   * 「预计 12 帧、实际抽出 40 帧」。
   *
   * 最大帧数从「独立策略」降级为两种模式共用的上限：它本来就不是一种抽法，
   * 只是个封顶，做成互斥选项才让人觉得选了它却没变化。
   */
  const buildExtractOptions = useCallback(
    (duration: number, sourceFps: number | null): FrameTimestampOptions => ({
      start: rangeStart,
      end: rangeEnd || duration,
      mode: extractStrategy,
      fps: extractFps,
      interval: extractInterval,
      sourceFps: sourceFps ?? ASSUMED_SOURCE_FPS,
      maxFrames,
    }),
    [extractFps, extractInterval, extractStrategy, maxFrames, rangeEnd, rangeStart]
  );

  const extractTimestamps = useMemo(
    () => (videoInfo ? buildFrameTimestamps(buildExtractOptions(videoInfo.duration, videoInfo.fps)) : []),
    [buildExtractOptions, videoInfo]
  );

  const loadVideoFile = async (file: File) => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    try { const info = await readVideoInfo(file); setVideoInfo(info); setRangeStart(0); setRangeEnd(info.duration); setStepIndex(STEP_FLOW.video.indexOf("extract")); }
    catch (error) { setVideoInfo(null); notify(t("pipeline.videoReadFailed", { msg: (error as Error).message })); }
  };

  const collectNewMaterials = async (before: Set<string>, folderId: string | null) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const materials = await api.listMaterials();
      const found = materials.filter((item) => !before.has(item.id) && item.folder_id === folderId && item.kind === "image" && item.source === "extract").sort((a, b) => naturalCompare(a.name, b.name));
      if (found.length) return found;
      await sleep(500);
    }
    return [];
  };

  const extractFromServer = async (file: Blob, name: string, info: VideoInfo, timestamps: number[]) => {
    const folderId = await ensureWorkspaceFolder();
    const before = new Set((await api.listMaterials()).map((item) => item.id));
    const form = new FormData();
    form.append("file", file, name);
    form.append("fps", String(extractFps));
    form.append("deferExtract", "true");
    if (folderId) form.append("folderId", folderId);
    const result = await api.uploadMaterial(form);
    if (!("materialId" in result)) throw new Error(t("pipeline.extractUnexpected"));
    const extractJob = await api.extractMaterial(result.materialId, {
      fps: extractFps,
      timestamps,
      folderId,
    });
    await waitForJob(extractJob.jobId, t("pipeline.extracting"));
    const materials = await collectNewMaterials(before, folderId);
    if (!materials.length) throw new Error(t("pipeline.noExtractedFrames"));
    const next: PipelineFrame[] = [];
    for (const [index, material] of materials.slice(0, EXTRACT_TIMESTAMPS_MAX).entries()) { const response = await fetch(materialImageUrl(material.id, Date.now(), "raw", undefined, true)); if (response.ok) next.push(makeFrame(await response.blob(), `${name}_${String(index + 1).padStart(4, "0")}.png`, index)); }
    await api.batchDeleteMaterials([result.materialId, ...materials.map((item) => item.id)]).catch(() => undefined);
    return next;
  };

  const runExtract = async () => {
    if (processing) return;
    if (source === "generate" && selectedCandidateKind === "image" && selectedCandidate) {
      setProcessing(true);
      try { const response = await fetch(materialImageUrl(selectedCandidate.id, Date.now(), "raw", undefined, true)); if (!response.ok) throw new Error(t("pipeline.generatedFetchFailed")); replaceFrames([makeFrame(await response.blob(), selectedCandidate.name, 0)]); }
      catch (error) { notify(t("pipeline.extractFailed", { msg: (error as Error).message })); }
      finally { setProcessing(false); }
      return;
    }
    let file: Blob | null = null;
    if (source === "video") file = videoFile;
    else if (selectedCandidate?.kind === "video") { const response = await fetch(materialFileUrl(selectedCandidate.id, Date.now(), "raw")); if (response.ok) file = await response.blob(); }
    if (!file) return;
    const info = source === "video" ? videoInfo : await readVideoInfo(file).catch(() => null);
    if (!info) return;
    const timestamps = buildFrameTimestamps(buildExtractOptions(info.duration, info.fps));
    setProcessing(true);
    try {
      let next: PipelineFrame[];
      try { next = await captureVideoFrames(file, timestamps, (done, total) => setProgress(t("pipeline.extractProgress", { done, total }))); }
      catch { setProgress(t("pipeline.extractFallback")); next = await extractFromServer(file, source === "video" ? videoFile?.name || "video" : selectedCandidate?.name || "video", info, timestamps); }
      replaceFrames(next);
      notify(t("pipeline.extractDone", { n: next.length }), "info");
    } catch (error) { notify(t("pipeline.extractFailed", { msg: (error as Error).message })); }
    finally { setProgress(""); setProcessing(false); }
  };

  const handleGenerateQueued = async ({ jobId, name }: GeneratedMaterialRequest) => {
    if (candidateLoading) return;
    setCandidateLoading(true);
    try {
      const folderId = pipelineFolderId ?? workspaceFolderRef.current;
      await waitForJob(jobId, t("pipeline.generating"));
      let candidates: Material[] = [];
      for (let attempt = 0; attempt < 12 && !candidates.length; attempt++) {
        const materials = await api.listMaterials();
        candidates = materials
          .filter((item) => item.folder_id === folderId && item.name.startsWith(name))
          .sort((a, b) => naturalCompare(a.name, b.name));
        if (!candidates.length) await sleep(500);
      }
      if (!candidates.length) throw new Error(t("pipeline.noGeneratedResults"));
      setGeneratedCandidates(candidates); setSelectedCandidateId(null); setSelectedCandidateKind(null); setStepIndex(1);
    } catch (error) { notify(t("pipeline.generateFailed", { msg: (error as Error).message })); }
    finally { setProgress(""); setCandidateLoading(false); }
  };

  const selectCandidate = async (candidate: Material) => {
    setSelectedCandidateId(candidate.id); setSelectedCandidateKind(candidate.kind);
    if (candidate.kind === "image") {
      setVideoInfo(null);
      setRangeStart(0);
      setRangeEnd(0);
      setProcessing(true);
      try { const response = await fetch(materialImageUrl(candidate.id, Date.now(), "raw", undefined, true)); if (!response.ok) throw new Error(t("pipeline.generatedFetchFailed")); replaceFrames([makeFrame(await response.blob(), candidate.name, 0)]); }
      catch { notify(t("pipeline.generatedFetchFailed")); }
      finally { setProcessing(false); }
    } else {
      replaceFrames([]);
      setVideoInfo(null);
      try {
        const response = await fetch(materialFileUrl(candidate.id, candidate.created_at, "raw"));
        if (!response.ok) throw new Error(t("pipeline.generatedFetchFailed"));
        const info = await readVideoInfo(await response.blob());
        setVideoInfo(info);
        setRangeStart(0);
        setRangeEnd(info.duration);
      } catch (error) {
        notify(t("pipeline.videoReadFailed", { msg: (error as Error).message }));
      }
    }
  };

  const buildCells = async (): Promise<{ cells: SpriteCell[]; dispose: () => void }> => {
    const bitmaps: ImageBitmap[] = [];
    const dispose = () => bitmaps.forEach((bitmap) => bitmap.close());
    try {
      const cells: SpriteCell[] = [];
      for (const frame of frames) {
        const blob = frame.processed ?? frame.raw;
        const [bitmap, opaque] = await Promise.all([createImageBitmap(blob), findOpaqueBounds(blob)]);
        bitmaps.push(bitmap);
        const halfWidth = bitmap.width / 2; const halfHeight = bitmap.height / 2;
        cells.push({ bounds: opaque ? [transformedFrameRectBounds(bitmap.width, bitmap.height, opaque, IDENTITY_TRANSFORM)] : [], duration: 1, draw: (ctx, origin) => { ctx.save(); ctx.translate(origin.x, origin.y); ctx.imageSmoothingEnabled = false; ctx.drawImage(bitmap, -halfWidth, -halfHeight); ctx.restore(); } });
      }
      return { cells, dispose };
    } catch (error) { dispose(); throw error; }
  };

  const atlasOptions = (name: string) => ({ name, format, fps, ...(cellWidth > 0 ? { cellWidth } : {}), ...(cellHeight > 0 ? { cellHeight } : {}), ...(columns > 0 ? { columns } : {}), ...(rows > 0 ? { rows } : {}), spacing, maxWidth: maxDimension, maxHeight: maxDimension });

  useEffect(() => {
    if (step !== "export" || !frames.length) return;
    let cancelled = false;
    setPreviewBusy(true);
    void buildCells().then(async ({ cells, dispose }) => {
      try {
        const name = frames[0]?.name || t("pipeline.namePrefix");
        const result = await packSprites(cells, atlasOptions(name));
        if (cancelled) return;
        const imageEntry = format === "spritesheet" ? result.entries.find((entry) => entry.name === `${name}.png`) : undefined;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        if (imageEntry) {
          const bytes = new Uint8Array(imageEntry.data.byteLength);
          bytes.set(imageEntry.data);
          setPreviewUrl(URL.createObjectURL(new Blob([bytes.buffer], { type: "image/png" })));
        } else {
          setPreviewUrl(null);
        }
        setPreviewMeta(result.meta);
      } catch (error) { if (!cancelled) notify(t("pipeline.previewFailed", { msg: (error as Error).message })); }
      finally { dispose(); if (!cancelled) setPreviewBusy(false); }
    }).catch((error) => { if (!cancelled) { setPreviewBusy(false); notify(t("pipeline.previewFailed", { msg: (error as Error).message })); } });
    return () => { cancelled = true; };
  }, [cellHeight, cellWidth, columns, format, fps, frames, maxDimension, rows, spacing, step, t]);

  useEffect(() => {
    if (step !== "export" || !frames.length) return;
    const timer = window.setInterval(() => setPreviewIndex((index) => (index + 1) % frames.length), 1000 / Math.max(1, fps));
    return () => window.clearInterval(timer);
  }, [fps, frames.length, step]);

  const runExport = async () => {
    if (!frames.length || busy) return;
    setBusy("export");
    try { const { cells, dispose } = await buildCells(); try { const name = frames[0]?.name || t("pipeline.namePrefix"); const { entries } = await packSprites(cells, atlasOptions(name)); download(await createZip(entries), `${name}_${format}.zip`); } finally { dispose(); } notify(t("pipeline.exportDone"), "info"); }
    catch (error) { notify(t("pipeline.exportFailed", { msg: (error as Error).message })); }
    finally { setBusy(""); }
  };

  const sourceCards = [
    { id: "images" as const, icon: Images, available: true, hint: t("pipeline.source.imagesHint") },
    { id: "video" as const, icon: Video, available: true, hint: t("pipeline.source.videoHint") },
    { id: "generate" as const, icon: Sparkles, available: true, hint: serverConfig && !hasGenProvider ? t("pipeline.needProvider") : t("pipeline.source.generateHint") },
  ];

  const canAdvance = step === "source" ? source === "images" ? frames.length > 0 : source === "video" ? !!videoFile && !!videoInfo : generatedCandidates.length > 0 : step === "select" ? !!selectedCandidateId : step === "extract" ? frames.length > 0 : step === "process" ? frames.length > 0 : false;

  const activeFrame = frames[previewIndex] ?? frames[0];
  const previewCandidate = selectedCandidate ?? generatedCandidates[0];
  const workspaceVariant = step === "process" ? "process" : step === "export" ? "export" : "default";

  const isStepComplete = (item: PipelineStep) => {
    if (item === "source") {
      return source === "images" ? frames.length > 0 : source === "video" ? !!videoFile && !!videoInfo : generatedCandidates.length > 0;
    }
    if (item === "select") return source === "generate" && !!selectedCandidateId;
    if (item === "extract") return frames.length > 0 && (source === "video" || selectedCandidateKind === "video" || selectedCandidateKind === "image");
    if (item === "process") return frames.length > 0 && (mode === "skip" || processedCount === frames.length);
    return false;
  };

  const goToStep = (targetIndex: number) => {
    if (busy || processing || candidateLoading) return;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    setStepIndex(targetIndex);
  };

  return (
    <div className="pipeline-page">
      {step === "source" && (
        <header className="pipeline-gallery-heading">
          <div>
            <span className="pipeline-eyebrow">{t("pipeline.eyebrow")}</span>
            <h1>{t("pipeline.heading")}</h1>
            <p>{t("pipeline.subtitle")}</p>
          </div>
          <span className="pipeline-gallery-count">{frames.length ? t("pipeline.frameCount", { n: frames.length }) : t("pipeline.startEmpty")}</span>
        </header>
      )}
      <div className="pipeline-context-bar">
        <div className="pipeline-context-copy">
          <span className="pipeline-eyebrow">{t("pipeline.eyebrow")}</span>
          <strong>{t(`pipeline.step.${step}`)}</strong>
          {source && <span className="muted">{t(`pipeline.source.${source}`)}</span>}
        </div>
        <span className="pipeline-context-status">{progress || (frames.length ? t("pipeline.frameCount", { n: frames.length }) : "")}</span>
      </div>

      {/* 步骤条：圆点 + 标签 + 自适应连接线。当前用 --purple，数据已完成用 --success，
          已走过但数据为空用低饱和紫（与连线同族），未到达用弱化色；连线在「已走过」
          的区段点亮。样式集中在 styles.css 的「Pipeline 步骤条」分区，那里是唯一定义，
          不要再追加覆盖层。 */}
      <ol className="pipeline-steps" aria-label={t("pipeline.stepsLabel")}>
        {steps.map((item, index) => {
          const isActive = index === stepIndex;
          /*
            「非当前」要分成三种状态，不能只看 isStepComplete：
              done   —— 数据上真的完成了（有帧 / 有视频 / 有候选）
              passed —— 已经走过但数据是空的。Pipeline 刻意允许不上传就往后点，
                        预览抽帧、处理、导出各步的工作区，所以这个状态很常见。
              todo   —— 还没走到
            只用 isStepComplete 判定会让「走过但空着」和「没走到」长得完全一样，
            而连线用的是 index < stepIndex，于是出现线亮着、圆点却是暗的割裂感。
          */
          const isComplete = isStepComplete(item);
          const isPassed = index < stepIndex;
          const state = isActive ? "active" : isComplete ? "done" : isPassed ? "passed" : "todo";
          return (
            <li key={item} className={`pipeline-step is-${state}`}>
              <button
                type="button"
                className="pipeline-step-button"
                aria-current={isActive ? "step" : undefined}
                onClick={() => goToStep(index)}
                disabled={!!busy || processing || candidateLoading}
              >
                <span className="pipeline-step-index" aria-hidden="true">{index + 1}</span>
                <span className="pipeline-step-label">{t(`pipeline.step.${item}`)}</span>
              </button>
              {index < steps.length - 1 && (
                // 连线做成「轨道 + 填充条」：填充条动画 width 而不是整条线换色，
                // 这样推进有方向感。纯色翻转没有指向，观感上只是闪一下。
                <span className="pipeline-step-line" aria-hidden="true">
                  <i className="pipeline-step-line-fill" style={{ width: index < stepIndex ? "100%" : "0%" }} />
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className={`pipeline-workspace-grid pipeline-workspace-grid--${workspaceVariant}`}>
        <main className="pipeline-main-column">
          {/* 步骤面板切换用交叉淡入 + 轻微上移。此前是硬切，而项目里其他页面
              （ProjectList / MaterialsPage / MaterialModal）都走 motion，
              Pipeline 是唯一没有过渡的页面，切步骤时观感突兀。 */}
          <AnimatePresence mode="wait" initial={false}>
          <motion.section
            key={step}
            className="pipeline-body"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            {step === "source" && (
              <div className="pipeline-step-panel pipeline-source-workspace">
                <div className="pipeline-source-switcher" role="tablist" aria-label={t("pipeline.step.source")}>
                  {sourceCards.map(({ id, icon: Icon, available, hint }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={source === id}
                      className={`pipeline-source-card ${source === id ? "selected" : ""} ${available ? "" : "unavailable"}`}
                      onClick={() => available && !candidateLoading && selectSource(id)}
                      disabled={!available || candidateLoading}
                    >
                      <span className="pipeline-source-visual"><Icon size={22} /></span>
                      <span className="pipeline-source-copy"><strong>{t(`pipeline.source.${id}`)}</strong><small>{hint}</small></span>
                    </button>
                  ))}
                </div>

                {/*
                  来源上传区做成「整块可点 + 可拖放」的居中区域。
                  原先只是虚线框里放一个小按钮，而容器又写着 align-items: flex-start，
                  列方向下就成了「垂直居中、水平贴左」，看着像没对齐。
                */}
                {source === "images" && (
                  <div
                    className={`pipeline-picker ${dragSource === "images" ? "dragging" : ""}`.trim()}
                    onDragOver={(event) => { event.preventDefault(); setDragSource("images"); }}
                    onDragLeave={() => setDragSource(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragSource(null);
                      if (event.dataTransfer.files?.length) void addFiles(event.dataTransfer.files);
                    }}
                  >
                    <label className="px-btn accent pipeline-file-label"><Images size={14} />{t("pipeline.pickImages")}<input type="file" accept="image/*" multiple hidden onChange={(event) => void addFiles(event.target.files)} /></label>
                    <span className="muted pipeline-drop-hint">{t("pipeline.dropImagesHint")}</span>
                    <span className="muted">{t("pipeline.frameCount", { n: frames.length })}</span>
                    {!!frames.length && <button type="button" className="px-btn ghost" onClick={() => replaceFrames([])}><Trash2 size={14} />{t("pipeline.clearFrames")}</button>}
                  </div>
                )}

                {/* 整块用 label 包住：点任何位置都能唤起文件对话框，且天然可聚焦、读屏可识别 */}
                {source === "video" && (
                  <label
                    className={`pipeline-video-source ${dragSource === "video" ? "dragging" : ""}`.trim()}
                    onDragOver={(event) => { event.preventDefault(); setDragSource("video"); }}
                    onDragLeave={() => setDragSource(null)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragSource(null);
                      const file = event.dataTransfer.files?.[0];
                      if (file) void loadVideoFile(file);
                    }}
                  >
                    <input type="file" accept="video/*,.gif" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadVideoFile(file); event.target.value = ""; }} />
                    <Video size={26} aria-hidden="true" />
                    <strong>{t("pipeline.pickVideo")}</strong>
                    <span className="muted pipeline-drop-hint">{t("pipeline.dropVideoHint")}</span>
                    {videoFile && <span className="muted">{videoFile.name} · {videoInfo ? `${videoInfo.width}×${videoInfo.height} · ${videoInfo.duration.toFixed(2)}s` : t("pipeline.videoReading")}</span>}
                  </label>
                )}

                {source === "generate" && (
                  <div className="pipeline-generate-form">
                    <GenerateMaterialPanel folderId={pipelineFolderId} namePrefix={t("pipeline.namePrefix")} onQueued={handleGenerateQueued} />
                    {candidateLoading && progress && <span className="muted">{progress}</span>}
                  </div>
                )}
              </div>
            )}

            {step === "select" && (
              <div className="pipeline-step-panel pipeline-select-results">
                <div className="pipeline-section-title"><strong>{t("pipeline.selectResult")}</strong><span className="muted">{t("pipeline.resultCount", { n: generatedCandidates.length })}</span></div>
                <div className="pipeline-candidates">
                  {generatedCandidates.map((candidate) => (
                    <button key={candidate.id} type="button" className={`pipeline-candidate ${selectedCandidateId === candidate.id ? "selected" : ""}`} onClick={() => void selectCandidate(candidate)}>
                      {candidate.kind === "video" ? <video src={materialFileUrl(candidate.id, candidate.created_at, "raw")} muted playsInline preload="metadata" /> : <img src={materialImageUrl(candidate.id, candidate.created_at, "raw", 256)} alt={candidate.name} />}
                      <span>{candidate.name}</span>
                      {selectedCandidateId === candidate.id && <Check size={14} />}
                    </button>
                  ))}
                </div>
                {processing && <span className="muted">{t("pipeline.loadingResult")}</span>}
              </div>
            )}

            {step === "extract" && (
              <div className="pipeline-step-panel pipeline-extract">
                <div className="pipeline-extract-options">
                  <label><span>{t("pipeline.extractStrategy")}</span><select value={extractStrategy} onChange={(event) => setExtractStrategy(event.target.value as ExtractSampling)}>{EXTRACT_SAMPLINGS.map((item) => <option key={item} value={item}>{t(`pipeline.sampling.${item}`)}</option>)}</select></label>
                  {extractStrategy === "fps"
                    ? <label><span>{t("pipeline.extractFps")}</span><input type="number" min={1} max={60} value={extractFps} onChange={(event) => setExtractFps(Math.min(60, Math.max(1, Number(event.target.value) || 8)))} /></label>
                    : <label><span>{t("pipeline.extractInterval")}</span><input type="number" min={1} max={EXTRACT_INTERVAL_MAX} value={extractInterval} onChange={(event) => setExtractInterval(Math.min(EXTRACT_INTERVAL_MAX, Math.max(1, Number(event.target.value) || 1)))} /></label>}
                  {/* 最大帧数对两种模式都生效，所以常驻显示 */}
                  <label><span>{t("pipeline.maxFrames")}</span><input type="number" min={1} max={EXTRACT_TIMESTAMPS_MAX} value={maxFrames} onChange={(event) => setMaxFrames(Math.min(EXTRACT_TIMESTAMPS_MAX, Math.max(1, Number(event.target.value) || 1)))} /></label>
                  {videoInfo && <><label><span>{t("pipeline.startTime")}</span><input type="number" min={0} max={videoInfo.duration} step={0.01} value={rangeStart} onChange={(event) => setRangeStart(Math.max(0, Math.min(videoInfo.duration, Number(event.target.value) || 0)))} /></label><label><span>{t("pipeline.endTime")}</span><input type="number" min={0} max={videoInfo.duration} step={0.01} value={rangeEnd || videoInfo.duration} onChange={(event) => setRangeEnd(Math.max(0, Math.min(videoInfo.duration, Number(event.target.value) || videoInfo.duration)))} /></label></>}
                </div>
                <div className="pipeline-extract-summary">
                  <span>{t("pipeline.estimatedFrames", { n: extractTimestamps.length || frames.length })}</span>
                  {/*
                    间隔模式必须把换算过程摊开：用户填的是「每 N 帧」，但真正决定
                    结果的是原生帧率。帧率测不出来时如实标注是估计值，不能让用户
                    以为这个数字是量出来的。
                  */}
                  {extractStrategy === "interval" && videoInfo && (
                    <span className="muted">
                      {videoInfo.fps
                        ? t("pipeline.intervalDerived", {
                            source: videoInfo.fps,
                            interval: extractInterval,
                            fps: Math.round(intervalEffectiveFps(extractInterval, videoInfo.fps) * 10) / 10,
                          })
                        : t("pipeline.intervalAssumed", {
                            source: ASSUMED_SOURCE_FPS,
                            interval: extractInterval,
                            fps: Math.round(intervalEffectiveFps(extractInterval, ASSUMED_SOURCE_FPS) * 10) / 10,
                          })}
                    </span>
                  )}
                  <span className="muted">{t("pipeline.extractLimit", { n: EXTRACT_TIMESTAMPS_MAX })}</span>
                </div>
                {selectedCandidateKind === "image" ? <p className="muted">{t("pipeline.imageNoExtract")}</p> : <button type="button" className="px-btn accent" disabled={processing || (!videoFile && !selectedCandidate)} onClick={() => void runExtract}>{processing ? <Loader2 size={14} className="spin" /> : <Play size={14} />}{processing ? t("pipeline.extracting") : t("pipeline.startExtract")}</button>}
                {progress && <span className="muted">{progress}</span>}
              </div>
            )}

            {step === "process" && (
              <div className="pipeline-step-panel pipeline-process">
                <div className="pipeline-process-heading"><strong>{t("pipeline.processMethodTitle")}</strong><span>{t("pipeline.processMethodHint")}</span></div>
                <div className="pipeline-modes">
                  {(["colorkey", "matting", "skip"] as ProcessMode[]).map((item) => {
                    const disabled = item === "matting" && !caps.matting;
                    return <label key={item} className={`pipeline-mode ${mode === item ? "selected" : ""} ${disabled ? "unavailable" : ""}`}><input type="radio" name="pipeline-mode" checked={mode === item} disabled={disabled} onChange={() => setMode(item)} /><strong>{t(`pipeline.mode.${item}`)}</strong><small>{disabled ? t("pipeline.needMattingEngine") : t(`pipeline.mode.${item}Hint`)}</small></label>;
                  })}
                </div>
                {mode === "colorkey" && <div className="pipeline-colorkey"><label className="pipeline-color-field"><span>{t("pipeline.keyColor")}</span><input type="color" value={toHex(keyColor)} onChange={(event) => setKeyColor(fromHex(event.target.value))} /></label><label className="pipeline-tolerance"><span>{t("pipeline.tolerance", { n: tolerance })}</span><input type="range" min={0} max={255} value={tolerance} onChange={(event) => setTolerance(Number(event.target.value))} /></label><button type="button" className="px-btn accent" disabled={processing || !frames.length} onClick={() => void runColorKey}>{processing ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}{t("pipeline.runColorKey")}</button></div>}
                {mode === "matting" && <div className="pipeline-colorkey"><button type="button" className="px-btn" disabled={processing || !frames.length} onClick={() => void runAiMatting}>{processing ? <Loader2 size={14} className="spin" /> : <Wand2 size={14} />}{t("pipeline.runMatting")}</button><span className="muted">{progress || t("pipeline.mattingHint")}</span></div>}
                {mode === "skip" && <p className="muted">{t("pipeline.mode.skipHint")}</p>}
                {processedCount > 0 && !processing && <button type="button" className="px-btn ghost" onClick={resetProcessing}>{t("pipeline.resetProcessing")}</button>}
                <p className="muted">{t("pipeline.processedCount", { done: processedCount, total: frames.length })}</p>
              </div>
            )}

            {step === "export" && (
              <div className="pipeline-step-panel pipeline-export">
                <div className="pipeline-formats">{(["spritesheet", "sequence"] as AtlasFormat[]).map((item) => <label key={item} className={`pipeline-mode ${format === item ? "selected" : ""}`}><input type="radio" name="pipeline-format" checked={format === item} onChange={() => setFormat(item)} /><strong>{t(`pipeline.format.${item}`)}</strong><small>{t(`pipeline.format.${item}Hint`)}</small></label>)}</div>
                <div className="pipeline-export-settings">
                  <label><span>{t("pipeline.fps")}</span><input type="number" min={1} max={120} value={fps} onChange={(event) => setFps(Math.min(120, Math.max(1, Number(event.target.value) || 8)))} /></label>
                  <label><span>{t("pipeline.cellWidth")}</span><input type="number" min={0} value={cellWidth} onChange={(event) => setCellWidth(Math.max(0, Number(event.target.value) || 0))} /></label>
                  <label><span>{t("pipeline.cellHeight")}</span><input type="number" min={0} value={cellHeight} onChange={(event) => setCellHeight(Math.max(0, Number(event.target.value) || 0))} /></label>
                  {format === "spritesheet" && <><label><span>{t("pipeline.columns")}</span><input type="number" min={0} value={columns} onChange={(event) => setColumns(Math.max(0, Number(event.target.value) || 0))} /></label><label><span>{t("pipeline.rows")}</span><input type="number" min={0} value={rows} onChange={(event) => setRows(Math.max(0, Number(event.target.value) || 0))} /></label><label><span>{t("pipeline.spacing")}</span><input type="number" min={0} value={spacing} onChange={(event) => setSpacing(Math.max(0, Number(event.target.value) || 0))} /></label><label><span>{t("pipeline.maxDimension")}</span><input type="number" min={1} max={16384} value={maxDimension} onChange={(event) => setMaxDimension(Math.min(16384, Math.max(1, Number(event.target.value) || 16384)))} /></label></>}
                </div>
                <div className="pipeline-export-actions"><button type="button" className="px-btn accent" disabled={!!busy || !frames.length} onClick={() => void runExport}>{busy === "export" ? <Loader2 size={14} className="spin" /> : <Download size={14} />}{t("pipeline.export")}</button></div>
              </div>
            )}

            {frames.length > 0 && step !== "export" && (
              <section className="pipeline-frame-panel">
                <div className="pipeline-section-title"><strong>{t("pipeline.frameCount", { n: frames.length })}</strong></div>
                <ul className="pipeline-frames">
                  {frames.map((frame, index) => <li key={frame.id} className="pipeline-frame"><img src={frame.previewUrl} alt={frame.name} /><span className="pipeline-frame-index">{index + 1}</span><div className="pipeline-frame-tools"><button type="button" onClick={() => moveFrame(frame.id, -1)} disabled={index === 0} title={t("pipeline.moveUp")}><ChevronUp size={12} /></button><button type="button" onClick={() => moveFrame(frame.id, 1)} disabled={index === frames.length - 1} title={t("pipeline.moveDown")}><ChevronDown size={12} /></button><button type="button" onClick={() => removeFrame(frame.id)} title={t("pipeline.removeFrame")}><Trash2 size={12} /></button></div>{frame.processed && <span className="pipeline-frame-badge">{t("pipeline.processedBadge")}</span>}</li>)}
                </ul>
              </section>
            )}
          </motion.section>
          </AnimatePresence>

          <footer className="pipeline-foot">
            <button type="button" className="px-btn ghost" disabled={stepIndex === 0 || !!busy || processing || candidateLoading} onClick={() => goToStep(Math.max(0, stepIndex - 1))}>{t("pipeline.prev")}</button>
            {step === "process" && <button type="button" className="px-btn ghost" disabled={processing || candidateLoading} onClick={() => goToStep(Math.min(steps.length - 1, stepIndex + 1))}>{t("pipeline.skip")}</button>}
            <div className="spacer" />
            {step !== "export" && <button type="button" className="px-btn accent" disabled={!canAdvance || !!busy || processing || candidateLoading} onClick={() => goToStep(Math.min(steps.length - 1, stepIndex + 1))}>{t("pipeline.next")}</button>}
          </footer>
        </main>

        <aside className="pipeline-aside">
          <section className="pipeline-aside-panel">
            <div className="pipeline-section-title">
              <strong>{step === "export" ? t("pipeline.atlasPreview") : t(`pipeline.step.${step}`)}</strong>
              {frames.length > 0 && <span className="muted">{t("pipeline.frameCount", { n: frames.length })}</span>}
            </div>
            <div className="pipeline-preview-stage pipeline-workspace-preview">
              {step === "export" && format === "spritesheet" && previewUrl ? (
                <img src={previewUrl} alt={t("pipeline.atlasPreview")} />
              ) : activeFrame ? (
                <img src={activeFrame.previewUrl} alt={activeFrame.name} />
              ) : previewCandidate?.kind === "video" ? (
                <video src={materialFileUrl(previewCandidate.id, previewCandidate.created_at, "raw")} controls muted playsInline preload="metadata" />
              ) : previewCandidate ? (
                <img src={materialImageUrl(previewCandidate.id, previewCandidate.created_at, "raw", 512)} alt={previewCandidate.name} />
              ) : videoUrl ? (
                <video src={videoUrl} controls muted playsInline preload="metadata" />
              ) : (
                <div className="pipeline-preview-empty"><Sparkles size={28} /><strong>{t(`pipeline.step.${step}`)}</strong><span>{source ? t(`pipeline.source.${source}`) : t("pipeline.subtitle")}</span><small>{step === "process" ? t("pipeline.preview.processHint") : step === "extract" ? t("pipeline.preview.extractHint") : step === "export" ? t("pipeline.preview.exportHint") : t("pipeline.preview.sourceHint")}</small></div>
              )}
              {previewBusy && <span className="pipeline-preview-loading"><Loader2 size={16} className="spin" />{t("pipeline.previewing")}</span>}
            </div>
            <div className="pipeline-preview-meta">
              {previewMeta && <span>{previewMeta.meta.imageWidth ?? previewMeta.meta.cellWidth}×{previewMeta.meta.imageHeight ?? previewMeta.meta.cellHeight} · {t("pipeline.previewFrames", { n: previewMeta.meta.count })}</span>}
              {step === "export" && <span>{t("pipeline.previewPlaying", { fps })}</span>}
              {progress && <span>{progress}</span>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
