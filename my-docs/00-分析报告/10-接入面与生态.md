# 接入面与生态：CLI、Web、ACP、SDK 与多代理

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

本文盘点 dsh 的全部接入面与多代理生态，回答「同一个 harness 核心如何服务不同形态的用户」。

## 接入面总览

| 接入面 | 位置 | 目标用户 | 形态 |
|---|---|---|---|
| `dsh` CLI | `apps/cli`（`@deepseek-ai/dsh`） | 终端用户/部署者 | profile 启动器：`--profile <name>`、`web`、`plugin` |
| Web UI | `apps/web` + `packages/bundle/web-app` | 交互式人类用户 | Vite 前端壳 + host webserver |
| ACP server | `packages/acp/acp` | 程序化客户端（Zed 等编辑器、subagent-acp） | Agent Client Protocol over JSON-RPC stdio |
| JSON-RPC SDK | `packages/sdk` | 从其他进程驱动 harness 的开发者 | protocol/server/TS client 三层 |
| Python SDK | `python/sdk` | Python 用户 | 同一 JSON-RPC 协议 + 预编译单文件运行时 wheel |
| headless | `packages/bundle/headless` | 自动化/CI | `dsh --profile headless "job"` 一次性运行 |

三个观察：

1. **headless 不是特殊模式，就是一个普通 bundle**：在 `dsh-base` 上叠一个 patch，插入 `headless-runner` 插件——读位置参数当 user message、等 quiescence、把最后一条 assistant 文本写 stdout、按完成状态定 exit code。不监听任何端口。「无服务器的一次性 runner」与「完整 Web 产品」共享全部核心，只差组合层。
2. **ACP server 刻意 automation-only**：不暴露编辑器导航、transcript replay、modes、elicitation 等 UI 能力——「交互渲染和人类提问属于 Web host」。传输层与呈现层的职责切分非常克制。
3. **SDK 的 wire 协议直接流 session-log envelope**：「the session vocabulary is part of the wire contract」（`packages/sdk/protocol`）——日志词汇即协议词汇，SDK 消费者与内部消费者看到同一份事实。Python SDK 镜像协议但不 import TS 类型，pip 安装自带预编译运行时，无需 Node 环境参数。

CLI 自身的参数设计也有讲究：launcher 只解析自己的 flag，第一个不认识的 token 起全部交给被启动 profile 的 app 插件（`dsh-cmdline` 共享不可变快照）——`dsh --profile web --port 8080` 的 `--port` 属于 web app 而非 launcher，职责边界清晰。

## Subagent：统一抽象下的多世界

`packages/subagent` 是标准能力接缝，provider 家族（可多个共存、按名注册）：

| Provider | 子代理是什么 |
|---|---|
| `spawn-in-process` | 进程内全新 child |
| `fork-in-process` | 从父已完成历史 fork 的进程内 child |
| `subagent-acp` | 任意 ACP server（进程外） |
| `subagent-codex` | 真实 Codex app-server child |
| `subagent-claude-code` | 经官方 Claude Agent SDK 的真实 Claude Code child |
| `subagent-dsh-sdk` | 经 TS SDK 的另一个 Harness 进程 |

Consumer 是三个模型可见工具：`tool-subagent`（delegation）、`tool-subagent-control`（child 消息与列举）、`tool-subagent-report`（child→parent 报告通道）。

工程诚实的两个细节：ACP provider 显式声明 `inheritsParentContext: false` 且不 advertise 无法兑现的能力（本地服务**拒绝**要求深度限制/工具过滤/persona 的请求，而非静默省略）；子进程销毁走 EOF grace → SIGTERM → SIGKILL 阶梯。父模型只收到 child 最终文本，child 的 token 不进父上下文。

## 自主循环的两种正交模式

- **goal**（`packages/goal`）：同会话持久目标。`ctx.goals` 状态属 session log（`active/paused/blocked/complete` 相位带 revision），`goal-round-driver` 在同会话顺序续跑 goal rounds，`tool-goal` 给模型、`command-goal`（`/goal`）给人。goal activation 是 process-local 的（刻意不进 durable replay）——resume/fork 后必须经人授权的 resume 才能自动续跑；
- **Ralph**（`packages/workflow/tool-ralph`）：Geoffrey Huntley 式 fresh-agent 循环。每 round 起一个**无对话种子**的全新 child，跨轮状态 = 共享 workspace + 一份有界结构化 handoff（status/summary/evidence/next steps/blocker）。它是「由 workflow 和 subagent 原语组合出的模型可见工具策略」，`agent-loop` 里没有一行 Ralph 代码。

两者正交：goal 是同会话延续，Ralph 是 fresh-child 循环。都是插件，不是框架模式——这是「Plugins, not loop changes」纪律的最佳示范。

## 其余生态件

- **workflow**（`packages/workflow`）：`ctx.workflowEngine` + worker-thread provider（隔离宿主事件循环，但明确声明「not a security boundary」）；
- **jobs**（`packages/jobs`）：后台作业注册表 + `job_*` 工具，长时工具统一的观察/取消/等待协议，owner-fenced；
- **guard**（`packages/guard`）：循环卫生——重复工具调用的 advisory reminder（经 `tools/post-execute` 注入并落成 logged user message）、per-call 超时策略；
- **self-modification**（`packages/extensions/`）：agent 检视/定义/挂载/卸载自己运行时的插件（host 半 `node:vm` 沙箱 + 浏览器半的 dual-half 结构），`pnpm run demo:cordis` 可演示；
- **hooks 桥**（`packages/hooks/`）：Claude Code / Codex 的 hooks.json 直接映射到 harness 拦截点（详见插件系统文档场景 D）；
- **settings / credentials / identity**：横切部署能力——用户可编辑配置的热分层、凭证引用与秘密分离、匿名遥测关联 id；
- **MCP**：`dsh-mcp-client` 使「一个 MCP server = 一个插件行」（`examples/mcp-memory/` 三个参考配置），默认不启用任何 MCP server——每个 server 命令都是 agent 沙箱外的可信可执行代码，这是刻意的默认姿态。

## 评价

接入面的设计一致性很高：每种形态都是「同一核心 + 不同组合层」，没有为某个形态开后门的特权路径（ACP 不碰 UI 能力、headless 不开端口、SDK 直接用日志词汇）。多代理生态是最大惊喜：把竞品（Codex、Claude Code）封装成子代理 provider，既务实（用户已有工具可复用）又自信（竞争发生在能力层而非锁定层）。风险同样明显：这么多接入面共享一个 pre-release 核心，核心的任何 breakage 都全网传导——`SESSION_FORMAT_VERSION=0` 的「无兼容承诺」立场说明团队清楚这一点，并选择了速度优先。
