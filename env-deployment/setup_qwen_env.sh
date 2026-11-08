#!/usr/bin/env bash
# =====================================================================
# qwen_env（大模型推理环境）一键配置脚本
# 内容：创建 conda 环境 + 安装 torch cu121 / vLLM 依赖 + 下载 bf16 基座
# 用法：bash setup_qwen_env.sh [all|env|model]     # 默认 all
#   env    仅创建 qwen_env 并装推理依赖
#   model  仅下载 Qwen2.5-7B-Instruct bf16 基座到 autodl-tmp
# 幂等：环境已存在/依赖已装/基座已就位时自动跳过；重复运行安全。
# 可覆盖环境变量：CONDA_BASE / PROJ / AUTODL_TMP_DIR / PIP_MIRROR
# 后端环境(pyfeat_env)请用 setup_pyfeat_env.sh；启动/验证见 ai-psy/README.md「快速开始」。
# =====================================================================
set -euo pipefail

CONDA_BASE="${CONDA_BASE:-}"
if [ -z "$CONDA_BASE" ]; then
  for _c in /root/miniconda-new /root/miniconda3; do
    [ -f "$_c/etc/profile.d/conda.sh" ] && CONDA_BASE="$_c" && break
  done
fi
[ -n "$CONDA_BASE" ] || { echo "[错误] 未找到 conda 安装路径"; exit 1; }
PROJ="${PROJ:-$HOME/ai-psy}"
TMP="${AUTODL_TMP_DIR:-/root/autodl-tmp}"
BASE_MODEL="$TMP/Qwen2.5-7B-Instruct"
PIP_MIRROR="${PIP_MIRROR:-}"          # 留空用默认源；可设 https://mirrors.aliyun.com/pypi/simple/
STEP="${1:-all}"

pip_flag=()
[ -n "$PIP_MIRROR" ] && pip_flag=(-i "$PIP_MIRROR")

log()  { echo -e "\n\033[1;36m[$(date +%H:%M:%S)] $*\033[0m"; }
fail() { echo -e "\033[1;31m[错误] $*\033[0m" >&2; exit 1; }

source "$CONDA_BASE/etc/profile.d/conda.sh"

# ---------- env：创建 qwen_env 并装推理依赖 ----------
do_env() {
  if conda env list | grep -q "^qwen_env "; then
    log "qwen_env 已存在，跳过创建(依赖补装)"
  else
    log "创建 qwen_env (python 3.12)"
    conda create -n qwen_env python=3.12 -y
  fi
  conda activate qwen_env
  if ! python -c "import vllm" 2>/dev/null; then
    log "安装 vLLM 环境依赖 (torch 2.5.1 cu121 + vllm 0.7.0)"
    pip install "torch==2.5.1" "torchvision==0.20.1" --index-url https://download.pytorch.org/whl/cu121
    pip install "${pip_flag[@]}" "vllm==0.7.0" safetensors "transformers==4.51.3" huggingface_hub
    python -c "import torch; print('cuda可用：', torch.cuda.is_available())"
  else
    log "vllm 已安装，跳过"
  fi
  # QLoRA 训练依赖（train_all.sh 校验项；推理-only 实例可注释本段）
  if ! python -c "import trl, peft, bitsandbytes, accelerate, datasets" 2>/dev/null; then
    log "安装 QLoRA 训练依赖 (peft/trl/bitsandbytes/accelerate/datasets)"
    pip install "${pip_flag[@]}" "peft==0.13.2" "trl==0.12.0" "bitsandbytes==0.45.0" "accelerate==1.1.1" "datasets==3.1.0"
  else
    log "训练依赖已安装，跳过"
  fi
  conda deactivate
  log "qwen_env 环境配置完成"
}

# ---------- model：下载 bf16 基座 ----------
do_model() {
  if [ -f "$BASE_MODEL/config.json" ] && compgen -G "$BASE_MODEL/*.safetensors" >/dev/null; then
    log "基座已存在：$BASE_MODEL，跳过下载"
    return
  fi
  mkdir -p "$TMP"
  conda activate qwen_env
  export HF_ENDPOINT=https://hf-mirror.com
  export HF_HUB_DISABLE_XET=1    # hf-mirror 不支持 Xet 协议，禁用后回退传统 HTTP 下载
  log "下载 Qwen2.5-7B-Instruct (bf16, 约 15GB，中断可重跑续传)"
  ( cd "$TMP" && hf download Qwen/Qwen2.5-7B-Instruct --local-dir Qwen2.5-7B-Instruct )
  conda deactivate
  [ -f "$BASE_MODEL/config.json" ] || fail "基座下载不完整，请重跑：bash $0 model"
  log "model 阶段完成：$BASE_MODEL"
}

case "$STEP" in
  env)   do_env ;;
  model) do_model ;;
  all)   do_env; do_model ;;
  *)     fail "未知阶段：$STEP（可用：all|env|model）" ;;
esac
