import { useEffect, useRef, useState } from "react";
import { ImagePlus, Loader2, Pencil, Upload, X } from "lucide-react";
import { api, materialImageUrl, type Material } from "../api";
import { ensureEphemeralFolder, purgeStaleEphemeral } from "../ephemeralReferences";
import { useT } from "../i18n";
import { notify } from "../notice";
import IconBtn from "./IconBtn";
import { useMaterialEditor } from "./MaterialEditor";

export interface ReferenceSelection {
  /** 服务端按 {kind,id} 解析引用素材。 */
  kind: "material";
  id: string;
}

interface Props<T extends ReferenceSelection[] | ReferenceSelection | null> {
  value: T;
  onChange: (v: T) => void;
  /** 自定义标题与说明；缺省保持通用引用图文案 */
  label?: string;
  description?: string;
  /**
   * 多选模式下的张数上限；缺省 10。
   * 必须可配：上限由所选模型的输入形态决定，写死 10 会出现「形态上限 1 张、
   * 选择器却写着最多 10 张」这种自相矛盾的界面。
   */
  max?: number;
  /**
   * 本地上传产生的临时素材 id。调用方需在生成任务结束后回收它们
   * （见 ephemeralReferences.cleanupEphemeralAfterJob）。
   * 不传则不提供本地上传入口。
   */
  onEphemeralUpload?: (materialIds: string[]) => void;
}

/** 只接受能同步拿到 materialId 的静态图；视频走 /materials/upload 会变成异步抽帧任务 */
const UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp";

