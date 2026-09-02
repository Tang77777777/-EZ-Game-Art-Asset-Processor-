import {
  ASSUMED_SOURCE_FPS,
  EXTRACT_INTERVAL_MAX,
  EXTRACT_TIMESTAMPS_MAX,
  type ExtractSampling,
} from "@ezgameart/shared";

export interface FrameTimestampOptions {
  start: number;
  end: number;
  /** 采样规则；缺省 "fps"，保持旧调用方行为不变 */
  mode?: ExtractSampling;
  /** mode="fps" 时的抽帧帧率 */
  fps: number;
  /** mode="interval" 时每 N 个原生帧取 1 个 */
  interval?: number;
  /** mode="interval" 时视频的原生帧率；缺省用 ASSUMED_SOURCE_FPS */
  sourceFps?: number;
  /** 最终帧数上限；两种模式都生效 */
  maxFrames?: number;
}

/**
 * 求两种模式下的采样步长（秒）。
 *
 * interval 模式的步长是 N / 原生帧率——比如 24fps 的视频每 4 帧取 1，
 * 步长就是 4/24 ≈ 0.167s，等效 6fps。这跟直接填 6fps 的结果一致，
 * 但用户不需要自己做这道除法，而且视频换成 30fps 时「每 4 帧」会自动
 * 跟着变成 7.5fps，抽稀比例保持不变。
 */
function resolveStep(options: FrameTimestampOptions): number {
  if (options.mode === "interval") {
    const source = Number.isFinite(options.sourceFps) && options.sourceFps! > 0 ? options.sourceFps! : ASSUMED_SOURCE_FPS;
    const every = Math.min(EXTRACT_INTERVAL_MAX, Math.max(1, Math.floor(options.interval ?? 1)));
    return every / source;
  }
  const rate = Math.min(60, Math.max(1, Number.isFinite(options.fps) ? options.fps : 8));
  return 1 / rate;
}

/** 按播放区间生成稳定的毫秒级抽帧时间点，并均匀限制最终帧数。 */
export function buildFrameTimestamps(options: FrameTimestampOptions): number[] {
  const { start, end, maxFrames } = options;
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(from, Math.max(start, end));
  const requestedMax = Number.isFinite(maxFrames) ? Math.floor(maxFrames!) : EXTRACT_TIMESTAMPS_MAX;
  const limit = Math.min(EXTRACT_TIMESTAMPS_MAX, Math.max(1, requestedMax));
  const step = resolveStep(options);
  const all: number[] = [];
  const seen = new Set<number>();

  for (let value = from; value <= to + 1e-9; value += step) {
    const milliseconds = Math.round(value * 1000);
    if (seen.has(milliseconds)) continue;
    seen.add(milliseconds);
    all.push(milliseconds / 1000);
    if (all.length >= EXTRACT_TIMESTAMPS_MAX * 60) break;
  }

  const endMilliseconds = Math.round(to * 1000);
  if (!seen.has(endMilliseconds)) all.push(endMilliseconds / 1000);
  if (all.length <= limit) return all;
  if (limit === 1) return [all[0]!];

  const sampled: number[] = [];
  for (let index = 0; index < limit; index++) {
    const sourceIndex = Math.round((index * (all.length - 1)) / (limit - 1));
    sampled.push(all[sourceIndex]!);
  }
  return [...new Set(sampled)];
}

/**
 * interval 模式下的等效帧率，用于界面把「每 N 帧取 1」翻译成用户能对照的帧率。
 * 单独导出而不是塞进 buildFrameTimestamps 的返回值，是为了让后者保持
 * 「进区间、出时间点」的纯粹签名，测试也更好写。
 */
export function intervalEffectiveFps(interval: number, sourceFps: number): number {
  const source = Number.isFinite(sourceFps) && sourceFps > 0 ? sourceFps : ASSUMED_SOURCE_FPS;
  const every = Math.min(EXTRACT_INTERVAL_MAX, Math.max(1, Math.floor(interval)));
  return source / every;
}
