#!/usr/bin/env bash
# 从源码启动 deepseek-harness 开发环境(Web UI,默认 http://127.0.0.1:3080)
# 用法:my-scripts/start-dev.sh [--rebuild] [透传给 dsh 的参数...]
#
# 代码生效机制:
# - 后端/插件 TS 源码(packages/、vendor/):tsx 按 tsconfig paths 直接运行 src,重启即生效,无需编译
# - 浏览器前端(apps/web):dsh web 服务的是构建产物 dist/,前端改动必须重新 vite build
# - 客户端插件 bundle(packages/*/*/lib/client.js):同为构建产物,改动后需 build:lib:client 重建
#
# 本脚本自动处理:产物缺失做全量构建;前端源码比产物新则重建前端;--rebuild 强制全量构建。
set -euo pipefail
cd "$(dirname "$0")/.."

REBUILD=0
if [ "${1:-}" = "--rebuild" ]; then
  REBUILD=1
  shift
fi

if [ ! -d node_modules ]; then
  echo ">> 首次运行,执行 pnpm install"
  pnpm install
fi

if [ -z "${DEEPSEEK_API_KEY:-}" ] && [ ! -f .env ]; then
  echo "!! 未检测到 DEEPSEEK_API_KEY,也无根目录 .env;请在 .env 中配置 DEEPSEEK_API_KEY 后再启动" >&2
  exit 1
fi

# 前端源码(含 public/、vite 配置)比 dist 产物新时需要重建
web_stale() {
  [ ! -f apps/web/dist/index.html ] && return 0
  [ -n "$(find apps/web/src apps/web/public apps/web/index.html apps/web/vite.config.ts -newer apps/web/dist/index.html -print -quit 2>/dev/null)" ]
}

if [ "$REBUILD" = 1 ]; then
  echo ">> --rebuild:全量构建(后端 lib + 客户端 bundle + 前端 dist)"
  pnpm run build
elif [ ! -f apps/web/dist/index.html ]; then
  echo ">> 前端产物缺失,执行全量构建(仅首次需要)"
  pnpm run build
elif web_stale; then
  echo ">> 检测到前端源码变动,重建 apps/web/dist"
  pnpm --filter @deepseek-ai/dsh-web-frontend run build
fi

exec pnpm dsh web "$@"
