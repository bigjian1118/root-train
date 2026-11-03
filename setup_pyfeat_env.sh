#!/usr/bin/env bash
# =====================================================================
# pyfeat_env（Flask 后端 + 视频分析环境）一键配置脚本
# 内容：创建 conda 环境 + 安装 py-feat/CPU torch/Web 依赖 + ffmpeg
#       + py-feat 离线权重预置 + 业务初始化(建库/题库/随机森林)
# 用法：bash setup_pyfeat_env.sh [all|env|feat|init]     # 默认 all
#   env    仅创建 pyfeat_env 并装依赖(含 requirements.txt 与 ffmpeg)
#   feat   仅预置 py-feat 离线权重到 site-packages/feat/resources
#   init   仅建库 + 生成题库 + 训练随机森林
# 幂等：环境已存在/依赖已装/权重已就位/RF 模型已存在时自动跳过；重复运行安全。
# 可覆盖环境变量：CONDA_BASE / PROJ / PIP_MIRROR
# 推理环境(qwen_env)请用 setup_qwen_env.sh；启动/验证见 ai-psy/start_all.sh 与部署手册第 5/6 步。
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
PIP_MIRROR="${PIP_MIRROR:-}"          # 留空用默认源；可设 https://mirrors.aliyun.com/pypi/simple/
STEP="${1:-all}"

pip_flag=()
[ -n "$PIP_MIRROR" ] && pip_flag=(-i "$PIP_MIRROR")

log()  { echo -e "\n\033[1;36m[$(date +%H:%M:%S)] $*\033[0m"; }
fail() { echo -e "\033[1;31m[错误] $*\033[0m" >&2; exit 1; }

source "$CONDA_BASE/etc/profile.d/conda.sh"
[ -d "$PROJ" ] || fail "未找到项目目录 $PROJ，请先按手册第 1 步上传 ai-psy/"

# ---------- env：创建 pyfeat_env 并装后端/视频分析依赖 ----------
do_env() {
  if conda env list | grep -q "^pyfeat_env "; then
    log "pyfeat_env 已存在，跳过创建(依赖补装)"
  else
    log "创建 pyfeat_env (python 3.11)"
    conda create -n pyfeat_env python=3.11 -y
  fi
  conda activate pyfeat_env
  if ! python -c "import feat" 2>/dev/null; then
    log "安装 pyfeat_env 依赖 (CPU torch + pyfeat 0.6.1)"
    pip install "${pip_flag[@]}" "torch==2.4.1" "torchvision==0.19.1" --index-url https://download.pytorch.org/whl/cpu
    pip install "${pip_flag[@]}" "py-feat==0.6.1" "scipy==1.10.1" flask scikit-learn joblib
    python -c "import feat; print('py-feat导入成功')"
  else
    log "py-feat 已安装，跳过"
  fi
  log "补装 Web 层依赖 requirements.txt"
  ( cd "$PROJ" && pip install "${pip_flag[@]}" -r requirements.txt )
  conda deactivate

  if ! command -v ffmpeg >/dev/null 2>&1; then
    log "安装 ffmpeg"
    apt update && apt install -y ffmpeg
  else
    log "ffmpeg 已存在，跳过"
  fi
  log "pyfeat_env 环境配置完成"
}

# ---------- feat：预置 py-feat 离线权重（GitHub Releases，需学术加速） ----------
do_feat() {
  conda activate pyfeat_env
  RES="$(python -c 'import feat; print(feat.__path__[0])')/resources"
  mkdir -p "$RES"
  if [ -f "$RES/mobilenet0.25_Final.pth" ] && [ -f "$RES/July4_AU43_XGB.ubj" ] && [ -f "$RES/ResMaskNet_Z_resmasking_dropout1_rot30.pth" ] && [ -f "$RES/all_data_Fullpca_June30.pkl" ]; then
    log "py-feat 权重已就位：$RES，跳过"
    conda deactivate
    return
  fi
  GH_F="https://github.com/cosanlab/feat/releases/download/v0.1"
  GH_P="https://github.com/cosanlab/py-feat/releases/download/v0.1"
  files=("$GH_F/mobilenet0.25_Final.pth" "$GH_F/mobilefacenet_model_best.pth.tar"
         "$GH_F/ResMaskNet_Z_resmasking_dropout1_rot30.pth" "$GH_P/ResMaskNet_fer2013_config.json")
  for au in 1 2 4 5 6 7 9 10 11 12 14 15 17 20 23 24 25 26 28 43; do
    files+=("$GH_P/July4_AU${au}_XGB.ubj")
  done
  # XGB AU 检测器初始化必需的标量/PCA 校准数据（缺失会报 No such file or directory）
  for d in Upperscalar Upperpca Lowerscalar Lowerpca Fullscalar Fullpca; do
    files+=("$GH_P/all_data_${d}_June30.pkl")
  done
  log "下载 py-feat 权重 ${#files[@]} 个到 $RES（GitHub 直连失败请先 source /etc/network_turbo）"
  for u in "${files[@]}"; do
    f="$RES/$(basename "$u")"
    [ -s "$f" ] || wget -q -O "$f" "$u" || fail "权重下载失败：$u（执行 source /etc/network_turbo 后重跑本阶段）"
  done
  conda deactivate
  log "feat 阶段完成：权重已离线预置，Detector 不再联网"
}

# ---------- init：建库 + 题库 + 随机森林 ----------
do_init() {
  conda activate pyfeat_env
  log "初始化数据库(幂等)"
  ( cd "$PROJ" && python create_db.py )
  log "生成题库与 ai_chat 数据集"
  ( cd "$PROJ/Qwen-train" && python prepare_dataset.py )
  if [ -f /root/autodl-fs/models/meta.json ] || [ -f "$PROJ/../autodl-fs/models/meta.json" ]; then
    log "随机森林模型已存在，跳过训练(如需重训请先删除 models 目录)"
  else
    log "训练随机森林(文本十因子 + 视频情绪，CPU 数分钟)"
    ( cd "$PROJ" && python -m rf.train_text && python -m rf.train_video )
  fi
  conda deactivate
  log "init 阶段完成"
}

case "$STEP" in
  env)   do_env ;;
  feat)  do_feat ;;
  init)  do_init ;;
  all)   do_env; do_feat; do_init ;;
  *)     fail "未知阶段：$STEP（可用：all|env|feat|init）" ;;
esac
