#!/usr/bin/env bash
# 全库逻辑备份：业务表 + pgvector 向量一并导出（直连本机 PostgreSQL，无容器依赖）
# 用法：在 ai-psy/deploy 目录执行 ./backup.sh [输出目录]
# 连接参数可用环境变量覆盖：DB_NAME / DB_USER / DB_HOST / DB_PORT / PGPASSWORD
set -euo pipefail

OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
TARGET="$OUT_DIR/psy_${STAMP}.dump"

DB_NAME="${DB_NAME:-psy}"
DB_USER="${DB_USER:-psy}"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"

PGPASSWORD="${PGPASSWORD:-psy}" pg_dump \
  -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -Fc > "$TARGET"

echo "[OK] 已导出全库（含 rag_chunk 向量表）: $TARGET"
echo "恢复命令: PGPASSWORD=${PGPASSWORD:-psy} pg_restore -h ${DB_HOST} -p ${DB_PORT} -U ${DB_USER} -d ${DB_NAME} --clean --if-exists < $TARGET"
