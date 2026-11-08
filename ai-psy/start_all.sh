#!/usr/bin/env bash
# 一键启动 / 停止「芯心向荣 AIC」全部服务（AutoDL 单机部署，不使用容器）
#
# 启动顺序：PostgreSQL → vLLM 主模型(8000) → BGE-M3(8001) → py-feat 网关(8002)
#           → Flask(API_PORT) → Next(WEB_PORT)
#
# 用法：
#   ./start_all.sh start      # 启动全部并等待健康检查（默认）
#                             # 无 GPU 时自动进入无卡模式（跳过 vLLM/BGE-M3，AI 功能禁用）；
#                             # 可用 CARDLESS=1/0 手动强制指定
#   ./start_all.sh stop       # 停止全部
#   ./start_all.sh restart    # 重启全部
#   ./start_all.sh status     # 查看各服务状态
#   ./start_all.sh init       # 建表 + 重建 RAG 索引（需先 start）
#   ./start_all.sh reset      # 清空业务数据（保留内置文章；加 --force 跳过确认）
#   ./start_all.sh db ...     # 数据库通用操作（postgres_db_tool.py，需先 start）
#     例：./start_all.sh db query "SELECT count(*) AS n FROM student"
#         ./start_all.sh db exec "UPDATE student SET phone = %s WHERE student_id = %s" 13800000000 S001
#         ./start_all.sh db demo
#
# 端口约定：6006 给前端，因为 AutoDL「自定义服务」只映射 6006；后端退到 6007。
# 全部可用同名环境变量覆盖，例如 API_PORT=6006 WEB_PORT=3000 ./start_all.sh start
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$ROOT/web"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# ---------------- 可覆盖配置 ----------------
# 与 env-deployment 下的环境脚本一致：显式指定 CONDA_ROOT，否则自动探测常见安装路径
CONDA_ROOT="${CONDA_ROOT:-}"
if [ -z "$CONDA_ROOT" ]; then
  for candidate in /root/miniconda-new /root/miniconda3; do
    if [ -f "$candidate/etc/profile.d/conda.sh" ]; then
      CONDA_ROOT="$candidate"
      break
    fi
  done
fi
if [ -z "$CONDA_ROOT" ]; then
  printf '\033[31m[ERR]\033[0m 未找到 conda，请设置 CONDA_ROOT=/path/to/miniconda\n' >&2
  exit 1
fi
API_ENV="${API_ENV:-pyfeat_env}"      # Flask 与 py-feat 网关共用
WEB_ENV="${WEB_ENV:-web_env}"         # Node / Next
GPU_ENV="${GPU_ENV:-qwen_env}"        # vLLM

API_PORT="${API_PORT:-6007}"
WEB_PORT="${WEB_PORT:-6006}"
PYFEAT_PORT="${PYFEAT_PORT:-8002}"
# 网关改为 ffmpeg 抽帧 + 逐帧检测：10 秒视频按 2fps 抽 20 帧，降采样到上限 10 帧，
# CPU 约 1.5~3.8s/帧，总计约 20~30s，稳落在 AutoDL 反向代理 60s 掐线内
PYFEAT_MAX_FRAMES="${PYFEAT_MAX_FRAMES:-10}"
LLM_PORT="${LLM_PORT:-8000}"
EMBED_PORT="${EMBED_PORT:-8001}"

LLM_MODEL="${LLM_MODEL:-/root/autodl-tmp/Qwen2.5-7B-Instruct}"
LLM_LORA_NAME="${LLM_LORA_NAME:-psych-chat}"
LLM_LORA_DIR="${LLM_LORA_DIR:-/root/autodl-tmp/qwen25-7b-lora-ai_chat}"
LLM_GPU_UTIL="${LLM_GPU_UTIL:-0.86}"
LLM_MAX_LEN="${LLM_MAX_LEN:-8192}"
EMBED_MODEL="${EMBED_MODEL:-BAAI/bge-m3}"
EMBED_GPU_UTIL="${EMBED_GPU_UTIL:-0.1}"
HF_ENDPOINT="${HF_ENDPOINT:-https://hf-mirror.com}"

# 等待上限（秒）：主模型首次加载约 30~60s，留足余量
WAIT_LLM="${WAIT_LLM:-240}"
WAIT_EMBED="${WAIT_EMBED:-180}"
WAIT_GATEWAY="${WAIT_GATEWAY:-60}"
WAIT_API="${WAIT_API:-90}"
WAIT_WEB="${WAIT_WEB:-90}"

