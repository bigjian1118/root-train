#!/usr/bin/env bash
# 无卡模式专用测试脚本：跳过所有 GPU/AI 服务（vLLM 主模型、BGE-M3 嵌入）的启动与健康检查，
# 只拉起 PostgreSQL + Flask（AI_ENABLED=0）+ 可选 py-feat 网关/前端，
# 然后自动跑一轮接口冒烟测试：验证非 AI 功能可用、AI 生成接口统一返回无卡提示。
#
# 用法：
#   ./test_cardless.sh            # 启动缺失服务 + 跑冒烟测试
#   ./test_cardless.sh --web      # 同时构建并启动 Next 前端
#   ./test_cardless.sh --no-gateway  # 连 py-feat 网关也跳过（纯测非 AI 功能）
#   ./test_cardless.sh --stop     # 停止本脚本拉起的服务
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# ---------------- 可覆盖配置（与 start_all.sh 保持一致的默认值） ----------------
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
CONDA_SH="$CONDA_ROOT/etc/profile.d/conda.sh"

API_ENV="${API_ENV:-pyfeat_env}"
WEB_ENV="${WEB_ENV:-web_env}"
API_PORT="${API_PORT:-6007}"
WEB_PORT="${WEB_PORT:-6006}"
PYFEAT_PORT="${PYFEAT_PORT:-8002}"
PYFEAT_MAX_FRAMES="${PYFEAT_MAX_FRAMES:-10}"

# 无卡模式核心开关：Flask 据此对所有 AI 生成接口返回 503 统一提示
export AI_ENABLED=0
export CARDLESS=1

WITH_WEB=0
WITH_GATEWAY=1
MODE="test"
for arg in "$@"; do
  case "$arg" in
    --web)        WITH_WEB=1 ;;
    --no-gateway) WITH_GATEWAY=0 ;;
    --stop)       MODE="stop" ;;
  esac
done

# ---------------- 输出与探测 ----------------
info() { printf '\033[36m[..]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[ERR]\033[0m %s\n' "$*"; }

PY_BIN="$(command -v python3 || command -v python || echo python3)"

port_up() {
  "$PY_BIN" - "$1" <<'EOF' >/dev/null 2>&1
import socket, sys
s = socket.socket(); s.settimeout(0.5)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
EOF
}

wait_http() {
  local url="$1" timeout="$2" name="$3" i=0
  while [ "$i" -lt "$timeout" ]; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      ok "$name 已就绪（$url）"; return 0
    fi
    sleep 1; i=$((i + 1))
  done
  err "$name 在 ${timeout}s 内未就绪（$url），查看 $LOG_DIR"
  return 1
}

start_bg() {
  local name="$1" envname="$2" cwd="$3"; shift 3
  local logf="$LOG_DIR/$name.log"
  nohup bash -c 'source "$0" && conda activate "$1" && cd "$2" && shift 2 && exec "$@"' \
    "$CONDA_SH" "$envname" "$cwd" "$@" >>"$logf" 2>&1 &
  echo $! >"$LOG_DIR/cardless-$name.pid"
}

stop_one() {
  local name="$1" pid
  pid="$(cat "$LOG_DIR/cardless-$name.pid" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null
    ok "已停止 $name（PID $pid）"
  fi
  rm -f "$LOG_DIR/cardless-$name.pid"
}

# ---------------- 服务启动 ----------------
start_pg() {
  if port_up 5432; then ok "PostgreSQL 已在运行（:5432）"; return 0; fi
  info "启动 PostgreSQL"
  pg_ctlcluster 16 main start || /usr/bin/pg_ctlcluster 16 main start
  sleep 2
  port_up 5432 && ok "PostgreSQL 已就绪" || { err "PostgreSQL 启动失败"; return 1; }
}

start_gateway() {
  if port_up "$PYFEAT_PORT"; then ok "py-feat 网关已在运行（:$PYFEAT_PORT，CPU 模式）"; return 0; fi
  info "启动 py-feat 网关（CPU，保留人脸客观指标；--no-gateway 可跳过）"
  start_bg gateway "$API_ENV" "$ROOT" env "PYFEAT_PORT=$PYFEAT_PORT" \
    "PYFEAT_MAX_FRAMES=$PYFEAT_MAX_FRAMES" "OMP_NUM_THREADS=${OMP_NUM_THREADS:-4}" \
    python "$ROOT/pyfeat_gateway.py"
  wait_http "http://127.0.0.1:$PYFEAT_PORT/health" 60 "py-feat 网关" || return 1
}

start_api() {
  if port_up "$API_PORT"; then
    warn "Flask 已在运行（:$API_PORT）——注意：若它是带 GPU 模式启动的，AI 接口不会返回无卡提示；"
    warn "如需严格无卡测试，请先 ./test_cardless.sh --stop 或 bash start_all.sh stop 再重跑"
    return 0
  fi
  info "启动 Flask 后端（:$API_PORT，AI_ENABLED=0）"
  start_bg api "$API_ENV" "$ROOT" env "PORT=$API_PORT" "AI_ENABLED=0" \
    "PYFEAT_TIMEOUT_SECONDS=${PYFEAT_TIMEOUT_SECONDS:-300}" \
    python "$ROOT/run_server.py"
  wait_http "http://127.0.0.1:$API_PORT/api/health" 90 "Flask 后端" || return 1
}