/** 生成引用图选择器；多选上限由 max 决定，传入单值/null 时为单选模式。 */
export default function ReferencePicker<T extends ReferenceSelection[] | ReferenceSelection | null>({ value, onChange, label, description, max = 10, onEphemeralUpload }: Props<T>) {
  const t = useT();
  const openMaterialEditor = useMaterialEditor();
  const [open, setOpen] = useState(false);
  const [mats, setMats] = useState<Material[] | null>(null);
  const [v, setV] = useState(() => Date.now());
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const multiple = Array.isArray(value);
  const selectedValues: ReferenceSelection[] = multiple ? value : value ? [value] : [];
  const emit = (items: ReferenceSelection[]) => onChange((multiple ? items : items[0] ?? null) as T);
  const canUpload = !!onEphemeralUpload;

  /**
   * 本地图片 → 临时素材 → 立刻当引用图用。
   *
   * 走的是 PipelinePage.uploadFrames 同一个调用（`/materials/upload` 对单图同步返回
   * materialId），所以这条路已经被验证过。落进隔离的「临时引用」文件夹，由调用方
   * 在生成任务结束后回收。
   */
  const uploadLocal = async (files: FileList) => {
    if (!onEphemeralUpload || uploading) return;
    const room = multiple ? max - selectedValues.length : 1;
    if (room <= 0) {
      notify(t("msg.reference_images_limit_max", { max }));
      return;
    }
    const picked = Array.from(files).slice(0, room);
    setUploading(true);
    const uploadedIds: string[] = [];
    try {
      const folderId = await ensureEphemeralFolder();
      for (const file of picked) {
        const form = new FormData();
        form.append("file", file, file.name || "reference.png");
        form.append("folderId", folderId);
        const result = await api.uploadMaterial(form);
        // 视频会返回 jobId（异步抽帧），拿不到可立刻引用的 id
        if (!("materialId" in result)) throw new Error(t("msg.reference_upload_image_only"));
        uploadedIds.push(result.materialId);
      }
      onEphemeralUpload(uploadedIds);
      const additions: ReferenceSelection[] = uploadedIds.map((id) => ({ kind: "material", id }));
      emit(multiple ? [...selectedValues, ...additions] : additions.slice(0, 1));
      setMats(null); // 让素材 Tab 下次展开时重新拉取，新上传的图能出现在网格里
      setV(Date.now());
    } catch (error) {
      // 已上传成功的部分要收掉，避免半途失败在库里留下孤儿
      if (uploadedIds.length) void api.batchDeleteMaterials(uploadedIds).catch(() => {});
      notify(t("msg.reference_upload_failed_msg", { msg: (error as Error).message }));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // 展开时按 Tab 懒加载
  useEffect(() => {
    if (!open) return;
    if (mats === null) {
      api.listMaterials().then(setMats).catch((e) => notify(t("msg.load_materials_failed_msg", { msg: (e as Error).message })));
    }
  }, [open, mats]);

  // 展开时顺手收走遗留的临时引用（浏览器在上次任务跑完前被关掉的情况）
  useEffect(() => {
    if (open && canUpload) void purgeStaleEphemeral();
  }, [open, canUpload]);

  const pick = (sel: ReferenceSelection) => {
    const selected = selectedValues.some((item) => item.kind === sel.kind && item.id === sel.id);
    if (selected) {
      emit(selectedValues.filter((item) => item.kind !== sel.kind || item.id !== sel.id));
      return;
    }
    if (multiple && selectedValues.length >= max) {
      notify(t("msg.reference_images_limit_max", { max }));
      return;
    }
    emit(multiple ? [...selectedValues, sel] : [sel]);
  };

  const thumb = (item: ReferenceSelection) => materialImageUrl(item.id, v, "processed", 256);

  return (
    <div className="form-row">

      <label>{label ?? t("msg.reference_image_optional_max", { max })}</label>
      {description && <div className="hint">{description}</div>}
      {selectedValues.length > 0 && (
        <div className="ref-selected-list">
          {selectedValues.map((item) => (
            <div className="ref-selected" key={`${item.kind}:${item.id}`}>
              <img src={thumb(item)} alt={t("msg.reference_image")} draggable={false} loading="lazy" decoding="async" />
              <span className="ref-kind">{t("common.material")}</span>
              {(
                <IconBtn
                  title={t("materialEdit.action")}
                  onClick={() => openMaterialEditor({ id: item.id, name: mats?.find((m) => m.id === item.id)?.name, v, onSaved: () => setV(Date.now()) })}
                >
                  <Pencil size={14} />
                </IconBtn>
              )}
              <IconBtn title={t("msg.clear_reference")} onClick={() => pick(item)}>
                <X size={14} />
              </IconBtn>
            </div>
          ))}

        </div>
      )}
      <div className="file-drop" onClick={() => setOpen((o) => !o)}>
        <span className="ref-empty">
          <ImagePlus size={16} /> {t("msg.choose_reference")}{multiple ? ` (${selectedValues.length}/${max})` : ""}
        </span>
      </div>
      {selectedValues.length > 1 && (
        <div className="hint">{t("msg.multiple_references_model_support_tip", { count: selectedValues.length })}</div>
      )}

      {open && (
        <div className="ref-panel">
          <div className="import-tabs ref-tabs">
            {/* 本地上传做成常驻按钮而不是第三个 Tab：它是一次性动作，不是一个可浏览的来源，
                做成 Tab 反而多一次导航才能点到 */}
            {canUpload && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept={UPLOAD_ACCEPT}
                  multiple={multiple}
                  hidden
                  onChange={(event) => {
                    if (event.target.files?.length) void uploadLocal(event.target.files);
                  }}
                />
                <button
                  type="button"
                  className="tab ref-upload-tab"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                >
                  {uploading ? <Loader2 size={13} className="spin" /> : <Upload size={13} />}
                  {uploading ? t("msg.reference_uploading") : t("msg.reference_upload_local")}
                </button>
              </>
            )}
          </div>
          <div className="mat-pick-grid ref-grid">
            {              mats === null ? (
                <div className="empty">{t("msg.loading")}</div>
              ) : mats.length === 0 ? (
                /*
                  空库不能只说「素材库为空」就把人堵死。这里做成横跨整行的大号拖放区，
                  而不是塞一个按钮——父级 .mat-pick-grid 是 repeat(auto-fill, minmax(76px,1fr))，
                  不跨列的话空状态会被压进一个 76px 的格子里，按钮文字都会折行。
                */
                canUpload ? (
                  <div
                    className={`ref-upload-zone ${dragging ? "dragging" : ""}`.trim()}
                    role="button"
                    tabIndex={uploading ? -1 : 0}
                    aria-busy={uploading}
                    aria-label={t("msg.reference_upload_local")}
                    onClick={() => !uploading && fileRef.current?.click()}
                    onKeyDown={(event) => {
                      if (uploading) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        fileRef.current?.click();
                      }
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      if (!uploading) setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(event) => {
                      event.preventDefault();
                      setDragging(false);
                      if (!uploading && event.dataTransfer.files?.length) void uploadLocal(event.dataTransfer.files);
                    }}
                  >
                    {uploading ? <Loader2 size={30} className="spin" /> : <Upload size={30} />}
                    <strong>{uploading ? t("msg.reference_uploading") : t("msg.reference_upload_local")}</strong>
                    <span>{t("msg.reference_upload_drop_hint")}</span>
                    <small>{t("msg.reference_upload_formats")}</small>
                  </div>
                ) : (
                  <div className="empty ref-empty-state">{t("msg.materials_empty")}</div>
                )
              ) : (
                mats.map((m) => (
                  <div key={m.id} className={`mat-pick ${selectedValues.some((item) => item.kind === "material" && item.id === m.id) ? "on" : ""}`} title={m.name} onClick={() => pick({ kind: "material", id: m.id })}>
                    <img src={materialImageUrl(m.id, v, "processed", 256)} alt="" draggable={false} loading="lazy" decoding="async" />
                    <span className={`mat-dot ${m.status}`} />
                    {m.kind !== "video" && (
                      <IconBtn
                        className="mat-pick-edit"
                        title={t("materialEdit.action")}
                        onClick={(event) => {
                          event.stopPropagation();
                          openMaterialEditor({ id: m.id, name: m.name, v, onSaved: () => setV(Date.now()) });
                        }}
                      >
                        <Pencil size={12} />
                      </IconBtn>
                    )}
                  </div>
                ))
              )
            }
          </div>
        </div>
      )}
    </div>
  );
}