CONDA_SH="$CONDA_ROOT/etc/profile.d/conda.sh"

# ---------------- 输出与探测 ----------------
info() { printf '\033[36m[..]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[ERR]\033[0m %s\n' "$*"; }

PY_BIN="$(command -v python3 || command -v python || echo python3)"

# 用原生 socket 探端口：镜像未装 iproute2，ss / netstat / lsof 都不可用
port_up() {
  "$PY_BIN" - "$1" <<'EOF' >/dev/null 2>&1
import socket, sys
s = socket.socket(); s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
EOF
}

wait_port() {
  local port="$1" timeout="$2" name="$3" i=0
  while [ "$i" -lt "$timeout" ]; do
    port_up "$port" && { ok "$name 已就绪（:$port）"; return 0; }
    sleep 1; i=$((i + 1))
  done
  err "$name 在 ${timeout}s 内未就绪（:$port），查看 $LOG_DIR"
  return 1
}

wait_http() {
  local url="$1" timeout="$2" name="$3" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      ok "$name 健康检查通过（$url）"; return 0
    fi
    sleep 1; i=$((i + 1))
  done
  err "$name 健康检查失败（$url），查看 $LOG_DIR"
  return 1
}

# 无卡模式探测：AutoDL 无卡开机时没有 GPU，vLLM/BGE-M3 无法启动。
# 默认自动探测 nvidia-smi；CARDLESS=1 可手动强制无卡，CARDLESS=0 强制按有卡启动。
is_cardless() {
  if [ -n "${CARDLESS:-}" ]; then
    [ "$CARDLESS" = "1" ]
    return
  fi
  if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; then
    return 1
  fi
  return 0
}

# 后台启动：$1=服务名 $2=conda 环境 $3=工作目录，其余为命令与参数
start_bg() {
  local name="$1" envname="$2" cwd="$3"; shift 3
  local logf="$LOG_DIR/$name.log"
  # bash -c 的第 1 个参数进 $0，故 $1=环境名、$2=工作目录、$3 起才是命令；
  # shift 2 后 $1 就是待执行命令，shift 3 会把命令本身丢掉
  nohup bash -c 'source "$0" && conda activate "$1" && cd "$2" && shift 2 && exec "$@"' \
    "$CONDA_SH" "$envname" "$cwd" "$@" >>"$logf" 2>&1 &
  echo $! >"$LOG_DIR/$name.pid"
}

pid_of() { cat "$LOG_DIR/$1.pid" 2>/dev/null; }

# 兜底按命令行特征清理（vLLM 会 fork engine 子进程，父进程被结束后可能残留占显存）
kill_by_cmd() {
  local pat="$1" p pid
  for p in /proc/[0-9]*; do
    pid="${p#/proc/}"
    [ "$pid" = "$$" ] && continue
    if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q -- "$pat"; then
      kill "$pid" 2>/dev/null
    fi
  done
}

# ---------------- 各服务 ----------------
start_pg() {
  if port_up 5432; then ok "PostgreSQL 已在运行（:5432）"; return 0; fi
  info "启动 PostgreSQL（容器内无 systemd，需手动拉起）"
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    pg_ctlcluster 16 main start
  else
    /usr/bin/pg_ctlcluster 16 main start
  fi
  wait_port 5432 20 "PostgreSQL"
}

start_llm() {
  if port_up "$LLM_PORT"; then ok "主模型已在运行（:$LLM_PORT）"; return 0; fi
  info "启动主模型 vLLM（:$LLM_PORT，LoRA=$LLM_LORA_NAME）"
  start_bg llm "$GPU_ENV" "$ROOT" env "HF_ENDPOINT=$HF_ENDPOINT" \
    vllm serve "$LLM_MODEL" \
    --port "$LLM_PORT" \
    --served-model-name "$(basename "$LLM_MODEL")" \
    --gpu-memory-utilization "$LLM_GPU_UTIL" \
    --max-model-len "$LLM_MAX_LEN" \
    --enable-auto-tool-choice --tool-call-parser hermes \
    --enable-lora --lora-modules "$LLM_LORA_NAME=$LLM_LORA_DIR"
  wait_http "http://127.0.0.1:$LLM_PORT/health" "$WAIT_LLM" "主模型"
}

