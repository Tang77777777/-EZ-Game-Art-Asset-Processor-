import { GEN_SIZE_PRESETS, GEN_VIDEO_SIZE_PRESETS, parseSizePreview } from "@ezgameart/shared";
import { useServerConfig } from "../config";
import { useT } from "../i18n";
import { resolveProviderSelection } from "../providerSelection";
import PxSelect from "./PxSelect";

interface Props {
  providerId: string;
  value: string;
  onChange: (v: string) => void;
  /** 视频生成用视频档位预设；默认图片档位 */
  forVideo?: boolean;
}

const PREVIEW_BOX = 120;

/**
 * 生成弹窗共用：尺寸/比例选择 + 比例预览框。
 * 空值 = 用 provider 在设置页配的 apiSize；CLI 无尺寸概念，不渲染。
 */
export default function SizePicker({ providerId, value, onChange, forVideo }: Props) {
  const t = useT();
  const cfg = useServerConfig();
  const providers = cfg?.gen.providers ?? [];
  const selected = resolveProviderSelection(providers, providerId, "", { videoOnly: forVideo });
  const provider = providers.find((p) => p.id === selected.providerId);
  if (!provider || provider.type === "cli") return null;

  const presets = forVideo ? GEN_VIDEO_SIZE_PRESETS[provider.type] : GEN_SIZE_PRESETS[provider.type];
  const current = presets.some((o) => o.value === value) ? value : "";

  /**
   * provider 在设置页配的尺寸。留「默认」时用的就是这个值，所以要把它显示出来——
   * 只写「默认」等于让用户去猜到底出多大的图。
   *
   * 这里刻意**不再编造兜底值**。原实现在 provider 没配尺寸时回落到 "1:1" / "16:9"，
   * 但服务端在 apiSize 为空时走的是另一套（wan 系视频是 resolution=720P + ratio=adaptive），
   * 两边不一致。显示一个和实际请求不符的具体数字，比诚实地说「未配置」更糟。
   */
  const configured = ((forVideo ? provider.videoSize : provider.imageSize) ?? "").trim();
  const effective = current || configured;
  const unset = !effective;
  // 未配置时预览框没有可依据的比例，用方形占位，由文案说明真实情况
  const preview = parseSizePreview(effective || "1:1");
  const scale = Math.min(PREVIEW_BOX / preview.w, PREVIEW_BOX / preview.h, 1);
  const pw = Math.max(8, Math.round(preview.w * scale));
  const ph = Math.max(8, Math.round(preview.h * scale));

  /** 下拉里的「默认」项直接带上真实值，避免出现「默认（pr…」这种既截断又没信息的选项 */
  const options = presets.map((o) => ({
    ...o,
    label:
      o.value === ""
        ? unset
          ? t("size.defaultUnset")
          : t("size.defaultResolved", { label: parseSizePreview(configured).label })
        : t(o.label),
  }));

  const previewText = current
    ? preview.label
    : unset
      ? t("size.unsetPreview")
      : t("size.defaultResolved", { label: preview.label });

  return (
    <div className="form-row size-picker">
      <label>{forVideo ? t("size.videoLabel") : t("msg.size_blank_provider_size_from_settings")}</label>
      <div className="size-picker-row">
        <PxSelect value={current} options={options} onChange={onChange} />
        <div className="size-preview" title={previewText}>
          <div className="size-preview-frame" style={{ width: pw, height: ph }} />
          <span className="size-preview-label">{previewText}</span>
        </div>
      </div>
    </div>
  );
}
