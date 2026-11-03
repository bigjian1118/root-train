#!/usr/bin/env bash
# =====================================================================
# 一键 QLoRA 微调（只训练 AI 聊天能力 psych-chat；使用 autodl-fs/dataset/ai_chat 已有数据，不自动生成）
#
# 用法：
#   bash train_all.sh            # 训练 ai_chat（有检查点自动续训）
#   bash train_all.sh --fresh    # 忽略旧检查点，从头训练
#
# 流程：参数区 -> conda 激活 -> 依赖检查 -> GPU/显存腾退（自动停 vLLM）->
#       基座检查 -> 数据集检查 -> 训练 -> 完成指引
# 使用者通常只需修改下方「参数配置区」。
# =====================================================================
set -e
cd "$(dirname "$0")"

# ==================== 参数配置区（按需修改） ====================
# --- 运行环境 ---
CONDA_ENV="qwen_env"                                     # 训练用 conda 环境
CONDA_PROFILE="/root/miniconda3/etc/profile.d/conda.sh"  # AutoDL 默认 conda 初始化路径

# --- 可经 CLI 覆盖的训练参数（与 train_qlora.py 实际支持的参数一一对应；
#     默认值与 config.py 完全一致，不改动时训练行为与原命令相同） ---
SCENARIO="ai_chat"        # 数据集/适配器选择（当前仅 ai_chat）
LORA_RANK=8               # LoRA 秩 r（config.LORA_R 默认 8）
LORA_ALPHA=16             # LoRA 缩放系数（惯例 2*r；config.LORA_ALPHA 默认 16）
LEARNING_RATE=2e-4        # 学习率（config.LEARNING_RATE 默认 2e-4）
NUM_EPOCHS=3              # 训练轮数（config.NUM_EPOCHS 默认 3）
OUT_DIR=""                # 适配器输出目录；留空 = config 默认 {AUTODL_TMP}/qwen25-7b-lora-{SCENARIO}

# --- 只读参数（固化于 config.py，如需调整请直接改 config.py） ---
#   基座模型路径：{AUTODL_TMP}/Qwen2.5-7B-Instruct（bf16 原版，候选顺序 bf16→hf缓存→AWQ 兜底）
#   量化方案：    4bit NF4 双重量化 + bf16 计算精度
#   批次大小：    PER_DEVICE_TRAIN_BATCH_SIZE=4，梯度累积 2（等效 batch=8）
#   序列长度：    MAX_SEQ_LENGTH=1024；warmup=0.03；weight_decay=0.01
#   日志/保存：   每 10 步打印 loss，每 50 步存 checkpoint（断点续训依据）
#   （AUTODL_TMP=/root/autodl-tmp，AUTODL_FS=/root/autodl-fs，本地模拟自动回退项目同级目录）

# ---------- 0. 参数解析 ----------
FRESH=""
for arg in "$@"; do
  case "$arg" in
    --fresh) FRESH="--fresh" ;;
    *) echo "[错误] 未知参数：$arg（可用：--fresh）"; exit 1 ;;
  esac
done

# ---------- 1. conda 环境激活（已在目标环境内则跳过） ----------
if [ "${CONDA_DEFAULT_ENV:-}" != "$CONDA_ENV" ]; then
  if [ -f "$CONDA_PROFILE" ]; then
    # shellcheck disable=SC1090
    source "$CONDA_PROFILE"
    conda activate "$CONDA_ENV"
  else
    echo "[错误] 未找到 conda 初始化脚本：$CONDA_PROFILE"
    echo "       请先手动 conda activate $CONDA_ENV 再运行，或修改顶部 CONDA_PROFILE"
    exit 1
  fi
fi
echo "[OK] conda 环境：$CONDA_ENV（$(python --version 2>&1)）"

# 修复 libgomp "Invalid value for OMP_NUM_THREADS"（环境里该变量可能被设成空/非法值）
export OMP_NUM_THREADS=8
# 降低显存碎片化（OOM 提示官方建议）
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# ---------- 2. 核心训练依赖检查（缺失自动补装，保证真正一键训练） ----------
TRAIN_DEPS=("peft==0.13.2" "trl==0.12.0" "bitsandbytes==0.45.0" "accelerate==1.1.1" "datasets==3.1.0")
if ! python -c "import peft, trl, bitsandbytes, accelerate, datasets" 2>/dev/null; then
  echo "[提示] 检测到缺少 QLoRA 训练依赖，自动补装：${TRAIN_DEPS[*]}"
  pip install "${TRAIN_DEPS[@]}" || {
    echo "[错误] 依赖自动补装失败（多为网络问题），可先 source /etc/network_turbo 后重跑本脚本"
    exit 1
  }
fi
python - <<'PY'
import transformers, peft, trl, bitsandbytes
print(f"[OK] transformers {transformers.__version__} / peft {peft.__version__} / trl {trl.__version__} / bitsandbytes {bitsandbytes.__version__}")
PY

# ---------- 3. GPU 检查与显存腾退（7B QLoRA 需 ≥20GB 空闲） ----------
if ! nvidia-smi > /dev/null 2>&1; then
  echo "[错误] 未检测到 GPU，请在有卡实例（如 RTX 4090）上运行训练"
  exit 1