start_embed() {
  if port_up "$EMBED_PORT"; then ok "BGE-M3 已在运行（:$EMBED_PORT）"; return 0; fi
  info "启动嵌入模型 BGE-M3（:$EMBED_PORT，与主模型独立）"
  start_bg embed "$GPU_ENV" "$ROOT" env "HF_ENDPOINT=$HF_ENDPOINT" \
    vllm serve "$EMBED_MODEL" \
    --task embed --port "$EMBED_PORT" \
    --served-model-name BGE-M3 \
    --gpu-memory-utilization "$EMBED_GPU_UTIL"
  wait_http "http://127.0.0.1:$EMBED_PORT/health" "$WAIT_EMBED" "BGE-M3"
}

start_gateway() {
  if port_up "$PYFEAT_PORT"; then ok "py-feat 网关已在运行（:$PYFEAT_PORT）"; return 0; fi
  info "启动 py-feat 视频分析网关（:$PYFEAT_PORT）"
  # py-feat 依赖 torch，OMP_NUM_THREADS 被镜像设成空值/非法值时 libgomp 会连刷警告；
  # 只对网关生效，不影响 vLLM 与 Next
  start_bg gateway "$API_ENV" "$ROOT" env "PYFEAT_PORT=$PYFEAT_PORT" \
    "PYFEAT_MAX_FRAMES=$PYFEAT_MAX_FRAMES" \
    "OMP_NUM_THREADS=${OMP_NUM_THREADS:-4}" python "$ROOT/pyfeat_gateway.py"
  wait_http "http://127.0.0.1:$PYFEAT_PORT/health" "$WAIT_GATEWAY" "py-feat 网关"
}

start_api() {
  if port_up "$API_PORT"; then ok "Flask 已在运行（:$API_PORT）"; return 0; fi
  info "启动 Flask 后端（:$API_PORT）"
  # 必须用裸 python：conda activate 之后 PATH 里的 python 才是装了 Flask 的那个
  start_bg api "$API_ENV" "$ROOT" env "PORT=$API_PORT" \
    "PYFEAT_TIMEOUT_SECONDS=${PYFEAT_TIMEOUT_SECONDS:-300}" \
    python "$ROOT/run_server.py"
  wait_http "http://127.0.0.1:$API_PORT/api/health" "$WAIT_API" "Flask 后端"
}

# BACKEND_URL 在 next build 时已固化进产物，改了端口必须重建，故用标记文件比对
start_web() {
  if port_up "$WEB_PORT"; then ok "前端已在运行（:$WEB_PORT）"; return 0; fi
  local next_bin="$WEB_DIR/node_modules/next/dist/bin/next"
  local want="http://127.0.0.1:$API_PORT"
  local mark="$WEB_DIR/.next/backend_url"

  if [ ! -d "$WEB_DIR/node_modules" ]; then
    err "缺少 $WEB_DIR/node_modules，请先执行：cd $WEB_DIR && npm install"
    return 1
  fi
  if [ ! -f "$next_bin" ]; then
    err "缺少 $next_bin，请先执行：cd $WEB_DIR && npm install"
    return 1
  fi

  if [ ! -f "$WEB_DIR/.next/BUILD_ID" ] || [ "$(cat "$mark" 2>/dev/null)" != "$want" ]; then
    info "构建前端（BACKEND_URL=$want）"
    # 直接调 node 执行，绕开 Windows 上传后 .bin/next 可执行位丢失的问题；
    # build 必须在 web_env 内运行，否则 node 不在 PATH；
    # max-old-space-size 限制 Node 堆上限（3G），配合 next.config 的 cpus:1
    # 避免 AutoDL 实例内存不足被 OOM Killer 杀掉构建进程
    ( source "$CONDA_SH" && conda activate "$WEB_ENV" && cd "$WEB_DIR" \
      && BACKEND_URL="$want" NODE_OPTIONS="--max-old-space-size=3072" node "$next_bin" build ) \
      || { err "前端构建失败，查看上方输出"; return 1; }
    printf '%s' "$want" >"$mark"
  fi

  info "启动前端 Next（:$WEB_PORT）"
  start_bg web "$WEB_ENV" "$WEB_DIR" env "BACKEND_URL=$want" \
    node "node_modules/next/dist/bin/next" start -p "$WEB_PORT"
  wait_port "$WEB_PORT" "$WAIT_WEB" "前端 Next"
}

