import { useRef, useState } from "react";
import { motion } from "motion/react";
import { Images, Repeat, SlidersHorizontal, Sparkles, Type } from "lucide-react";
import {
  deriveVideoInputMode,
  resolveVideoInputMode,
  videoInputModeMaxReferences,
  videoModeOffersKeyframes,
  type VideoInputMode,
} from "@ezgameart/shared";
import { api, materialImageUrl } from "../api";
import { useServerConfig } from "../config";
import { cleanupEphemeralAfterJob } from "../ephemeralReferences";
import { useT } from "../i18n";
import { notify } from "../notice";
import MattingOption from "./MattingOption";
import PromptEnhancer from "./PromptEnhancer";
import ProviderModelPicker, { resolveProviderSelection } from "./ProviderModelPicker";
import PxSelect from "./PxSelect";
import ReferencePicker, { type ReferenceSelection } from "./ReferencePicker";
import SizePicker from "./SizePicker";

export interface GeneratedMaterialRequest {
  jobId: string;
  name: string;
  mediaKind: "image" | "video";
}

interface Props {
  /** 生成结果落入的素材文件夹；null 表示未分组。 */
  folderId?: string | null;
  /** 任务创建成功后的回调。调用方决定留在当前页面还是关闭弹窗。 */
  onQueued: (request: GeneratedMaterialRequest) => void | Promise<void>;
  /** 覆盖提交按钮文案，缺省使用通用「开始生成」。 */
  submitLabel?: string;
  /** 可选的结果命名前缀；Pipeline 用它关联当前会话，素材库入口保持服务端默认命名。 */
  namePrefix?: string;
  className?: string;
}

/**
 * 生成素材的单一表单实现。
 *
 * 素材库导入弹窗与 Pipeline 都复用这里的 provider、模型、尺寸、引用图和提示词增强逻辑，
 * 避免两个入口的请求参数和可用能力逐渐漂移。
 */
