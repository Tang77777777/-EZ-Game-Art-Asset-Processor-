import { materialImageUrl } from "./api";
import { createZip } from "./zip";

/**
 * 素材导出：单张直接下载，多张打包 ZIP。
 */

function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/** 文件名安全化：去掉路径非法字符 */
function safeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "material";
}

/** 导出单个素材图片：raw=原图，processed=抠图后（单张直接下载） */
export async function downloadMaterialImage(
  id: string,
  name: string,
  slot: "raw" | "processed",
  v?: number
): Promise<void> {
  const res = await fetch(materialImageUrl(id, v, slot));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const suffix = slot === "processed" ? "_matted" : "_raw";
  download(blob, `${safeFilename(name)}_${id.slice(0, 6)}${suffix}.png`);
}

/** 批量导出：打包成 ZIP 下载；返回成功/跳过/失败计数 */
export async function downloadMaterialImages(
  items: Array<{ id: string; name: string; processed?: boolean }>,
  slot: "raw" | "processed",
  v?: number
): Promise<{ ok: number; skipped: number; failed: number }> {
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  const entries: { name: string; data: Uint8Array }[] = [];
  const usedNames = new Set<string>();

  for (const it of items) {
    if (slot === "processed" && !it.processed) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(materialImageUrl(it.id, v, slot));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const suffix = slot === "processed" ? "_matted" : "_raw";
      let filename = `${safeFilename(it.name)}_${it.id.slice(0, 6)}${suffix}.png`;
      // 防止 ZIP 内重名
      if (usedNames.has(filename)) {
        const dot = filename.lastIndexOf(".");
        filename = `${filename.slice(0, dot)}_${it.id.slice(0, 4)}${filename.slice(dot)}`;
      }
      usedNames.add(filename);
      entries.push({ name: filename, data: buf });
      ok++;
    } catch {
      failed++;
    }
  }

  if (entries.length > 0) {
    const zip = await createZip(entries);
    const label = slot === "processed" ? "matted" : "raw";
    download(zip, `materials_${label}.zip`);
  }

  return { ok, skipped, failed };
}
