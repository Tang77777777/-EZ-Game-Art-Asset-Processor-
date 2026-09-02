import { useState } from "react";
import { motion } from "motion/react";
import { IMAGE_LAYER_COUNT_MAX, IMAGE_LAYER_COUNT_MIN } from "@ezgameart/shared";
import { api } from "../api";
import { useT } from "../i18n";
import { notify } from "../notice";
import MattingOption from "./MattingOption";

interface Props {
  materialId: string;
  hasProcessed: boolean;
  model: string;
  onClose: () => void;
  onQueued: () => void;
}

export default function LayerSplitModal({ materialId, hasProcessed, model, onClose, onQueued }: Props) {
  const t = useT();
  const [layers, setLayers] = useState(4);
  const [steps, setSteps] = useState(50);
  const [cfg, setCfg] = useState(4);
  const [negativePrompt, setNegativePrompt] = useState("");
  const [seed, setSeed] = useState(0);
  const [autoMatting, setAutoMatting] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.layerMaterial(materialId, {
        layers,
        numInferenceSteps: steps,
        trueCfgScale: cfg,
        negativePrompt: negativePrompt || undefined,
        seed,
        autoMatting: !hasProcessed && autoMatting,
      });
      onQueued();
    } catch (e) {
      notify((e as Error).message);
      setBusy(false);
    }
  };

  return <motion.div className="modal-mask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <motion.div className="modal pixel-panel layer-split-modal" initial={{ scale: 0.94 }} animate={{ scale: 1 }} onClick={(e) => e.stopPropagation()}>
      <h2>{t("layers.title")}</h2>
      <div className="hint">{t("layers.activeModel", { model })}</div>
      <div className="hint">{t("layers.purpose")}</div>
      <div className="form-inline">
        <label className="field"><span>{t("layers.count")}</span><input className="px-input num" type="number" min={IMAGE_LAYER_COUNT_MIN} max={IMAGE_LAYER_COUNT_MAX} value={layers} onChange={(e) => setLayers(Math.max(IMAGE_LAYER_COUNT_MIN, Math.min(IMAGE_LAYER_COUNT_MAX, Number(e.target.value) || 4)))} /></label>
        <label className="field"><span>{t("layers.steps")}</span><input className="px-input num" type="number" min={1} max={100} value={steps} onChange={(e) => setSteps(Math.max(1, Math.min(100, Number(e.target.value) || 50)))} /></label>
        <label className="field"><span>{t("layers.cfg")}</span><input className="px-input num" type="number" min={0} max={20} step={0.1} value={cfg} onChange={(e) => setCfg(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} /></label>
        <label className="field"><span>{t("layers.seed")}</span><input className="px-input num" type="number" min={0} step={1} value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} /></label>
      </div>
      <label className="field"><span>{t("layers.negativePrompt")}</span><textarea className="px-input" value={negativePrompt} onChange={(e) => setNegativePrompt(e.target.value)} /></label>
      {!hasProcessed && <MattingOption checked={autoMatting} onChange={setAutoMatting} />}
      <div className="modal-actions"><button className="px-btn" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button className="px-btn accent" type="button" disabled={busy} onClick={() => void submit()}>{busy ? t("common.submitting") : t("layers.submit")}</button></div>
    </motion.div>
  </motion.div>;
}
