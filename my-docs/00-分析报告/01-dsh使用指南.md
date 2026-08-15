# dsh 启动与使用指南(npx / CLI / ACP / JSON-RPC)

整理自仓库当前代码(基于 upstream `47f943859b`,版本 `0.1.0-rc.5`)。
来源:`README.md`、`apps/cli/README.md`、`apps/cli/reference/README.md`、`examples/README.md`、`examples/acp-agent/README.md`、`examples/jsonrpc-agent/README.md`、`docs/user/guide/python-sdk.md`。

## 1. `npx @deepseek-ai/dsh web` 会不会持久安装?

不会做全局安装。`npx` 的行为是:

- 本地没有该包时,npx 把 `@deepseek-ai/dsh` 临时下载到 npx 缓存(`~/.npm/_npx/`)并执行,不写入全局 `node_modules`,也不修改当前项目的依赖。
- 缓存会保留已下载的副本,但 npx 仍可能做版本检查;想锁定版本可用 `npx @deepseek-ai/dsh@0.1.0-rc.5 web`。

如果想持久安装,任选其一:

```sh
npm install -g @deepseek-ai/dsh     # 全局安装,之后直接用 dsh web
npm install @deepseek-ai/dsh        # 装进某个项目,再用 npx dsh web
```

当前处于 developer preview,官方明确提示会有破坏性变更,建议固定版本号。

## 2. 怎么启动 CLI

`dsh` 是 profile 启动器,发布的 npm 包即 `@deepseek-ai/dsh`(仓库内对应 `apps/cli`)。

### 凭证(所有模式都需要)

模型凭证按顺序解析:环境变量 → `$DSH_HOME/.credentials.yaml` → 当前目录 `.env` → `$DSH_HOME/.env`。最简单的方式:

```sh
export DEEPSEEK_API_KEY=sk-xxxx
# 可选,指向 OpenAI 兼容代理:
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
```

### 三种用法

```sh
# ① Web UI(dsh web 是 --profile web 的内置别名),默认 http://127.0.0.1:3080
dsh web
dsh web --port 8080
dsh web --patch ./extra.cordis.yml   # 叠加自定义配置层

# ② Headless CLI:一次性任务,打印最终回答后退出(completed 退出码 0,否则 1)
dsh --profile headless "fix the failing test in this workspace"

# ③ 插件管理(转发给 pnpm,需 PATH 上有 pnpm)
dsh plugin --profile web add <package-or-git-spec>
```

要点:

- 启动器自己的 flag 必须放在前面;第一个不被识别的参数起,全部交给 profile 应用解析(如 `--port` 属于 web 应用)。
- `web` / `headless` profile 首次使用会从内置模板自动初始化到 `$DSH_HOME/profiles/<name>`。
- 调用目录即默认 workspace 根目录;默认权限预设为 `workspace-write`(bash 和文件写限制在会话工作区内),`DSH_PERMISSION_MODE` 可改进程级回退。
- `--dump-default-config` / `--dump-config` 可在不启动的情况下查看组合后的插件树。
- CLI 暂不支持 `--host 0.0.0.0`,需要对外时用 `--trusted-host` 增加受信主机。

### 从源码启动(本仓库)

```sh
pnpm install
pnpm run build          # 生产运行必须先构建
pnpm dsh web            # 等价于 node --import tsx/esm apps/cli/src/bin.ts,转发所有参数
pnpm dsh --profile headless "run the tests"
```

## 3. 怎么使用 ACP(Agent Client Protocol)

ACP 是面向自动化客户端(父 agent、subagent provider 等)的服务器,走 stdio 上的 JSON-RPC,**不是产品 UI**。stdout 只承载协议消息,诊断日志一律走 stderr。目前 ACP 不在发布的 `dsh` CLI 里,需要从源码仓库运行。

```sh
# 需要 DEEPSEEK_API_KEY(仓库根 .env 或环境变量)
pnpm run demo:acp             # = node --import tsx packages/examples/acp-demo/src/bin.ts \
                              #   --config examples/acp-agent/cordis.yml
pnpm run demo:code-mode       # 同协议,Code Mode 工具传输
```

行为约定:

- 每次 `session/new` 创建一个全新 agent,客户端提供绝对路径 `cwd` 作为该会话的工作区;并发会话可用不同项目根。
- 会话以 JSONL 持久化。
- 权限:`DSH_PERMISSION_MODE` 选 `workspace-write`(默认)或 `danger-full-access`;模型请求越权时触发 `session/request_permission`,由客户端程序化应答 `allow_once` / `reject_once`,无人应答即失败关闭,且不持久化客户端策略。
- 可选 overlay 在 `examples/acp-agent/` 下(session-query、spill、code-mode、web-fetch 等 `*.cordis.yml`)。
- 协议方法等自动化契约见 `packages/acp/acp/README.md`。

## 4. 怎么使用 JSON-RPC

JSON-RPC 运行时面向无人值守的编程式调用,由 Python SDK 驱动;stdout 属于 SDK 协议,没有终端 UI。目标机不需要 Node.js(SDK 自带运行时)。

支持平台:Linux x64 / arm64、macOS 14+(arm64)。

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
python -m venv .venv && . .venv/bin/activate
python -m pip install deepseek-harness-sdk

export DEEPSEEK_API_KEY=sk-xxxx
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1   # 可选代理
# export DSH_MODEL=deepseek-v4-flash                   # 可选默认模型

python examples/jsonrpc-agent/minimal.py \
  --workspace /absolute/path/to/workspace \
  --session-root /absolute/path/to/sessions \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

脚本打印最终 assistant 回答,会话目录写入 JSONL 日志。

常用环境变量(`examples/jsonrpc-agent/README.md` 拥有完整表):

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` | 凭证与端点 |
| `DSH_CWD` | agent 工作区(bash / 文件系统工具) |
| `DSH_MODEL` | 默认模型(`--model` 优先) |
| `DSH_SESSION_ROOT` | JSONL 会话目录 |
| `DSH_SYSTEM_PROMPT` | 部署方提供的系统提示词 |
| `DSH_MAX_TOKENS_AS_SUCCESS` | `true`(默认)接受 token 受限结果为成功 |
| `DSH_CORDIS_CONFIG` | 自定义 cordis.yml 配置路径 |

注意:`minimal.cordis.yml` 变体给持久 bash 和编辑器配了 danger-full-access 策略,可修改运行时进程可见的任意路径,只在一次性 checkout 或容器中运行。

## 速查

| 场景 | 命令 |
|---|---|
| 浏览器 Web UI | `npx @deepseek-ai/dsh web`(临时)/ `dsh web`(已安装) |
| 一次性命令行任务 | `dsh --profile headless "<任务>"` |
| 装第三方插件 | `dsh plugin --profile web add <spec>` |
| ACP 自动化服务器 | 源码:`pnpm run demo:acp` |
| JSON-RPC / Python SDK | `pip install deepseek-harness-sdk` + `examples/jsonrpc-agent/minimal.py` |
