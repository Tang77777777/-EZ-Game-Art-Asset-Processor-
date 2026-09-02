#!/usr/bin/env bash
# EZ 游戏美术素材加工器 内置抠图引擎安装：Python 3.11+ venv → .venv-matting/ + pip install "rembg[cli,cpu|gpu]"
# 首次抠图会自动下载模型到 storage/models（U2NET_HOME 由服务端注入）
# 用法：
#   ./scripts/setup_matting.sh           # CPU（默认）
#   ./scripts/setup_matting.sh --gpu     # NVIDIA GPU（onnxruntime-gpu，需 CUDA Toolkit）
set -euo pipefail
cd "$(dirname "$0")/.."

GPU=0
if [[ "${1:-}" == "--gpu" ]]; then
  GPU=1
fi

REMBG_EXTRA="cpu"
if [[ "$GPU" -eq 1 ]]; then
  REMBG_EXTRA="gpu"
  echo "GPU 模式：将安装 onnxruntime-gpu（需要 NVIDIA 显卡 + CUDA Toolkit）"
  echo "如果遇到 DLL 加载错误，请检查 CUDA 版本是否与 onnxruntime-gpu 要求匹配"
  echo ""
fi
REMBG_PKG="rembg[cli,$REMBG_EXTRA]"

VENV=".venv-matting"
PYTHON="${PYTHON:-}"

if [ -x "$VENV/bin/rembg" ]; then
  echo "rembg 已安装：$VENV/bin/rembg（如需重装请删除 $VENV 后重跑）"
  exit 0
fi

version_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if (3, 11) <= sys.version_info[:2] < (3, 14) else 1)' >/dev/null 2>&1
}

PYTHON_BIN=""
if [[ -n "$PYTHON" ]]; then
  if ! command -v "$PYTHON" >/dev/null 2>&1 && [[ ! -x "$PYTHON" ]]; then
    echo "错误：PYTHON 指定的解释器不存在：$PYTHON"
    exit 1
  fi
  if ! version_ok "$PYTHON"; then
    echo "错误：rembg 需要 Python 3.11–3.13，当前解释器不兼容：$($PYTHON --version 2>&1)"
    echo "请安装 Python 3.12，或使用 uv（https://docs.astral.sh/uv/）后重试。"
    exit 1
  fi
  PYTHON_BIN="$PYTHON"
else
  for candidate in python3.13 python3.12 python3.11 python3; do
    if command -v "$candidate" >/dev/null 2>&1 && version_ok "$candidate"; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
fi

if [[ -n "$PYTHON_BIN" ]]; then
  echo "→ 创建 venv: $VENV ($($PYTHON_BIN --version 2>&1))"
  "$PYTHON_BIN" -m venv "$VENV"

  echo "→ 升级 pip"
  "$VENV/bin/pip" install --upgrade pip

  echo "→ 安装 ${REMBG_PKG}（含 onnxruntime $REMBG_EXTRA 后端，依赖较多，首次较慢）"
  "$VENV/bin/pip" install "${REMBG_PKG}"
elif command -v uv >/dev/null 2>&1; then
  if [[ -x "$VENV/bin/python" ]] && version_ok "$VENV/bin/python"; then
    echo "→ 复用已创建的 Python venv: $VENV ($($VENV/bin/python --version 2>&1))"
  else
    echo "→ 未找到兼容的系统 Python，使用 uv 创建 Python 3.12 venv"
    uv venv --python 3.12 "$VENV"
  fi
  echo "→ 安装 ${REMBG_PKG}（含 onnxruntime $REMBG_EXTRA 后端，依赖较多，首次较慢）"
  uv pip install --python "$VENV/bin/python" "${REMBG_PKG}"
else
  echo "错误：rembg 需要 Python 3.11–3.13；当前未找到兼容解释器，也未找到 uv。"
  echo "请安装 Python 3.12（或 uv：https://docs.astral.sh/uv/）后重试。"
  exit 1
fi

echo ""
echo "✓ 安装完成：$VENV/bin/rembg"
echo "  EZ 游戏美术素材加工器 启动时会自动探测到它（engine=rembg-bundled）"
echo "  默认模型 u2net，可用 EZGAMEART_MATTING_MODEL 环境变量切换（如 birefnet-general-lite）"