start_web() {
  [ "$WITH_WEB" = "1" ] || return 0
  if port_up "$WEB_PORT"; then ok "前端已在运行（:$WEB_PORT）"; return 0; fi
  local next_bin="$ROOT/web/node_modules/next/dist/bin/next"
  local want="http://127.0.0.1:$API_PORT"
  local mark="$ROOT/web/.next/backend_url"
  if [ ! -f "$ROOT/web/.next/BUILD_ID" ] || [ "$(cat "$mark" 2>/dev/null)" != "$want" ]; then
    info "构建前端（BACKEND_URL=$want，单 worker 低内存模式）"
    ( source "$CONDA_SH" && conda activate "$WEB_ENV" && cd "$ROOT/web" \
      && BACKEND_URL="$want" NODE_OPTIONS="--max-old-space-size=3072" node "$next_bin" build ) \
      || { err "前端构建失败"; return 1; }
    printf '%s' "$want" >"$mark"
  fi
  info "启动前端 Next（:$WEB_PORT）"
  start_bg web "$WEB_ENV" "$ROOT/web" env "BACKEND_URL=$want" \
    node "node_modules/next/dist/bin/next" start -p "$WEB_PORT"
  wait_http "http://127.0.0.1:$WEB_PORT" 90 "前端 Next" || return 1
}

# ---------------- 冒烟测试 ----------------
PASS=0
FAIL=0

# expect_status <期望HTTP码> <说明> <curl 参数...>
expect_status() {
  local want="$1" desc="$2"; shift 2
  local got
  got="$(curl -s -o /tmp/cardless_body.$$ -w '%{http_code}' --max-time 10 "$@" 2>/dev/null)"
  if [ "$got" = "$want" ]; then
    ok "PASS  $desc（HTTP $got）"
    PASS=$((PASS + 1))
  else
    err "FAIL  $desc（期望 $want，实际 $got）body=$(head -c 200 /tmp/cardless_body.$$ 2>/dev/null)"
    FAIL=$((FAIL + 1))
  fi
  rm -f /tmp/cardless_body.$$
}

# expect_body_has <期望包含的子串> <说明> <curl 参数...>
expect_body_has() {
  local want="$1" desc="$2"; shift 2
  local body
  body="$(curl -s --max-time 10 "$@" 2>/dev/null)"
  if printf '%s' "$body" | grep -q -- "$want"; then
    ok "PASS  $desc"
    PASS=$((PASS + 1))
  else
    err "FAIL  $desc（响应体未包含「$want」：$(printf '%s' "$body" | head -c 200)）"
    FAIL=$((FAIL + 1))
  fi
}

run_tests() {
  local base="http://127.0.0.1:$API_PORT"
  echo
  info "开始无卡模式冒烟测试（$base）"

  # ---- 基础可用性 ----
  expect_status 200 "健康检查 /api/health" "$base/api/health"
  expect_body_has '"ai_enabled": false\|"ai_enabled":false' "/api/config 下发 ai_enabled=false" "$base/api/config"

  # ---- 非 AI 功能：未登录应走原有 401/403 逻辑（而不是被 AI 守卫拦截） ----
  expect_status 401 "文章列表鉴权行为不变（未登录 401）" "$base/api/articles"
  expect_status 401 "预约时段鉴权行为不变（未登录 401）" "$base/api/student/appointment/slots"

  # ---- AI 生成接口：应统一返回 503 无卡提示 ----
  expect_status 503 "AI 对话 GET /api/chat/stream 返回 503" "$base/api/chat/stream?content=test"
  expect_status 503 "AI 对话 POST /api/chat 返回 503" -X POST -H 'Content-Type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}' "$base/api/chat"
  expect_status 503 "综合分析 POST /api/ai/analysis 返回 503" -X POST -H 'Content-Type: application/json' -d '{}' "$base/api/ai/analysis"
  expect_status 503 "干预建议 POST /api/ai/intervention 返回 503" -X POST -H 'Content-Type: application/json' -d '{}' "$base/api/ai/intervention"
  expect_status 503 "素材召回 GET recall-preview 返回 503" "$base/api/teacher/materials/ai/recall-preview?keywords=test"
  expect_status 503 "素材生成 POST generate 返回 503" -X POST -H 'Content-Type: application/json' -d '{}' "$base/api/teacher/materials/ai/generate"

  # 503 响应体应带统一文案与标记
  expect_body_has '无卡模式' "503 响应含「当前为无卡模式」文案" "$base/api/chat/stream?content=test"
  expect_body_has '"ai_disabled": true\|"ai_disabled":true' "503 响应含 ai_disabled 标记" "$base/api/chat/stream?content=test"

  echo
  if [ "$FAIL" -eq 0 ]; then
    ok "冒烟测试全部通过：$PASS 项 PASS / $FAIL 项 FAIL"
  else
    err "冒烟测试未全过：$PASS 项 PASS / $FAIL 项 FAIL，请检查上方 FAIL 项"
  fi
  [ "$WITH_WEB" = "1" ] && echo "   前端入口：http://127.0.0.1:$WEB_PORT（浏览器打开即可逐页核对）"
}

# ---------------- 主流程 ----------------
if [ "$MODE" = "stop" ]; then
  stop_one web
  stop_one api
  [ "$WITH_GATEWAY" = "1" ] && stop_one gateway
  ok "无卡测试服务已停止（PostgreSQL 保持运行）"
  exit 0
fi

info "无卡模式：跳过 vLLM(:8000) 与 BGE-M3(:8001) 的启动与健康检查"
start_pg    || exit 1
[ "$WITH_GATEWAY" = "1" ] && { start_gateway || warn "py-feat 网关未就绪，人脸指标功能测试会失败"; }
start_api   || exit 1
start_web   || exit 1
run_tests