fi
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv

gpu_used() { nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -n1; }
USED=$(gpu_used)
if [ "$USED" -gt 2000 ]; then
  echo "[提示] 检测到显存已被占用（${USED}MiB，疑似 vLLM 未关闭），自动停止 vLLM 释放显存…"
  pkill -f "vllm serve" || true
  sleep 5
  USED=$(gpu_used)
  # 仍被占用则再等一下（vLLM worker 进程退出有延迟）
  if [ "$USED" -gt 2000 ]; then sleep 10; USED=$(gpu_used); fi
  if [ "$USED" -gt 2000 ]; then
    echo "[错误] 停止 vLLM 后显存仍被占用（${USED}MiB）。"
    echo "       请手动排查占用进程：nvidia-smi → kill <PID>，再重跑本脚本。"
    exit 1
  fi
  echo "[OK] vLLM 已停止，显存已释放（当前占用 ${USED}MiB）"
  echo "     注意：训练完成后需重新 bash ~/ai-psy/start_all.sh 恢复 vLLM 与聊天服务。"
fi
FREE=$(( $(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | head -n1) - USED ))
if [ "$FREE" -lt 20000 ]; then
  echo "[错误] 空闲显存仅 ${FREE}MiB（需 ≥20000MiB 才能训 7B QLoRA），请先释放显存"
  exit 1
fi
echo "[OK] 显存检查通过：空闲 ${FREE}MiB"

# ---------- 4. 基座模型检查（本地两种基座均无时，训练时自动经 hf-mirror 下载 bf16） ----------
BASE_DIR="${AUTODL_TMP:-/root/autodl-tmp}"
if [ ! -d "$BASE_DIR/Qwen2.5-7B-Instruct" ] && [ ! -d "$BASE_DIR/Qwen2.5-7B-Instruct-AWQ" ]; then
  echo "[提示] 本地未找到 Qwen2.5-7B-Instruct（bf16）基座，首次训练将经 hf-mirror 自动下载到"
  echo "       $BASE_DIR/huggingface（约 16GB，需 10~20 分钟）。如已有 AWQ 版可继续但需 autoawq 库。"
fi

# ---------- 5. 数据集检查：只用已有数据，缺失直接报错，不自动生成 ----------
DATASET_FILE=$(python -c "import config; print(config.scenario_train_file('$SCENARIO'))")
if [ ! -s "$DATASET_FILE" ]; then
  echo "[错误] 数据集不存在：$DATASET_FILE"
  echo "       按要求只使用已有数据训练，不自动生成。"
  echo "       如确需生成，请手动运行：python prepare_dataset.py"
  exit 1
fi
TRAIN_N=$(wc -l < "$DATASET_FILE")
echo "===== [1/2] 数据集就绪：$SCENARIO（train.jsonl 共 $TRAIN_N 条，使用已有数据）====="

# ---------- 6. 训练（参数区变量传入；默认值与 config.py 一致，不改动时行为等同原命令） ----------
echo "===== [2/2] 开始训练：$SCENARIO ${FRESH:+（从头训练）} ====="
CMD=(python train_qlora.py --scenario "$SCENARIO"
     --rank "$LORA_RANK" --alpha "$LORA_ALPHA"
     --lr "$LEARNING_RATE" --epochs "$NUM_EPOCHS")
# 注意：set -e 下不可用 "[ -n x ] && ..." 短路写法（条件为假会中断脚本），故用 if
if [ -n "$OUT_DIR" ]; then CMD+=(--out-dir "$OUT_DIR"); fi
if [ -n "$FRESH" ];   then CMD+=("$FRESH"); fi
echo "执行命令：${CMD[*]}"
"${CMD[@]}"

# ---------- 7. 完成提示 ----------
FINAL_OUT_DIR="${OUT_DIR:-$(python -c "import config; print(config.scenario_output_dir('$SCENARIO'))")}"
echo ""
echo "✅ 训练完成。AI 聊天 LoRA 适配器保存路径："
echo "   $FINAL_OUT_DIR"
echo "   （adapter_config.json + adapter_model.safetensors + checkpoints/）"
echo ""
echo "后续步骤（二选一）："
echo "  A. 线上部署（推荐，无需合并）：bash ~/ai-psy/start_all.sh"
echo "     （检测到 bf16 基座+适配器会自动 --enable-lora 挂载 psych-chat，Flask 端 LORA_ENABLED 亦自动开启）"
echo "     或手动：vllm serve /root/autodl-tmp/Qwen2.5-7B-Instruct --host 0.0.0.0 --port 8000 \\"
echo "             --gpu-memory-utilization 0.9 --enable-lora --max-loras 1 \\"
echo "             --lora-modules psych-chat=$FINAL_OUT_DIR"
echo "  B. 合并为全量模型（bf16 基座 + adapter → 单模型目录）——"
echo "     python merge_adapter.py --adapter $FINAL_OUT_DIR"
echo ""
echo "推理自测：python chat_with_lora.py -q \"我最近总是失眠很焦虑\" --scenario $SCENARIO"
echo "更多说明见 README.md"
