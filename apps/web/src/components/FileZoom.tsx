import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { FILE_ZOOM_KEY, readLocalPref } from "../localPrefs";

const ZOOM_KEY = FILE_ZOOM_KEY;
/** 文件管理器图标边长（px）：最小 / 默认 / 最大 */
export const FILE_ZOOM_MIN = 96;
export const FILE_ZOOM_MAX = 280;
export const FILE_ZOOM_DEFAULT = 160;

export function getFileZoom(): number {
  try {
    const n = Number(readLocalPref(ZOOM_KEY));
    if (Number.isFinite(n) && n >= FILE_ZOOM_MIN && n <= FILE_ZOOM_MAX) return Math.round(n);
  } catch {
    /* ignore */
  }
  return FILE_ZOOM_DEFAULT;
}

function persist(n: number) {
  try {
    localStorage.setItem(ZOOM_KEY, String(n));
  } catch {
    /* ignore */
  }
}

/** 文件网格缩放滑杆（像资源管理器图标大小），写入 CSS 变量 --tile-min */
export default function FileZoom({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const t = useT();
  return (
    <div className="file-zoom">
      <label htmlFor="file-zoom">{t("msg.icon_size")}</label>
      <input
        id="file-zoom"
        type="range"
        min={FILE_ZOOM_MIN}
        max={FILE_ZOOM_MAX}
        step={8}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          persist(n);
          onChange(n);
        }}
        title={t("msg.icon_size")}
      />
    </div>
  );
}

/** 读初始缩放并在挂载时同步（供页面用） */
export function useFileZoom() {
  const [zoom, setZoom] = useState(FILE_ZOOM_DEFAULT);
  useEffect(() => {
    setZoom(getFileZoom());
  }, []);
  return [zoom, setZoom] as const;
}
