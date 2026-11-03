#!/usr/bin/env bash
# 一键启动：自动检测 GPU
#   有 GPU：vLLM 大模型(8000) + Flask 后端(6006)
#   无 GPU：仅 Flask 后端(6006)（聊天/AI 解读降级，测评与人脸视频分析可用）
# 用法：bash /root/ai-psy/start_all.sh [app.py 参数，如 --mock]
# 通常只需修改下方「参数配置区」；启动逻辑与原版一致（变量化 + 环境校验增强）。
set -e
cd "$(dirname "$0")"

# ==================== 参数配置区（按需修改） ====================
# --- conda 环境与初始化路径 ---
QWEN_ENV="qwen_env"        # vLLM 推理环境
PYFEAT_ENV="pyfeat_env"    # Flask 后端 + 视频分析环境
CONDA_CANDIDATES="/root/miniconda-new /root/miniconda3"  # conda 初始化脚本候选根目录（依次探测）

# --- vLLM 服务 ---
VLLM_HOST="0.0.0.0"
VLLM_PORT=8000
GPU_MEM_UTIL=0.9                       # 显存占用比例（与训练腾退约束配套）
BF16_BASE=/root/autodl-tmp/Qwen2.5-7B-Instruct        # bf16 原版基座（支持 --enable-lora 热挂载）
LORA_DIR=/root/autodl-tmp/qwen25-7b-lora-ai_chat      # 已训练的 ai_chat 适配器目录
LORA_NAME="psych-chat"                 # LoRA 注册名，必须与 config.CHAT_LORA_NAME 一致

# ==================== 环境校验区 ====================
# 1. conda 初始化脚本探测（优先新装路径，兼容 AutoDL 默认路径；找不到明确报错）
CONDA_OK=""
for _c in $CONDA_CANDIDATES; do
  if [ -f "$_c/etc/profile.d/conda.sh" ]; then
    # shellcheck disable=SC1090
    source "$_c/etc/profile.d/conda.sh"
    CONDA_OK=1
    break
  fi
done
if [ -z "$CONDA_OK" ]; then
  echo "[错误] 未找到 conda 初始化脚本（候选：$CONDA_CANDIDATES）"
  echo "       请确认 miniconda 安装路径，或修改本脚本顶部 CONDA_CANDIDATES"
  exit 1
fi

# 2. conda 环境存在性检查（缺失给出创建命令指引，避免激活时报晦涩错误）
if ! conda env list | awk '$1 !~ /^#/ {print $1}' | grep -qx "$PYFEAT_ENV"; then
  echo "[错误] conda 环境 $PYFEAT_ENV 不存在（Flask 后端必需）"
  echo "       创建命令见 README.md「快速开始 · 创建双 conda 环境」"
  exit 1
fi
if nvidia-smi > /dev/null 2>&1 && ! conda env list | awk '$1 !~ /^#/ {print $1}' | grep -qx "$QWEN_ENV"; then
  echo "[错误] 检测到 GPU 但 conda 环境 $QWEN_ENV 不存在（vLLM 必需）"
  echo "       创建命令见 README.md「快速开始 · 创建双 conda 环境」；或先无卡降级运行"
  exit 1
fi

# ---------- 1/2 vLLM 大模型(8000)：仅在有 GPU 时启动 ----------
if nvidia-smi > /dev/null 2>&1; then
  if curl -s "http://127.0.0.1:${VLLM_PORT}/v1/chat/completions" -o /dev/null --max-time 3; then
    echo "vLLM 已在运行，跳过"
  else
    conda activate "$QWEN_ENV"
    MODEL="$BF16_BASE"
    if [ ! -d "$MODEL" ]; then
      echo "!! 未找到基座模型（$MODEL），跳过 vLLM；聊天/AI 解读降级显示"
    else
      LORA_ARGS=""
      # bf16 基座 + 已训练好的 ai_chat 适配器 -> 注册 psych-chat（与 config.CHAT_LORA_NAME 一致）
      if [ -d "$LORA_DIR" ]; then
        LORA_ARGS="--enable-lora --max-loras 1 --lora-modules ${LORA_NAME}=${LORA_DIR}"
        echo "vLLM 挂载 LoRA：${LORA_NAME} -> $LORA_DIR"
      fi
      nohup vllm serve "$MODEL" --host "$VLLM_HOST" --port "$VLLM_PORT" \
          --gpu-memory-utilization "$GPU_MEM_UTIL" $LORA_ARGS \
          > vllm.log 2>&1 &
      echo "vLLM 启动中 -> ${VLLM_PORT}（基座：$MODEL，首次加载权重 1~3 分钟）"
    fi
    conda deactivate
  fi
else
  echo "未检测到 GPU，跳过 vLLM（聊天/AI 解读将降级显示）"
fi

# ---------- 2/2 Flask 后端(6006) ----------
if pgrep -f "python app.py" > /dev/null; then
  echo "Flask 已在运行，跳过"
else
  conda activate "$PYFEAT_ENV"
  nohup python app.py "$@" > app.log 2>&1 &
  echo "Flask 启动中 -> 6006"
  conda deactivate
fi

echo ""
echo "=== 完成。检查 ==="
echo "Flask: curl http://127.0.0.1:6006/api/config"
if nvidia-smi > /dev/null 2>&1; then
  echo "vLLM : curl http://127.0.0.1:${VLLM_PORT}/v1/models"
fi
echo "AI 模块调优与生效方式见 README.md「🤖 AI 模块调优指南」"