# ---------------- 子命令 ----------------
do_start() {
  info "项目根目录：$ROOT / 日志：$LOG_DIR"
  start_pg    || warn "PostgreSQL 未就绪，后续读写数据库会失败"
  if is_cardless; then
    warn "未检测到 GPU：以无卡模式启动（跳过 vLLM/BGE-M3，AI 生成功能不可用；py-feat 网关走 CPU 保留人脸客观指标）"
    # Flask 据 AI_ENABLED=0 对 AI 接口返回统一提示；手动设 AI_ENABLED=1 可强制放行（如切远程 API）
    export AI_ENABLED="${AI_ENABLED:-0}"
  else
    start_llm
    start_embed
  fi
  start_gateway
  start_api
  start_web
  echo
  do_status
  echo
  ok "全部服务已处理完毕。AutoDL「自定义服务」入口固定 6006，浏览器应直接看到前端页面。"
  echo "   日志：tail -f $LOG_DIR/*.log"
  echo "   改库：./start_all.sh db query \"SELECT ...\" ｜ ./start_all.sh db exec \"UPDATE ...\""
}

do_stop() {
  local name pid
  for name in web api gateway embed llm; do
    pid="$(pid_of "$name")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      ok "已停止 $name（PID $pid）"
    fi
    rm -f "$LOG_DIR/$name.pid"
  done
  # vLLM / Next 的子进程常不随父进程退出，按特征再清一遍
  kill_by_cmd "vllm"
  kill_by_cmd "next-server"
  kill_by_cmd "run_server.py"
  kill_by_cmd "pyfeat_gateway.py"
  ok "服务已全部停止（PostgreSQL 保持运行，便于下次直接 start）"
}

do_status() {
  local name port pid state
  printf '%-10s %-8s %-8s %s\n' "服务" "端口" "PID" "状态"
  for name in llm:$LLM_PORT embed:$EMBED_PORT gateway:$PYFEAT_PORT api:$API_PORT web:$WEB_PORT; do
    port="${name#*:}"; name="${name%%:*}"
    pid="$(pid_of "$name")"; [ -n "$pid" ] || pid="-"
    if port_up "$port"; then state="监听中"; else state="未监听"; fi
    printf '%-10s %-8s %-8s %s\n' "$name" "$port" "$pid" "$state"
  done
  if port_up 5432; then printf '%-10s %-8s %-8s %s\n' "postgres" "5432" "-" "监听中"
  else printf '%-10s %-8s %-8s %s\n' "postgres" "5432" "-" "未监听"; fi
}

do_init() {
  info "初始化数据库表"
  bash -c 'source "$0" && conda activate "$1" && cd "$2" && exec python -m flask --app run_server init-db' \
    "$CONDA_SH" "$API_ENV" "$ROOT"
  info "重建 RAG 索引（需主模型与 BGE-M3 已启动）"
  bash -c 'source "$0" && conda activate "$1" && cd "$2" && exec python -m flask --app run_server reindex-rag' \
    "$CONDA_SH" "$API_ENV" "$ROOT"
}

do_db() {
  # 数据库通用操作（postgres_db_tool.py）：psycopg 装在 API_ENV，与 Flask 后端同环境；
  # 参数原样透传给工具的 CLI（demo / query / exec）
  bash -c 'source "$0" && conda activate "$1" && cd "$2" && shift 2 && exec python postgres_db_tool.py "$@"' \
    "$CONDA_SH" "$API_ENV" "$ROOT" "$@"
}

do_reset() {
  # 清空业务数据（reset_data.py）：与后端共用 API_ENV，避免系统 python 缺少依赖
  bash -c 'source "$0" && conda activate "$1" && cd "$2" && shift 2 && exec python reset_data.py "$@"' \
    "$CONDA_SH" "$API_ENV" "$ROOT" "$@"
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; do_start ;;
  status)  do_status ;;
  init)    do_init ;;
  reset)   shift; do_reset "$@" ;;
  db)      shift; do_db "$@" ;;
  *) echo "用法：$0 [start|stop|restart|status|init|reset|db]"; exit 1 ;;
esac
