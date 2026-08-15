#!/usr/bin/env bash
# 从源码启动 deepseek-harness 开发环境(Web UI,默认 http://127.0.0.1:3080)
# 用法:my-scripts/start-dev.sh [透传给 dsh 的参数...]
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -d node_modules ]; then
  echo ">> 首次运行,执行 pnpm install"
  pnpm install
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ ! -f .env ]; then
  echo "!! 未检测到 DEEPSEEK_API_KEY,也无根目录 .env;请在 .env 中配置 DEEPSEEK_API_KEY 后再启动" >&2
  exit 1
fi

exec pnpm dsh web "$@"
