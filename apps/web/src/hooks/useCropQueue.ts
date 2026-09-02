import { useRef, useState } from "react";
import { t } from "../i18n";
import { cropImage, findOpaqueBounds } from "../imageops/client";
import type { CropRect } from "../imageops/ops";
import { notify } from "../notice";

export interface CroppableItem {
  file: File;
  cropped?: boolean;
}

/** 剪裁产物统一改名「原名.png」（与 confirm 一致） */
const pngNameOf = (name: string) => name.replace(/\.\w+$/, "") + ".png";

/** 视频/动图不参与剪裁（仅静态图） */
export function isVideoFile(f: File): boolean {
  const ext = f.name.split(".").pop()?.toLowerCase();
  return ext === "gif" || ext === "mp4" || ext === "mov" || ext === "webm";
}

/**
 * 导入弹窗共用的「逐张剪裁」队列：
 * startAll 把所有静态图排入队列依次弹 CropModal；startOne 单张重裁；
 * confirm 用剪裁产物（PNG blob）替换原文件并标记 cropped；
 * applyRectToAll / trimAll 为批量能力（处理后整个队列结束，汇总 notify）
 */
export function useCropQueue<T extends CroppableItem>(
  items: T[],
  replaceItem: (index: number, file: File) => void
) {
  const [queue, setQueue] = useState<number[]>([]);
  /** 批量操作防重入（进行中再次点击直接忽略） */
  const busyRef = useRef(false);

  const cropIndex = queue.length > 0 ? queue[0] : null;
  /** 队列进度（逐张模式提示用）：total=0 表示单张重裁 */
  const total = queue.length;

  const imageIndices = () => items.map((it, i) => (isVideoFile(it.file) ? -1 : i)).filter((i) => i >= 0);

  const startAll = () => setQueue(imageIndices());
  const startOne = (i: number) => setQueue([i]);
  const cancel = () => setQueue([]);
  /** 跳过当前张，继续下一张 */
  const skip = () => setQueue((q) => q.slice(1));

  /** 用剪裁产物（PNG blob）替换原文件并标记 cropped */
  const applyBlob = (index: number, blob: Blob) => {
    const orig = items[index].file;
    replaceItem(index, new File([blob], pngNameOf(orig.name), { type: "image/png" }));
  };

  /** 剪裁确认：替换文件 → 下一张 */
  const confirm = (blob: Blob) => {
    if (cropIndex == null) return;
    applyBlob(cropIndex, blob);
    setQueue((q) => q.slice(1));
  };

  /** 解码拿图片尺寸（只为求交集，不碰 canvas） */
  const decodeSize = async (file: File): Promise<{ w: number; h: number }> => {
    const bmp = await createImageBitmap(file);
    try {
      return { w: bmp.width, h: bmp.height };
    } finally {
      bmp.close();
    }
  };

  /** 批量执行：逐张 process（返回 false 表示跳过），结束后清空队列并汇总提示 */
  const runBatch = async (process: (index: number, file: File) => Promise<boolean>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const indices = [...queue]; // 快照：处理过程中 queue 不再逐张推进
    let done = 0;
    let skipped = 0;
    try {
      for (const i of indices) {
        try {
          if (await process(i, items[i].file)) done++;
          else skipped++;
        } catch {
          skipped++; // 单张失败保持原文件，不阻塞其余
        }
      }
    } finally {
      busyRef.current = false;
      setQueue([]);
    }
    notify(t("msg.cropped_done_skipped_skipped", { done, skipped }));
  };

  /** 「应用到剩余」：同一剪裁框应用到队列全部未处理图片（含当前张），与各图实际边界求交集；交集为空或等于整图则跳过 */
  const applyRectToAll = (rect: CropRect) =>
    runBatch(async (i, file) => {
      const { w, h } = await decodeSize(file);
      const x = Math.max(0, Math.round(rect.x));
      const y = Math.max(0, Math.round(rect.y));
      const x2 = Math.min(w, Math.round(rect.x + rect.w));
      const y2 = Math.min(h, Math.round(rect.y + rect.h));
      if (x2 <= x || y2 <= y) return false; // 交集为空
      if (x === 0 && y === 0 && x2 === w && y2 === h) return false; // 等于整图
      applyBlob(i, await cropImage(file, { x, y, w: x2 - x, h: y2 - y }));
      return true;
    });

  /** 「剩余全部 trim 透明边」：自动透明边剪裁（全透明或已是整图则跳过） */
  const trimAll = () =>
    runBatch(async (i, file) => {
      const bounds = await findOpaqueBounds(file);
      if (!bounds) return false; // 全透明
      const { w, h } = await decodeSize(file);
      if (bounds.x === 0 && bounds.y === 0 && bounds.w === w && bounds.h === h) return false; // 已是整图
      applyBlob(i, await cropImage(file, bounds));
      return true;
    });

  return { cropIndex, total, startAll, startOne, confirm, skip, cancel, applyRectToAll, trimAll };
}
