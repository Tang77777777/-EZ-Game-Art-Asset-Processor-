import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Scissors, Sparkles, Upload, X } from "lucide-react";
import { api } from "../api";
import { useT } from "../i18n";
import { useModalEscClose } from "../hooks/useModalEscClose";
import { isVideoFile, useCropQueue } from "../hooks/useCropQueue";
import { type FileState, useImportWorkflow } from "../hooks/useImportWorkflow";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import MattingOption from "./MattingOption";
import CropModal from "./CropModal";
import GenerateMaterialPanel from "./GenerateMaterialPanel";

interface Props {
  initialTab: "upload" | "cli";
  /** 当前选中的素材文件夹（null = 未分组 / 全部） */
  folderId?: string | null;
  onClose: () => void;
  onDone: () => void;
}

function stateIcon(s: FileState): string {
  switch (s) {
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "uploading":
      return "↑";
    case "queued":
      return "…";
    default:
      return "·";
  }
}

/** 素材导入弹窗：上传（可多选，单图/GIF/MP4 混合）或 AI 生成，目标为 /api/materials/* */
export default function MaterialImportModal({ initialTab, folderId = null, onClose, onDone }: Props) {
  const t = useT();
  useModalEscClose(onClose);
  const [tab, setTab] = useState<"upload" | "cli">(initialTab);
  const [fps, setFps] = useState(8);
  const [autoMatting, setAutoMatting] = useState(true); // 默认勾选抠图去背
  const [cropDismissed, setCropDismissed] = useState(false); // 「是否需要剪裁」确认行已回答
  const fileRef = useRef<HTMLInputElement>(null);
  const workflow = useImportWorkflow(onDone);
  const { items, finished, submitting, updateItem, okCount, errCount } = workflow;

  // 剪裁队列：逐张剪裁 / 单张重裁（确认后 PNG 替换原文件并标 cropped）
  const crop = useCropQueue(items, (i, file) => updateItem(i, { file, cropped: true }));
  const imageCount = items.filter((it) => !isVideoFile(it.file)).length;
  const resetAll = workflow.reset;
  const hasVideo = items.some((it) => isVideoFile(it.file));

  // 上传 Tab：多选逐个分发——图片直接成素材（立即完成），GIF/MP4 走 job 队列
  const submitUpload = async () => {
    await workflow.submit(async (file) => {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("fps", String(fps));
      fd.append("autoMatting", String(autoMatting));
      if (folderId) fd.append("folderId", folderId);
      const r = await api.uploadMaterial(fd);
      if ("jobId" in r) return { kind: "queued", jobId: r.jobId };
      return { kind: "done" }; // 单图 → 直接生成 1 个素材
    });
  };

  return (
    <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <motion.div
        className="modal pixel-panel import-modal"
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.92, y: 24 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="form-inline">
          <h2 style={{ flex: 1 }}>{t("msg.add_materials")}</h2>
          <IconBtn onClick={onClose} title={t("common.close")}>
            <X size={16} />
          </IconBtn>
        </div>

        <div className="import-tabs">
          <button type="button" className={`tab ${tab === "upload" ? "active" : ""}`} onClick={() => { setTab("upload"); resetAll(); }}>
            <Upload size={14} /> {t("msg.upload_files")}
          </button>
          <button type="button" className={`tab ${tab === "cli" ? "active" : ""}`} onClick={() => { setTab("cli"); resetAll(); }}>
            <Sparkles size={14} /> {t("msg.generate")}
          </button>
        </div>

        {tab === "upload" ? (
          <>
            <div className="form-row">
              <label>{t("msg.multi_select_png_jpg_1_material_each_gif_mp4_split_into")}</label>
              <div className="file-drop" onClick={() => !submitting && fileRef.current?.click()}>
                {items.length ? t("msg.n_files_selected_click_to_reselect", { n: items.length }) : t("msg.click_to_choose_files_multi_select")}
              </div>
              <input
                ref={fileRef}
                type="file"
                hidden
                multiple
                accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.mov,.webm,image/*,video/mp4,image/gif"
                onChange={(e) => {
                  workflow.selectFiles(Array.from(e.target.files ?? []));
                  setCropDismissed(false);
                  e.target.value = "";
                }}
              />
            </div>

            {items.length > 0 && (
              <ul className="up-list">
                {items.map((it, i) => (
                  <li key={`${it.file.name}-${i}`} className="up-item">
                    <span className={`up-state ${it.state}`}>{stateIcon(it.state)}</span>
                    <span className="up-name" title={it.error ?? it.file.name}>{it.file.name}</span>
                    {it.cropped && <span className="up-cropped">{t("msg.cropped")}</span>}
                    <span className="up-size">{(it.file.size / 1024).toFixed(1)} KB</span>
                    {!isVideoFile(it.file) && !submitting && (
                      <IconBtn className="up-crop" title={t("msg.crop_this_image")} onClick={() => crop.startOne(i)}>
                        <Scissors size={12} />
                      </IconBtn>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {imageCount > 0 && !cropDismissed && !submitting && !finished && (
              <div className="crop-ask">
                <span>{t("msg.n_images_crop_before_import_gif_mp4_skipped", { n: imageCount })}</span>
                <button type="button" className="px-btn mini" onClick={() => { setCropDismissed(true); crop.startAll(); }}>
                  <Scissors size={12} /> {t("msg.crop_one_by_one")}
                </button>
                <button type="button" className="px-btn mini" onClick={() => setCropDismissed(true)}>{t("msg.no_import_as_is")}</button>
              </div>
            )}

            {hasVideo && (
              <div className="form-row">
                <label>{t("msg.video_extract_fps_fps_applies_to_all_videos", { fps })}</label>
                <input type="range" min={1} max={24} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
              </div>
            )}

            <MattingOption checked={autoMatting} onChange={setAutoMatting} />

            {finished && (
              <div className="up-summary">
                {t("msg.ok")} <span className="ok">{okCount}</span> / {t("msg.failed")} <span className={errCount ? "err" : ""}>{errCount}</span>
              </div>
            )}

            <div className="modal-actions">
              {finished ? (
                <button type="button" className="px-btn" onClick={onClose}>{t("msg.done_close")}</button>
              ) : (
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  className="px-btn accent"
                  disabled={items.length === 0 || submitting}
                  onClick={submitUpload}
                >
                  <Upload size={14} /> {submitting ? t("msg.uploading") : t("msg.upload_n_files", { n: items.length || "" })}
                </motion.button>
              )}
            </div>
          </>
        ) : (
          <GenerateMaterialPanel
            folderId={folderId}
            onQueued={({ mediaKind }) => {
              notify(
                mediaKind === "video"
                  ? t("msg.queued_when_ready_open_in_materials_and_extract_frames")
                  : t("msg.queued_track_progress_in_the_right_job_panel"),
                "info"
              );
              onDone();
              onClose();
            }}
          />
        )}

        {/* 剪裁工具：逐张队列或单张重裁 */}
        <AnimatePresence>
          {crop.cropIndex != null && items[crop.cropIndex] && (
            <CropModal
              image={items[crop.cropIndex].file}
              title={items[crop.cropIndex].file.name}
              onConfirm={crop.confirm}
              onSkip={crop.skip}
              onConfirmAll={crop.applyRectToAll}
              onTrimAll={crop.trimAll}
              remaining={crop.total - 1}
              onClose={crop.cancel}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