export default function GenerateMaterialPanel({ folderId = null, onQueued, submitLabel, namePrefix, className = "" }: Props) {
  const t = useT();
  const cfg = useServerConfig();
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [model, setModel] = useState("");
  const [size, setSize] = useState("");
  const [references, setReferences] = useState<ReferenceSelection[]>([]);
  const [count, setCount] = useState(4);
  const [mediaKind, setMediaKind] = useState<"image" | "video">("image");
  const [autoMatting, setAutoMatting] = useState(true);
  /** 首尾帧形态下：只给一张图，首尾同帧 → 产出可无缝循环的动画 */
  const [loopFromFirstFrame, setLoopFromFirstFrame] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  /**
   * 本次通过「上传本地图片」产生的临时素材 id。提交成功后登记给
   * cleanupEphemeralAfterJob，等生成任务到达终态再删——不能提前删，任务真正跑起来
   * 时还要读这些文件。
   */
  const ephemeralIdsRef = useRef<string[]>([]);

  const providers = (cfg?.gen.providers ?? []).filter((p) => (mediaKind === "video" ? p.video : true));
  const selection = resolveProviderSelection(providers, providerId, model, {
    videoOnly: mediaKind === "video",
    preferI2v: mediaKind === "video" && references.length > 0,
  });
  const hasProvider = !!selection.providerId;

  /**
   * 当前所选视频模型的输入形态。与服务端共用 resolveVideoInputMode，
   * 因此前端提示与后端实际发出的 media 类型永远一致。
   */
  const selectedProvider = providers.find((provider) => provider.id === selection.providerId);
  const videoInputMode: VideoInputMode | null =
    mediaKind === "video" && selection.model
      ? resolveVideoInputMode(selection.model, selectedProvider?.videoModelModes)
      : null;
  /**
   * 视频模式默认就给「起始帧 / 结束帧」两个具名槽位，不再要求先去设置页声明形态。
   *
   * 只有显式声明为纯文生或参考图的模型才退回通用多选选择器。理由见 shared 的
   * videoModeOffersKeyframes：槽位留空即等于纯文生，多给一个可选入口没有代价；
   * 反过来默认不给，用户就得先跑一趟设置页才能用首帧驱动——而模型名又推断不出
   * 能力（wan3.0-video 就是典型），等于把能力藏起来。
   */
  const declaredVideoMode =
    mediaKind === "video" && selection.model ? selectedProvider?.videoModelModes?.[selection.model] : undefined;
  const usesKeyframeSlots = mediaKind === "video" && videoModeOffersKeyframes(declaredVideoMode);

  /**
   * 本次请求的输入形态由「填了什么」派生，而不是读配置。
   * loop 必须单独传给服务端：只看引用图张数分不清「要循环」和「只想首帧驱动」。
   */
  const derivedVideoMode = usesKeyframeSlots
    ? deriveVideoInputMode({
        hasFirst: !!references[0],
        hasLast: !!references[1],
        loop: loopFromFirstFrame,
      })
    : videoInputMode;
  const maxReferences = derivedVideoMode ? videoInputModeMaxReferences(derivedVideoMode) : 10;
  const wantsLoop = derivedVideoMode === "firstLastFrame" && loopFromFirstFrame && !references[1];
  /** 勾了「将起始帧复制为结束帧」且没单独选结束帧时只送第一张，服务端复制成尾帧 */
  const effectiveReferences = wantsLoop ? references.slice(0, 1) : references;

  /**
   * 首尾帧形态把 references 当成固定两格用：[0] 起始帧、[1] 结束帧，
   * 与服务端 referencePaths[0]/[1] 的取用顺序一一对应，所以这里不需要额外请求字段。
   */
  const firstFrameRef = references[0] ?? null;
  const lastFrameRef = references[1] ?? null;
  const setKeyframeSlot = (slot: 0 | 1, sel: ReferenceSelection | null) => {
    setReferences((prev) => {
      const slots: (ReferenceSelection | null)[] = [prev[0] ?? null, prev[1] ?? null];
      slots[slot] = sel;
      // 清掉起始帧时让结束帧顺位补上：只有尾帧没有首帧对 API 是非法组合，不能留出这个状态
      if (!slots[0] && slots[1]) {
        slots[0] = slots[1];
        slots[1] = null;
      }
      return slots.filter((item): item is ReferenceSelection => item !== null);
    });
  };
  /** 镜像卡片只是静态预览，不传版本号（无需破缓存），缩略图尺寸与 ReferencePicker 保持一致 */
  const refThumb = (item: ReferenceSelection) => materialImageUrl(item.id, undefined, "processed", 256);

  const submit = async () => {
    if (submitting || !prompt.trim() || !hasProvider) return;
    setSubmitting(true);
    const name = namePrefix ? `${namePrefix}-${Date.now()}` : undefined;
    try {
      const result = await api.generateMaterial({
        prompt: prompt.trim(),
        count: mediaKind === "video" ? 1 : count,
        autoMatting,
        ...selection,
        folderId,
        ...(name ? { name } : {}),
        intent: mediaKind === "video" ? ("frame-video" as const) : ("frame-image" as const),
        ...(mediaKind === "video" ? { mediaKind: "video" as const } : {}),
        ...(size ? { size } : {}),
        ...(effectiveReferences.length ? { references: effectiveReferences } : {}),
        // 显式告知服务端本次要什么形态，它才能区分「首尾同帧循环」与「只要首帧」
        ...(mediaKind === "video" && derivedVideoMode ? { videoInputMode: derivedVideoMode } : {}),
      });
      // 只回收本次实际送出去的那些；用户上传后又取消勾选的，也一并收掉
      if (ephemeralIdsRef.current.length) {
        cleanupEphemeralAfterJob(result.jobId, ephemeralIdsRef.current);
        ephemeralIdsRef.current = [];
      }
      await onQueued({ jobId: result.jobId, name: name ?? "", mediaKind });
    } catch (error) {
      notify(t("msg.submit_failed_msg", { msg: (error as Error).message }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    /*
      分块结构（方案 B）：顶部模式条 → 两块卡片栅格 → 底部参数条。
      栅格的列数由 @container 按「面板自身宽度」决定而不是视口宽度——本组件同时
      渲染在素材库弹窗（窄）和 Pipeline 工作区（宽）里，用 @media 会让弹窗在大屏下
      被误判成宽容器而挤成两列。
    */
    <div className={`generate-material-panel ${className}`.trim()}>
      {/* 生成内容决定下面每一块的形态，所以独占一行放在最上面 */}
      <div className="form-row gen-mode-row">
        <label>{t("msg.generate_as")}</label>
        <PxSelect
          value={mediaKind}
          options={[
            { value: "image", label: t("msg.images_one_by_one") },
            { value: "video", label: t("msg.video_then_extract_in_materials") },
          ]}
          onChange={(value) => {
            setMediaKind(value as "image" | "video");
            setSize("");
          }}
        />
      </div>

      <div className="gen-blocks">
        <section className="gen-block">
          {/* 块标题兼任原「帧图片上传」标题，格式限制贴右——卡片只保留一层，
              不再是 .gen-block 里再套一张 .keyframe-upload 卡片 */}
          <h3 className="gen-block-title">
            <Images size={14} aria-hidden="true" />
            {usesKeyframeSlots ? t("generation.keyframe.title") : t("generation.block.input")}
            {usesKeyframeSlots && (
              <span className="gen-block-note">{t("generation.keyframe.formats")}</span>
            )}
          </h3>
          <div className="gen-block-body">
            {/*
              首尾帧形态改用两个具名槽位，而不是通用的多选引用图。
              通用选择器只给出「已选 2 张」，用户无从得知哪张当起始、哪张当结束——
              而这两者对生成结果的影响完全不同，猜错等于白跑一次任务。
            */}
            {usesKeyframeSlots ? (
              <>
                <div className="keyframe-slots">
                  <ReferencePicker
                    value={firstFrameRef}
                    onChange={(sel) => setKeyframeSlot(0, sel)}
                    label={t("generation.keyframe.first")}
                    onEphemeralUpload={(ids) => ephemeralIdsRef.current.push(...ids)}
                  />
                  {/* 起始帧刻意不做硬必填：留空即纯文生视频，这是面板原有能力，
                      参考站因为整个流程都是图→视频才要求必填 */}
                  {wantsLoop ? (
                    /*
                      开关打开时这一格不再是控件，而是一张静态镜像卡片。
                      做成 disabled 的输入框仍然可被键盘聚焦、读屏会念出一个不可用的上传
                      按钮，换成说明性卡片对无障碍更干净，也更直白地表达「它跟着起始帧走」。
                    */
                    <div className="form-row">
                      <label>{t("generation.keyframe.last")}</label>
                      <div className="keyframe-mirror">
                        {firstFrameRef ? (
                          <img src={refThumb(firstFrameRef)} alt="" draggable={false} loading="lazy" decoding="async" />
                        ) : (
                          <span className="keyframe-mirror-empty" aria-hidden="true">
                            <Repeat size={16} />
                          </span>
                        )}
                        <span className="keyframe-mirror-text">{t("generation.keyframe.mirrored")}</span>
                      </div>
                    </div>
                  ) : (
                    <ReferencePicker
                      value={lastFrameRef}
                      onChange={(sel) => setKeyframeSlot(1, sel)}
                      label={t("generation.keyframe.last")}
                      onEphemeralUpload={(ids) => ephemeralIdsRef.current.push(...ids)}
                    />
                  )}
                </div>
                {/* 只有还没单独选结束帧时，这个开关才有意义 */}
                {!lastFrameRef && (
                  <label className="px-check keyframe-loop">
                    <input
                      type="checkbox"
                      checked={loopFromFirstFrame}
                      onChange={(event) => setLoopFromFirstFrame(event.target.checked)}
                    />
                    <Repeat size={14} aria-hidden="true" />
                    <span>{t("generation.videoMode.loopFromFirst")}</span>
                  </label>
                )}
              </>
            ) : (
              <ReferencePicker
                value={references}
                onChange={setReferences}
                max={maxReferences}
                onEphemeralUpload={(ids) => ephemeralIdsRef.current.push(...ids)}
              />
            )}

            {/*
              讲清楚「你填的图这次会被当成什么」。形态是从槽位派生的，所以这行提示
              会随填写实时变化：留空 → 纯文生、只填起始帧 → 首帧驱动、填了结束帧或
              勾了复制 → 首尾帧。

              槽位模式下留空时**不能**复用 videoMode.text 那句——它写的是「该模型
              不接受引用图，请到设置页声明」，而现在恰恰不需要去设置页，选张图就行。
              照搬会把用户支去改一个根本不用改的设置。
            */}
            {usesKeyframeSlots && derivedVideoMode === "text" ? (
              <div className="hint">{t("generation.keyframe.emptyMeansText")}</div>
            ) : (
              derivedVideoMode && <div className="hint">{t(`generation.videoMode.${derivedVideoMode}`)}</div>
            )}
            {derivedVideoMode && references.length > maxReferences && (
              <div className="hint warn">
                {t("generation.videoMode.tooManyRefs", { max: maxReferences, count: references.length })}
              </div>
            )}
            {/* 仅在模型被显式声明为纯文生、用户却仍选了图时才警告 */}
            {!usesKeyframeSlots && videoInputMode === "text" && references.length > 0 && (
              <div className="hint warn">{t("generation.videoMode.textRejectsRefs")}</div>
            )}
          </div>
        </section>

        <section className="gen-block">
          <h3 className="gen-block-title">
            <Type size={14} aria-hidden="true" />
            {t("generation.block.prompt")}
          </h3>
          <div className="gen-block-body">
            <PromptEnhancer
              mediaKind={mediaKind}
              referenceImageCount={references.length}
              label={t("msg.prompt")}
              placeholder={mediaKind === "video" ? t("msg.e_g_pixel_knight_running_right_looping") : t("msg.e_g_cloaked_slime_idle_breathing")}
              value={prompt}
              onChange={setPrompt}
            />
            {mediaKind === "image" && (
              <div className="form-row">
                <label>{t("msg.count_count", { count })}</label>
                <input type="range" min={1} max={16} value={count} onChange={(event) => setCount(Number(event.target.value))} />
              </div>
            )}
            {mediaKind === "video" && <div className="hint">{t("msg.saves_video_only_open_the_material_later_and_extract_fra")}</div>}
          </div>
        </section>
      </div>

      {/*
        参数条：provider / 模型 / 尺寸横向铺开 + 右侧主按钮，对应参考站最下面那一行。
        原先这些被折叠在「高级生成设置」里，等于把每次生成都要确认的模型和尺寸藏起来。
      */}
      <section className="gen-params">
        <h3 className="gen-block-title gen-params-title">
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t("generation.block.params")}
        </h3>
        <div className="gen-params-fields">
          <ProviderModelPicker
            providerId={providerId}
            model={model}
            onProviderChange={setProviderId}
            onModelChange={setModel}
            videoOnly={mediaKind === "video"}
            preferI2v={mediaKind === "video" && references.length > 0}
          />
          <SizePicker providerId={providerId} value={size} onChange={setSize} forVideo={mediaKind === "video"} />
          {mediaKind === "image" && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}
        </div>
        <div className="gen-params-action">
          {!hasProvider && <div className="hint warn">{t("msg.no_gen_provider_add_cli_api_providers_in_settings")}</div>}
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            className="px-btn accent"
            disabled={!hasProvider || submitting || !prompt.trim()}
            onClick={() => void submit()}
          >
            <Sparkles size={14} /> {submitLabel ?? t("msg.start_generate")}
          </motion.button>
        </div>
      </section>

      {/* 三段 CLI / provider 说明是查阅性内容，默认收起来换取「简约」，需要时展开 */}
      <details className="gen-help">
        <summary>{t("generation.helpToggle")}</summary>
        <div className="hint">
          {t("msg.configure_generation_in_settings_cli_openai_compatible_b")} <code>EZGAMEART_GEN_CLI</code> {t("msg.fallback")}
          <br />
          {t("msg.cli_set_command_arg_names_no_placeholders_ref_images_nee")}
          <br />
          {t("msg.video_gen_cli_bailian_minimax_only_async_extract_frames")}
        </div>
      </details>
    </div>
  );
}
