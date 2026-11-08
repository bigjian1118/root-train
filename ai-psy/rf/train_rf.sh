#!/usr/bin/env bash
# =====================================================================
# 随机森林一键训练脚本（规则蒸馏：SCL-90 十因子严重程度 + 视频主导情绪）
#
# 用法：
#   bash ai-psy/rf/train_rf.sh        # 训练文本 + 视频两组模型
#
# 流程：conda 激活 -> 依赖检查 -> 训练 rf.train_text -> 训练 rf.train_video
#       -> 产物清单与业务对接指引
# 数据为脚本内合成（无外部数据集）；训练与推理核心代码零改动。
# 使用者通常只需修改下方「参数配置区」（样本量）。
# =====================================================================
set -e
# 训练必须以 ai-psy 为工作目录、模块方式运行（rf 包内绝对导入依赖）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# ==================== 参数配置区（按需修改） ====================
# --- 运行环境 ---
CONDA_ENV="pyfeat_env"                                   # 后端同环境（CPU 即可）
CONDA_PROFILE="/root/miniconda3/etc/profile.d/conda.sh"  # AutoDL 默认 conda 初始化路径

# --- 可调参数（train_*.py 实际读取的唯一入口：环境变量样本量） ---
TEXT_SAMPLES=20000      # 文本任务合成答卷份数（RF_TEXT_SAMPLES，每因子各 TEXT_SAMPLES 行）
VIDEO_SAMPLES=30000     # 视频任务合成指标条数（RF_VIDEO_SAMPLES）

# --- 只读参数（固化于 rf/train_text.py / rf/train_video.py 源码，调整需编辑源文件） ---
#   随机森林超参：n_estimators=200, class_weight="balanced_subsample",
#                 random_state=42, n_jobs=-1（max_depth 等用 sklearn 默认）
#   质量门槛：文本每因子准确率 ≥99.5%、视频整体 ≥95%，不达标不写模型文件
#   模型输出目录：rf.settings.RF_MODEL_DIR = {AUTODL_FS}/models
#                 （服务器 /root/autodl-fs/models，本地回退项目同级 autodl-fs/models/）

# ==================== 环境校验区 ====================
# 1. conda 环境激活（已在目标环境内则跳过）
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

# 2. 核心依赖检查（缺失自动补装，保证真正一键训练）
if ! python -c "import sklearn, joblib, numpy" 2>/dev/null; then
  echo "[提示] 检测到缺少训练依赖，自动补装：scikit-learn joblib numpy"
  pip install scikit-learn joblib numpy || {
    echo "[错误] 依赖自动补装失败（多为网络问题），可先 source /etc/network_turbo 后重跑本脚本"
    exit 1
  }
fi
python -c "import sklearn, numpy; print(f'[OK] scikit-learn {sklearn.__version__} / numpy {numpy.__version__}')"

# 3. 训练脚本存在性（防误删核心代码）
for f in rf/train_text.py rf/train_video.py rf/predictor.py; do
  [ -f "$f" ] || { echo "[错误] 缺少 $f，请在 ai-psy 项目根目录下运行本脚本"; exit 1; }
done

# ==================== 训练执行区 ====================
export RF_TEXT_SAMPLES="$TEXT_SAMPLES"
export RF_VIDEO_SAMPLES="$VIDEO_SAMPLES"

echo ""
echo "===== [1/2] 训练文本模型：SCL-90 十因子严重程度（样本 ${TEXT_SAMPLES} 份/因子）====="
python -m rf.train_text

echo ""
echo "===== [2/2] 训练视频模型：主导情绪 7 类（样本 ${VIDEO_SAMPLES} 条）====="
python -m rf.train_video

# ==================== 结果输出区 ====================
MODEL_DIR=$(python -c "from rf.settings import RF_MODEL_DIR; print(RF_MODEL_DIR)")
echo ""
echo "✅ 训练完成。模型输出目录：$MODEL_DIR"
N_TEXT=$(ls -1 "$MODEL_DIR"/scl90_*.joblib 2>/dev/null | wc -l)
echo "   - 文本因子模型：${N_TEXT}/10 个 scl90_*.joblib"
if [ -f "$MODEL_DIR/emotion_rf.joblib" ]; then
  echo "   - 视频情绪模型：emotion_rf.joblib 已生成"
else
  echo "   - 视频情绪模型：未生成（准确率未达 95% 门槛，请增大 VIDEO_SAMPLES 重训）"
fi
if [ "$N_TEXT" -lt 10 ]; then
  echo "   [警告] 文本因子不足 10 个（存在未达 99.5% 门槛的因子），推理将整体回退规则判定；"
  echo "          请增大 TEXT_SAMPLES 重训至全部达标"
fi
[ -f "$MODEL_DIR/meta.json" ] && echo "   - meta.json：$(python -c "import json;print(json.load(open('$MODEL_DIR/meta.json',encoding='utf-8')).get('sklearn_version','?'))")（sklearn 版本契约）"
echo ""
echo "后续业务对接："
echo "  1. 重启 Flask 生效（模型仅进程首次调用时加载）：pkill -f run_server.py 后重新 python run_server.py"
echo "  2. 验证：提交一次 SCL-90 测评，报告中「严重程度来源」应显示 rf"
echo "更多说明见 rf/README.md（参数详解 / 质量门槛 / 常见问题）"
