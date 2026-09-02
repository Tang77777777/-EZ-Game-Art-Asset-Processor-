import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MattingEngine } from "@ezgameart/shared";
import { db, getMaterial, REPO_ROOT, STORAGE_ROOT } from "../db";
import { getMattingSettings } from "../provider";
import { broadcast } from "../ws";
import { runCmd } from "./run";

// ===== 抠图引擎探测（每次调用重新解析，设置页改动即时生效；解析顺序见下）=====

export interface MattingInfo {
  engine: MattingEngine;
  model: string;
  /** engine=none 时给用户的提示 */
  hint: string | null;
}

/** 内置 rembg 候选路径：POSIX 为 bin/rembg，Windows venv 布局为 Scripts/rembg.exe */
const BUNDLED_REMBG_CANDIDATES = [
  join(REPO_ROOT, ".venv-matting", "bin", "rembg"),
  join(REPO_ROOT, ".venv-matting", "Scripts", "rembg.exe"),
];
/** 找到的第一个内置 rembg（每次调用重新探测，装上引擎不用重启） */
export function bundledRembg(): string | null {
  return BUNDLED_REMBG_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const IS_WIN = process.platform === "win32";
const SETUP_SCRIPT = IS_WIN ? "scripts/setup_matting.ps1" : "scripts/setup_matting.sh";
const NO_ENGINE_HINT = `未安装抠图引擎，已原样复制：请先执行 ${SETUP_SCRIPT}`;

export function getMattingInfo(): MattingInfo {
  const { cliBin, envTemplate, model } = getMattingSettings();
  if (cliBin.trim() || envTemplate) return { engine: "custom-cli", model, hint: null };
  if (bundledRembg()) return { engine: "rembg-bundled", model, hint: null };
  if (Bun.which("rembg")) return { engine: "rembg-path", model, hint: null };
  return { engine: "none", model, hint: NO_ENGINE_HINT };
}

/**
 * 抠图执行，解析顺序：
 * a. 设置页结构化 CLI（命令 + 参数名映射，免模板）或 env EZGAMEART_MATTING_CLI 遗留模板（占位符 {input} {output}，可选 {model}）
 * b. <repo>/.venv-matting 内置 rembg（scripts/setup_matting.sh / .ps1 安装，POSIX 为 bin/rembg，Windows 为 Scripts/rembg.exe）
 * c. PATH 中的 rembg
 * d. passthrough 复制（返回警告提示安装）
 * 返回警告文案（无警告为 null）；b/c 会注入 U2NET_HOME=<repo>/storage/models
 */
async function runMatting(input: string, output: string, signal?: AbortSignal): Promise<string | null> {
  const { cliBin, cliInputArg, cliOutputArg, cliModelArg, envTemplate, model } = getMattingSettings();

  if (cliBin.trim()) {
    const argv = [cliBin.trim()];
    if (cliInputArg.trim()) argv.push(cliInputArg.trim());
    argv.push(input);
    if (cliOutputArg.trim()) argv.push(cliOutputArg.trim());
    argv.push(output);
    if (cliModelArg.trim()) argv.push(cliModelArg.trim(), model);
    await runCmd(argv, undefined, signal);
    return null;
  }

  if (envTemplate) {
    const argv = envTemplate
      .split(/\s+/)
      .map((tok) =>
        tok.replaceAll("{input}", input).replaceAll("{output}", output).replaceAll("{model}", model)
      );
    await runCmd(argv, undefined, signal);
    return null;
  }

  const rembgBin = bundledRembg() ?? Bun.which("rembg");
  if (rembgBin) {
    const u2netHome = join(STORAGE_ROOT, "models");
    mkdirSync(u2netHome, { recursive: true });
    await runCmd([rembgBin, "i", "-m", model, input, output], { U2NET_HOME: u2netHome }, signal);
    return null;
  }

  copyFileSync(input, output);
  return NO_ENGINE_HINT;
}

/** 抠图并更新素材。返回警告文案（null = 真抠图）。 */
export async function matteMaterial(materialId: string, signal?: AbortSignal): Promise<string | null> {
  const m = getMaterial(materialId);
  if (!m) throw new Error(`素材不存在: ${materialId}`);
  if (!m.raw_path) throw new Error(`素材缺少 raw 文件: ${materialId}`);

  const outPath = join(STORAGE_ROOT, "materials", materialId, "processed.png");
  mkdirSync(dirname(outPath), { recursive: true });
  const warning = await runMatting(m.raw_path, outPath, signal);

  db.query("UPDATE materials SET status = 'matted', processed_path = ? WHERE id = ?").run(outPath, materialId);
  broadcast("material_updated", { id: materialId });
  return warning;
}
