# DeepSeek Harness (dsh) SDK 详尽说明书

> 分析日期：2026-08-17（基于 wkj-dev 分支，upstream/master = 47f943859b）
> 分析范围：`packages/sdk/`（protocol / client / server）、`python/sdk/`、`python/sdk-runtime/`、`examples/jsonrpc-agent/`

---

## 1. SDK 定位与总体架构

### 1.1 SDK 是什么

dsh SDK 是**从另一个进程驱动 Harness 运行时（runtime）的协议栈**。它的设计边界非常明确：

- 调用方（SDK 用户）负责提供运行时可执行文件及其 `cordis.yml` 组合配置；
- SDK **不创建、不配置、不构建、不启动**开发者项目（早期曾有项目工具链，已于 2026-08-11 移除，见 Agent Note `2026-08-11-remove-sdk-project-toolchain`）；
- 运行时本身是一个**完整的 harness 进程**，其能力（工具、持久化、人格等）完全由它自己的 `cordis.yml` 决定。

### 1.2 组件拓扑

```
┌─────────────────────────────────────────┐       stdio（换行分隔 JSON-RPC 2.0）        ┌──────────────────────────────────────────┐
│            调用方进程（SDK 侧）              │  stdin ──────── 请求帧 ───────────────▶  │           Harness 运行时子进程                │
│                                         │                                            │                                          │
│  TypeScript:                            │  stdout ◀────── 响应帧 + 通知帧 ───────────  │  dsh-jsonrpc-agent bin                   │
│   ├─ DeepSeekHarness（高层 owned-run API） │                                            │   └─ cordis.yml 组合：                     │
│   └─ HarnessClient（底层协议客户端）        │  stderr ◀────── 诊断日志（不参与协议） ──────  │       ├─ @deepseek-ai/dsh-sdk-jsonrpc-server │
│                                         │                                            │       ├─ @deepseek-ai/dsh-llm-deepseek     │
│  Python:                                │                                            │       ├─ bash / fs / subagent / todo 工具    │
│   ├─ DeepSeekHarness（高层 turns API）     │                                            │       ├─ JSONL 会话持久化 + checkpoint 策略   │
│   └─ HarnessClient（底层同步客户端）        │                                            │       └─ compaction-basic                  │
└─────────────────────────────────────────┘                                            └──────────────────────────────────────────┘
```

### 1.3 包清单与职责

| 包 | dist / 模块名 | 职责 |
|---|---|---|
| `packages/sdk/protocol/` | `@deepseek-ai/dsh-sdk-protocol` | 定义 SDK 运行时线缆协议：JSON-RPC 传输类 + 全部具名请求/结果/通知类型 |
| `packages/sdk/client/` | `@deepseek-ai/dsh-sdk-client` | TypeScript 客户端：spawn 子进程并通过 stdio JSON-RPC 驱动运行时 |
| `packages/sdk/server/` | `@deepseek-ai/dsh-sdk-jsonrpc-server` | 服务端插件（Cordis plugin）：在运行时内通过 stdio JSON-RPC 对外服务 |
| `python/sdk/` | `deepseek-harness-sdk` / `deepseek_harness` | Python 客户端：高层 turns API + 底层 JSON-RPC 客户端 |
| `python/sdk-runtime/` | `deepseek-harness-runtime-bin` / `deepseek_harness_runtime` | 运行时载体：打包的 `dsh-jsonrpc-agent` 可执行文件 + 默认 cordis.yml |
| `examples/jsonrpc-agent/` | （示例，不发布） | 无人值守 coding-agent 组合：完整独立 cordis.yml + minimal 变体 + `minimal.py` |

关键事实：

- **纯库原则**：`protocol` 与 `client` 都是纯库 —— 不注册任何 Cordis 插件、无 Config、无注册动作；只有 `server` 是 Cordis 插件。
- **设计孪生**：TypeScript 客户端与 Python SDK 是"设计孪生"（design twin），驱动同一套运行时协议、同样的分层（高层 `DeepSeekHarness` + 底层 `HarnessClient`），但**不共享代码**（Python 镜像类型而不调用 TS 类型）。
- **stdout 即协议**：运行时进程的 stdout 只允许出现 JSON-RPC 帧；部署必须不组合 stdout logger，诊断输出一律走 stderr。

---

## 2. 线缆协议（Wire Protocol）

> 源码：`packages/sdk/protocol/src/types.ts`、`transport.ts`

### 2.1 传输层：`JsonRpcLineTransport`

换行分隔的 JSON-RPC 2.0，运行在调用方拥有的字节流上（生产环境即进程 stdio）：

- 每行一个紧凑 JSON 帧，以 `\n` 结尾；
- 帧分类规则：同时含 `id` 与 `method` → **请求**；只有 `id` → **响应**；只有 `method` → **通知**；
- 畸形 JSON 行被静默忽略；
- `start()` 挂载流监听器（幂等）；`close()` 摘除监听器并拒绝所有 pending 请求，**不销毁流本身**；
- 缺少请求处理器 → 返回 `-32601`（method not found）；处理器抛错 → 返回 `-32603`（internal error，携带错误消息）；
- 无处理器的通知直接丢弃；
- 提供 `flush()` 空屏障（等待此前帧写入回调完成）；
- `request(method, params, signal?)` 支持 `AbortSignal` 中止 —— 中止即"放弃"（abandonment）：transport 直接删除 pending 条目，不保留任何状态。

`JsonRpcResponseError` 保留线缆上的 `code` 与可选 `data`，供客户端精确区分错误类型。

`JsonRpcTransportPeer`（`request`/`notify` 出站面）是服务端类的类型约束。

### 2.2 客户端 → 服务端请求方法（共 3 个）

`HarnessSdkRequestMap` 按方法名索引：

#### 2.2.1 `initialize` —— 进程级握手

参数 `InitializeParams`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `cwd` | `string` | 是 | 记录到每个 SDK 创建的会话头（session header）上的工作目录；客户端须在过线前解析为绝对路径（否则会在子进程内二次解析，例如 `worker` → `worker/worker`） |
| `provider` | `string` | 是 | 所有 SDK 创建的 agent 运行的 provider 路由 |
| `model` | `string` | 是 | 模型名（服务端可能挂载回退适配器） |
| `maxTokens` | `number` | 否 | 可选的正整数输出 token 上限，被 SDK 创建的 agent 及其进程内后代继承；必须为正安全整数，否则拒绝初始化 |

结果 `InitializeResult`：

```json
{ "serverInfo": { "name": "deepseek-harness-sdk-runtime", "version": "0.0.1" } }
```

- `serverInfo.name` 是**线缆稳定标识**（wire-stable），客户端可据此确认对端身份；
- `version` 目前为 `0.0.1`，客户端不校验 —— **无协议版本协商**（预发布立场，无兼容承诺）。

服务端行为要点：

- 若请求的 provider 没有已注册适配器：`deepseek-official` 会自动挂载 `dsh-llm-deepseek` 回退适配器；其他 provider 直接初始化失败（fail loud）；
- 省略 `maxTokens` 表示不设 SDK 上限，允许所选适配器/provider 路由的默认值生效。

#### 2.2.2 `session/prompt` —— 投递一条用户消息

参数 `SessionPromptParams`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | SDK 侧会话 id；**未知 id 会懒创建 agent+session 对** |
| `contentBlocks` | `ContentBlock[]` | prompt 内容块，**原样**作为用户消息发送（字符串会被客户端归一化为 `[{type:'text', text}]`） |

结果 `SessionPromptResult`：

```json
{ "messageId": "<入队消息的持久身份>" }
```

关键语义：

- **立即返回入队回执**，不等待任何 agent 活动；
- `messageId` 只标识入队的 `UserMessage`，**不标识**后续的 assistant 消息、turn 结束或 prompt 结果；
- 服务端不将任何 assistant 消息或 `turn/end` 归因到该 prompt；
- 独立请求可在同一会话上继续入队更多工作；
- 服务端在投递前会校验会话记录仍在活跃 agent 注册表中（防止 agent-loop-only reload 后 handle 悬空）。

#### 2.2.3 `shutdown` —— 协议关闭

- 无参数，结果 `{}`；
- 服务端应答后：flush 响应 → dispose 整个 root context（含持久化）→ 以退出码 0 结束进程；
- 竞态的 shutdown 请求共享同一退出任务，不会重复 dispose/exit；
- EOF 与信号退出由 app bin 负责（同样 dispose root context）；
- 仅卸载该插件只停止服务、不退出进程。

### 2.3 服务端 → 客户端通知（共 4 个）

`HarnessSdkNotificationMap` 按方法名索引：

| 方法 | 负载类型 | 内容 |
|---|---|---|
| `session.event` | `SessionEventNotification` | `{ sessionId, event }` —— 运行时中**所有会话**（不止 SDK 创建的）的完整 session-log 事件信封，随记录即时流式推送 |
| `session.status` | `SessionStatusNotification` | `{ sessionId, status: 'idle' \| 'running' }` —— 整 agent 生命周期状态迁移 |
| `subagent.started` | `SubagentStartedNotification` | `{ parentSessionId, childSessionId }` —— 运行时内子会话被创建（源自 `session/created` 且带 `parentSession` 头） |
| `subagent.finished` | `SubagentFinishedNotification` | `{ provider, agentId, parentSessionId, childSessionId, status, stopReason, lastAssistantMessage? }` —— **仅进程内子代理运行**（`local` 标志为真；远程运行不报告） |

`SubagentFinishedNotification` 细节：

- `status` 是部署映射结果（`SdkRunStatus = 'ok' | 'error'`）：`completed` → `ok`；`max-tokens` → 仅当服务端配置 `maxTokensAsSuccess: true` 时为 `ok`，否则 `error`；其余 stopReason → `error`；
- `lastAssistantMessage`：子 agent 最后一条非空 assistant 消息；若无，则为其累积的 assistant 文本；两者皆无时字段缺省。

协议依赖的外部类型（属于线缆契约的一部分）：

- `SessionEvent`（`dsh-session`）—— 协议流式传输完整 session-log 信封，**会话事件词汇表即线缆契约**；
- `ContentBlock`（`dsh-llm`）；
- `SubagentStopReason`（`dsh-subagent`）。

### 2.4 协议帧示例（实际报文形态）

```jsonc
// → initialize 请求
{"jsonrpc":"2.0","id":"req_3f8a...","method":"initialize",
 "params":{"cwd":"/abs/workspace","provider":"deepseek-official","model":"deepseek-v4-flash","maxTokens":49152}}
// ← initialize 响应
{"jsonrpc":"2.0","id":"req_3f8a...","result":{"serverInfo":{"name":"deepseek-harness-sdk-runtime","version":"0.0.1"}}}

// → session/prompt 请求
{"jsonrpc":"2.0","id":"req_91bc...","method":"session/prompt",
 "params":{"sessionId":"session-1","contentBlocks":[{"type":"text","text":"say hi"}]}}
// ← 响应（入队回执）
{"jsonrpc":"2.0","id":"req_91bc...","result":{"messageId":"msg_..."}}

// ← 通知（事件流、状态、子代理生命周期）
{"jsonrpc":"2.0","method":"session.event","params":{"sessionId":"session-1","event":{"type":"agent/inbox/spliced","data":{...}}}}
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"session-1","status":"running"}}
{"jsonrpc":"2.0","method":"subagent.started","params":{"parentSessionId":"session-1","childSessionId":"session-2"}}
{"jsonrpc":"2.0","method":"subagent.finished","params":{"provider":"spawn","agentId":"session-2","parentSessionId":"session-1","childSessionId":"session-2","status":"ok","stopReason":"completed"}}
{"jsonrpc":"2.0","method":"session.status","params":{"sessionId":"session-1","status":"idle"}}
```

### 2.5 协议已知限制（官方明示）

1. **无协议版本协商** —— 握手只带 `serverInfo.version`，客户端不校验；
2. **无取消 / 无会话关闭方法** —— 客户端放弃一个 turn 的唯一方式是关闭运行时进程；SDK 创建的 agent 在进程 shutdown 前一直存活；
3. **无 per-prompt 结果** —— `messageId` 只标识入队准入；自动化区间（activity interval）由客户端自己定义并观察；
4. **server→client 请求是死能力** —— transport 支持，但服务端从不发送；Python SDK 的 responder 面为未来审批流预留。

---

## 3. 运行时载体与启动方式

### 3.1 `dsh-jsonrpc-agent` bin

运行时入口是 `dsh-jsonrpc-agent`（对应示例组合 `@deepseek-ai/dsh-sdk-jsonrpc-demo`）。它是零配置的硬语义载体：

- **必须显式提供配置**：`$DSH_CORDIS_CONFIG` 环境变量，或 argv 位置参数给出 config 路径；缺失时**响亮退出**（fail loud），这是运行时设计的一部分；
- bin 只启动配置列出的插件；服务接口（stdio JSON-RPC server）本身就是配置中的一个条目（`@deepseek-ai/dsh-sdk-jsonrpc-server`）——没有它，启动的 agent 没有任何对外通道。

### 3.2 Python 侧两种载体（`deepseek-harness-runtime-bin`）

两种载体共存于 `src/deepseek_harness_runtime/runtime/`，由 `scripts/build-exe-for-python-sdk.ts` 构建：

| 载体 | 说明 |
|---|---|
| **exe（生产）** | 单文件 Node 可执行 `dsh-jsonrpc-agent-pkg-<platform>-<arch>`（linux/macos × x64/arm64）；macOS 附带 `node-pty` 所需的 `-spawn-helper`；目标机无需 Node。**唯一随 wheel 分发的载体** |
| **node（仅开发）** | `runtime/node/` 完整部署闭包，以系统 Node ≥ 22.19 运行 `node runtime/node/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js`；当前 checkout 的源码构建，**永不自动选中**（生产部署不可能静默骑在源码构建上） |

wheel 平台标签固定为：`py3-none-manylinux_2_28_x86_64`、`py3-none-manylinux_2_28_aarch64`、`py3-none-macosx_14_0_arm64`（macOS 保守对齐内置 Node 24 的 13.5 部署目标）。

解析 API（`deepseek_harness_runtime` 模块）：

```python
resolve_bundled_launch_args(mode=None) -> tuple[str, ...]
# exe 模式 → (exe_path,)；node 模式 → (node_path, bin_js_path)
# 优先级：显式参数 > DSH_RUNTIME_MODE 环境变量（'exe'|'node'）> 自动（自动只找生产 exe）

bundled_runtime_path() -> Path        # 平台 exe 路径（exe 载体；macOS 校验 spawn-helper 在位）
bundled_default_config_path() -> Path # 入库的默认 cordis.yml
bundled_package_dir() -> Path         # 安装包数据根目录
```

### 3.3 TypeScript 侧启动

TypeScript 客户端**不做打包运行时解析** —— 调用方显式给出 `command`/`args`（该包定位是仓库相邻的 TS 消费者，知道自己要启动什么运行时）。打包可执行文件发现留在 Python 发行版侧。

从仓库源码启动的典型形态：

```ts
new DeepSeekHarness({
  launch: { command: 'node', args: ['lib/bin.js', 'cordis.yml'] },
  // ...
})
```

---

## 4. TypeScript SDK 详解（`@deepseek-ai/dsh-sdk-client`）

> 源码：`packages/sdk/client/src/`。包根只导出消费者接口：两层客户端、面向调用方的类型、`JsonRpcResponseError`；源模块、归一化辅助函数与订阅分发机制**不是**消费者导入项。

### 4.1 导出清单

```ts
// 类
export { DeepSeekHarness, HarnessSession }                    // 高层 API
export { HarnessClient, RequestTimeoutError, SdkProtocolError, TransportClosedError }  // 底层客户端 + 错误类型
export { JsonRpcResponseError }                               // 重导出自 protocol

// 类型
export type { RunOptions, NotificationSubscription, ContentBlock, DeepSeekHarnessOptions,
              HarnessClientOptions, HarnessNotification, NotificationFilter, RunResult }
```

### 4.2 高层 API：`DeepSeekHarness`

可复用的运行 SDK：一个实例拥有**一个运行时子进程**，跨多次 `run()` 调用复用。实现 `AsyncDisposable`，支持 `await using`。

#### 构造选项 `DeepSeekHarnessOptions`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `launch` | `HarnessClientOptions` | 必填 | 运行时启动规格（command/args/cwd/env/超时） |
| `cwd` | `string` | `launch.cwd` → `process.cwd()` | 记录到每个 SDK 创建会话的工作区 cwd；**构造时即解析为绝对路径** |
| `provider` | `string` | `'deepseek-official'` | SDK 创建 agent 的 provider 路由 |
| `model` | `string` | `'deepseek-v4-flash'` | 模型名 |
| `maxTokens` | `number` | 无 | 每次会话模型请求的输出 token 上限 |

#### 方法

| 方法 | 说明 |
|---|---|
| `start(): Promise<void>` | 启动子进程并执行一次 `initialize` 握手（memoized）。**失败时回收运行时并换入新 client**，后续调用以新子进程重试 —— 直到 `close()`（终态，不再重试） |
| `session(sessionId?): HarnessSession` | 打开会话句柄（**无线上流量**；运行时在首次 prompt 时才创建会话）。省略 id 时生成 `session-<uuid hex>` |
| `run(input, options?): Promise<RunResult>` | 在新（或指定）会话上运行一次 prompt，等价于 `this.session(options?.sessionId).run(input, options)` |
| `close(): Promise<void>` | 关闭并回收运行时子进程；幂等且终态 |
| `[Symbol.asyncDispose]()` | `await using` 支持，等同 `close()` |
| `get client` | 暴露底层 `HarnessClient` 供低级访问。注意：握手失败会回收并更换实例，**不要在失败的 `start()` 之后缓存它** |

#### `run()` 的完整语义

`run(input, { sessionId?, onNotification? })` 拥有**一个活动区间**（owned activity interval）：

1. 归一化输入（字符串 → 单个 text block；content blocks 原样发送）；
2. 订阅会话树通知（`subscribeSessionTree`）；
3. 入队 prompt，等待其 `messageId` 出现在持久的 `agent/inbox/spliced` 回执中（防止把区间前的历史事件计入）；
4. 持续收集，直到下一个整 agent `idle`（`session.status` 且 `status === 'idle'`）；
5. 返回 `RunResult`。

返回 `RunResult`：

| 字段 | 说明 |
|---|---|
| `sessionId` | 活动区间运行的会话 |
| `finalResponse` | 区间内**最后一条** root 会话 assistant 消息的文本拼接（无则 `''`） |
| `events` | 区间内 root 会话的所有 `session.event` 负载，按线缆顺序 |
| `notifications` | root 会话及从 `subagent.started` 发现的后代的**所有**通知，按线缆顺序 |

重要语义警示：

- `finalResponse` 是区间内最后提交的 assistant 文本，**不是因果归属于该 prompt 的响应** —— steering、注入上下文、其他入队工作都可能在 idle 前做出贡献；
- 结果**不携带** prompt 级状态或 turn reason（TS 版无 `finishReason`；Python 版有，见 §5）；
- transport 丢失、超时、协议违规会 reject；模型结果仍可在事件流中观察，但不归因于单个输入。

### 4.3 底层 API：`HarnessClient`

拥有子进程的 JSON-RPC 客户端：spawn 运行时、通过子进程 stdio 说话协议、把服务端通知扇出到订阅、通过私有的 **EOF → SIGTERM → SIGKILL 阶梯**把子进程拆到静止。它运行在任何 harness 上下文**之外**，因此直接 spawn（不走 `dsh-subprocess` 服务 —— 这是该 seam 的文档化例外）。

#### 构造选项 `HarnessClientOptions`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `command` | `string` | 必填 | 运行时可执行文件（`dsh-jsonrpc-agent` bin、打包 exe 或 `node`） |
| `args` | `string[]` | `[]` | 传给 command 的参数 |
| `cwd` | `string` | — | 运行时进程自身的工作目录 |
| `env` | `NodeJS.ProcessEnv` | 继承父 env | **完整子环境**：`undefined` 原样继承父 env；传对象则**整体替换**，调用方自持凭证策略（可配合 `dsh-subprocess` 的 `scrubbedParentEnv` 做清洗基线） |
| `requestTimeoutMs` | `number` | 无限等待 | 每请求超时（ms）；`undefined` 无限等（一个 turn 合理可能很长） |
| `shutdownTimeoutMs` | `number` | `1000` | `close()` 内协议 `shutdown` 交换的上限（ms） |
| `disposeEofGraceMs` | `number` | `6000` | `close()` 中 stdin-EOF 静止宽限（ms） |
| `disposeGraceMs` | `number` | `3000` | SIGTERM/SIGKILL 后的终止确认窗口（ms） |

#### 方法

| 方法 | 说明 |
|---|---|
| `start(): void` | spawn 运行时子进程并开始读帧。进程存活时幂等；`close()` 后拒绝复用 |
| `initialize(params): Promise<InitializeResult>` | 进程级握手；校验返回的 server 身份，缺失则抛 `SdkProtocolError` |
| `prompt(sessionId, contentBlocks): Promise<string>` | 入队一条 prompt，返回持久 inbox 身份（messageId）。**绝不等待 agent 活动** |
| `request(method, params?, timeoutMs?): Promise<unknown>` | 发送一个 JSON-RPC 请求并 await 结果；`timeoutMs` 可逐次覆盖全局配置；内部自动 `start()` |
| `subscribe(filter?): NotificationSubscription` | 订阅服务端通知；省略 filter 即全部通知 |
| `subscribeSessionTree(sessionId): NotificationSubscription` | 订阅一个会话及其从 `subagent.started` 血缘边发现的后代（运行时对上下文中所有会话发通知，**作用域过滤在客户端侧**，与 Python SDK 完全一致） |
| `close(): Promise<void>` | 请求协议 `shutdown`（受 `shutdownTimeoutMs` 限制）→ 走 EOF → SIGTERM → SIGKILL 阶梯直到进程真正退出。幂等 |

#### `NotificationSubscription`

`subscribe()` 返回的客户端侧通知流，实现 `AsyncIterable<HarnessNotification>`：

| 方法 | 说明 |
|---|---|
| `next(): Promise<HarnessNotification>` | await 下一条匹配通知。运行时死亡后：先排空已送达的，再 reject；`close()` 后立即 reject（队列被丢弃） |
| `tryNext(): HarnessNotification \| undefined` | 非阻塞取一条已入队通知；无则 `undefined` |
| `close(): void` | 与客户端分离；队列项丢弃、pending waiter 被 reject |
| `[Symbol.asyncIterator]` | 异步迭代直到订阅或运行时关闭（终止性 rejection 会传播） |

投递细节：抛异常的 filter **只失败该订阅自身**（分离后异常成为其终态错误），绝不打扰兄弟订阅或 transport 读循环（与 Python 客户端镜像）。

运行时死亡后 `fail()` 保留队列 —— 已送达通知仍可通过 `next()`/`tryNext()` 排空。

### 4.4 TS 客户端错误体系

| 错误类 | 触发条件 |
|---|---|
| `JsonRpcResponseError` | 线缆错误响应（保留 `code`/`data`） |
| `RequestTimeoutError` | 配置的请求超时耗尽（超时即放弃：transport 删除 pending 条目，不保留每调用状态；服务端工作仍会运行到 close） |
| `SdkProtocolError` | 运行时应答超出文档化协议（如 `initialize` 无 server 身份、`session/prompt` 无 messageId、`assistant/message` 事件 content 畸形） |
| `TransportClosedError` | 运行时已消失（退出、stdio 关闭、无法启动）；消息携带退出码与有界 stderr tail（≤400 行） |

### 4.5 完整 TypeScript 使用示例

```ts
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'

// —— 高层：一次 run ——
await using harness = new DeepSeekHarness({
  launch: { command: 'dsh-jsonrpc-agent', args: ['my-cordis.yml'] },
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  maxTokens: 49_152,
})
const result = await harness.run('say hi')
console.log(result.finalResponse)

// —— 高层：多轮同会话 + 流式观察 ——
const session = harness.session('my-task-001')
const r1 = await session.run('Inspect the repo and list failing tests.', {
  onNotification: (n) => {
    if (n.method === 'session.event') console.error('[event]', (n.params.event as any)?.type)
  },
})
const r2 = await session.run('Now fix them.')

// —— 底层：手动控制全生命周期 ——
import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

const client = new HarnessClient({
  command: 'node',
  args: ['lib/bin.js', 'cordis.yml'],
  requestTimeoutMs: 600_000,
})
client.start()
await client.initialize({ cwd: process.cwd(), provider: 'deepseek-official', model: 'deepseek-v4-flash' })

const subscription = client.subscribeSessionTree('session-1')
const messageId = await client.prompt('session-1', [{ type: 'text', text: 'say hi' }])
// 自行消费通知流，按自己的活动区间定义终止条件
for await (const notification of subscription) {
  if (notification.method === 'session.status'
      && notification.params.sessionId === 'session-1'
      && notification.params.status === 'idle') break
}
subscription.close()
await client.close()
```

---

## 5. Python SDK 详解（`deepseek-harness-sdk`）

> 源码：`python/sdk/src/deepseek_harness/`。dist 名 `deepseek-harness-sdk`，导入模块 `deepseek_harness`。同步 API（线程模型：后台 reader/stderr 线程 + 队列）。

### 5.1 安装与依赖关系

```sh
python -m pip install deepseek-harness-sdk
```

- 安装 `deepseek-harness-sdk` 会**连带安装完全同版本**的 `deepseek-harness-runtime-bin` 平台 wheel（内含 `dsh-jsonrpc-agent` 可执行文件，目标机无需 Node）；
- 要求 Python ≥ 3.10；平台：Linux x64 / Linux arm64 / macOS 14+（arm64）；
- 运行时继承常规 DeepSeek Harness 环境变量（`DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`），可直接用真实模型端点或指向本地代理。

### 5.2 公开导出（`__all__`）

```python
DeepSeekHarness, DeepSeekHarnessConfig, Session, RunResult      # 高层
HarnessClient, HarnessConfig                                     # 底层
SdkProtocolError                                                 # 错误（基类 HarnessError 未导出到顶层）
IncomingRequest, InitializeResponse, JsonObject, Notification, ServerInfo  # 数据模型
```

错误层级（`errors.py`）：`HarnessError` → `TransportClosedError`（子进程退出/关闭 stdout）、`SdkProtocolError`（运行时发出协议外数据）、`JsonRpcError`（JSON-RPC 错误响应，带 `code`/`message`/`data`）。另有内置 `TimeoutError` 用于请求超时。

### 5.3 高层 API：`DeepSeekHarness`

#### 配置 `DeepSeekHarnessConfig`（可用 kwargs 直传）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `provider` | `str` | `'deepseek-official'` | 所选 Cordis 组合注册的 provider 路由 |
| `model` | `str` | `'deepseek-v4-flash'` | 该适配器解析的模型 id |
| `max_tokens` | `int \| None` | `None` | 每请求输出 token 上限（root agent 及其进程内后代）；省略则由 provider 默认控制 |
| `cwd` | `str \| None` | 当前目录 | agent 工作区；spawn/环境注入/线缆握手前解析为绝对路径 |
| `runtime_cwd` | `str \| None` | = `cwd` | 运行时进程自身的工作目录 |
| `session_root` | `str \| None` | — | 设置 `DSH_SESSION_ROOT`（高层便捷项） |
| `cordis` | `str \| None` | — | 自定义 cordis.yml 路径 → 注入 `DSH_CORDIS_CONFIG` |
| `env` | `dict[str, str]` | `{}` | 覆盖/注入子进程环境变量 |
| `runtime_bin` | `str \| None` | — | 显式运行时可执行文件；**给出即完全禁用默认配置注入** |
| `launch_args_override` | `tuple[str, ...] \| None` | — | 完整覆盖启动 argv；同样禁用注入 |
| `request_timeout_seconds` | `float \| None` | `None` | 请求超时（秒） |
| `shutdown_timeout_seconds` | `float \| None` | `1.0` | shutdown 交换上限 |
| `base_url` | `str \| None` | — | 注入 `DEEPSEEK_BASE_URL` |
| `api_key` | `str \| None` | — | 注入 `DEEPSEEK_API_KEY` |

构造约束：`config` 与 `**kwargs` 二选一，同时给出抛 `TypeError`。

#### 方法

| 方法 | 说明 |
|---|---|
| `start()` | 启动运行时 + `initialize` 握手（幂等） |
| `close()` | 关闭并回收子进程 |
| `start_session(session_id=None) -> Session` | 打开会话句柄（默认 `session-<uuid4 hex>`） |
| `run(input, *, session_id=None, on_notification=None) -> RunResult` | 高层一步式：在新/指定会话运行一次 prompt |
| `client` 属性 | 底层 `HarnessClient` |

上下文管理器：`with DeepSeekHarness(...) as harness:` —— 进入即 `start()`，退出即 `close()`。

#### 零配置运行 vs 自定义组合

```python
# 零配置：启动打包运行时 + sdk-runtime 的默认 cordis.yml（由客户端在 HarnessClient.start()
# 中经 DSH_CORDIS_CONFIG 注入 —— 显式可见的参数传递，而非运行时内的隐藏回退）
with DeepSeekHarness() as harness:
    result = harness.run("Say hi.")

# 自定义组合：保留 @deepseek-ai/dsh-sdk-jsonrpc-server 条目，传入自己的 cordis.yml
with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cordis="examples/jsonrpc-agent/cordis.yml",
) as harness:
    result = harness.run("Make the requested code change.")
```

默认配置注入条件（精确）：启动解析到打包运行时，且 `cordis` 未设、`DSH_CORDIS_CONFIG` 为空或未设（运行时把空值视为缺失，注入检查同样如此）。显式 `runtime_bin`、`bridge_bin` 或 `launch_args_override` **完全禁用**注入。

#### `Session.run()` 与 `RunResult`

`Session.run()` 拥有从其 prompt 的持久 inbox 回执到下一个整 agent idle 的活动区间。返回：

```python
RunResult(session_id, final_response, finish_reason, events, notifications, session_root)
```

| 字段 | 说明 |
|---|---|
| `session_id` | 会话 id |
| `final_response` | 区间内最后提交的 root 会话 assistant 文本 |
| `finish_reason` | 区间内最后一个 root 会话 `turn/end` 的 `kind`（如 `completed`、`max-tokens`、`error`）；无 turn 结束则 `None`。`turn/end` 缺字符串 `data.reason.kind` 违反运行时协议 → 抛 `SdkProtocolError` |
| `events` | **仅 root 会话**事件（后代消息不能替换 root 响应） |
| `notifications` | root 会话及所有已知后代的通知，按线缆顺序 |
| `session_root` | 回显配置的 session_root |

与 TS 版差异：Python 版 `RunResult` **额外提供 `finish_reason`**。

`HarnessClient` 在运行时进程存活期间保留已发现的 subagent 祖先关系；每次 `Session.run()` 中 `RunResult.notifications` 与 `on_notification` 接收 root 会话及所有已知后代的通知（含嵌套 subagent 生命周期与会话事件）。

### 5.4 底层 API：`HarnessClient`

同步 stdio JSON-RPC 客户端（后台 daemon reader 线程 + stderr 线程，stderr tail 上限 400 行）。

#### `HarnessConfig`

`runtime_bin`、`bridge_bin`、`launch_args_override`、`cwd`、`env`、`request_timeout_seconds`、`shutdown_timeout_seconds`（默认 1.0）。

#### 方法清单

| 方法 | 说明 |
|---|---|
| `start()` / `close()` | spawn 子进程（含默认配置注入）/ shutdown + stdin 关闭 + terminate/kill 回收 |
| `initialize(*, cwd, provider, model, max_tokens=None) -> InitializeResponse` | 握手；失败自动 `close()` 后重新抛出 |
| `session_prompt(session_id, content_blocks, *, on_notification=None, notification_subscription=None) -> str` | 低层投递：立即返回入队 `MessageId`；绕过 `Session.run()` 的调用方自持后续活动边界 |
| `request(method, params, *, response_model, timeout_seconds=None, on_notification=None, notification_filter=None, notification_subscription=None)` | 通用请求；用 pydantic `response_model` 校验响应；等待期间可按 50ms 轮询排空通知 |
| `notify(method, params=None)` | 发送通知 |
| `next_notification() -> Notification` | 从全局队列取下一条通知 |
| `subscribe_notifications(filter=None) -> NotificationSubscription` | 通用订阅 |
| `subscribe_session_notifications(session_id) -> NotificationSubscription` | 会话树订阅（含 subagent 后代） |
| `next_request() -> IncomingRequest` | 取服务端发来的请求（为未来审批流预留） |
| `respond(request_id, result)` / `respond_error(request_id, *, code, message, data=None)` | 应答服务端请求（responder 面，未来审批流） |

`NotificationSubscription` 是上下文管理器：`next()`（阻塞）、`drain(on_notification)`（非阻塞排空）、`close()`。

### 5.5 完整 Python 使用示例

```python
from pathlib import Path
from deepseek_harness import DeepSeekHarness

config = Path("examples/jsonrpc-agent/minimal.cordis.yml").resolve()
workspace = Path("/absolute/path/to/workspace").resolve()
sessions = Path("/absolute/path/to/sessions").resolve()

with DeepSeekHarness(
    provider="deepseek-official",
    model="deepseek-v4-flash",
    max_tokens=49_152,
    cwd=str(workspace),
    session_root=str(sessions),
    cordis=str(config),
) as harness:
    # 单轮
    result = harness.run("Inspect the repository and fix the failing tests.",
                         session_id="example-001")
    print(result.final_response, result.finish_reason)

    # 多轮同会话（保留持久 Bash 状态：工作目录、导出变量、shell 函数）
    session = harness.start_session("example-001")
    r2 = session.run("Summarize what you changed.",
                     on_notification=lambda n: print("[ntf]", n.method))
```

仓库自带的可运行示例 `examples/jsonrpc-agent/minimal.py`：

```sh
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1   # OpenAI 兼容代理时
python examples/jsonrpc-agent/minimal.py \
  --workspace /absolute/path/to/workspace \
  --session-root /absolute/path/to/sessions \
  --session-id example-001 \
  "Inspect the repository and fix the failing tests."
```

---

## 6. 服务端插件详解（`@deepseek-ai/dsh-sdk-jsonrpc-server`）

> 源码：`packages/sdk/server/src/index.ts`、`server.ts`

### 6.1 插件形态

- 插件名 `sdk-jsonrpc-server`，`inject: ['agents']`（只需 agent 工厂；initialize 用 `ctx.get()` 读可选 LLM seam）；
- `HarnessSdkJsonRpcServer` 拥有协议方法与通知；transport 与具名线缆类型在 `dsh-sdk-protocol`，与客户端 SDK 共享。

### 6.2 Config（`JsonRpcConfig`）

| 字段 | Schema 默认 | 说明 |
|---|---|---|
| `maxTokensAsSuccess` | `false` | 把 max-token 终止报告为成功的 SDK 结果；只影响 `subagent.finished` 的部署映射状态（root 会话 prompt 无 prompt 级状态） |
| `input` | `process.stdin` | transport 输入覆盖（仅测试钩子） |
| `output` | `process.stdout` | transport 输出覆盖（仅测试钩子） |
| `exit` | `process.exit` | 退出覆盖（仅测试钩子） |

### 6.3 会话生命周期管理

- **每 `sessionId` 一个 agent**：首次 `session/prompt` 时懒创建（`ctx.agents.create`，会话头记录 `cwd`，agentOptions 带 provider/model/maxTokens）；并发创建同 id 会合并到同一 pending promise；
- 不使用 preset 组合：模型面向行留在宿主平面，agent 从全局层读取；若部署需要 roster，须在此先 join（见 `dsh-agent-presets` README）；
- 投递前校验 agent 仍在活跃注册表（agent-loop-only reload 会 dispose loop 的 agent 而记录幸存，保留的 agent 会静默接受 followup）；
- 通知订阅：`session/event` → `session.event`；`agent/status` → `session.status`；`session/created`（带 parentSession）→ `subagent.started`；`subagent/end`（仅 `local` 为真）→ `subagent.finished`。

### 6.4 模型体验（Model Experience）

- 每个被接受的 `session/prompt`，会话模型收到调用方 `contentBlocks` 原样的一条用户消息；本包**不添加**系统提示词或工具 schema（来自周围 cordis.yml 的插件）；
- Token 影响：用户消息 token 进入保留的会话历史，后续 turn 重发直到被压缩；JSON-RPC 帧、通知、服务器簿记**零**模型上下文 token；
- KV Cache：append-only，新可见内容跟在可复用请求前缀之后，不失效已有 KV-cache 条目。

---

## 7. 运行时组合（cordis.yml）详解

### 7.1 `examples/jsonrpc-agent/cordis.yml`（无人值守 coding-agent）

完整独立组合，刻意**不加载**终端 UI、console logger、审批 UI、用户提问工具（stdout 属于 SDK 协议，turn 由 SDK 驱动）。模型面向工具：

- `bash`（仅前台）；`read`/`write`/`edit`；`subagent`（前台进程内 spawn provider）；`todo_write`

运行时还加载：JSONL 会话持久化（zstd 压缩）、checkpoint 策略、基础上下文压缩。插件清单：

| 插件 id | 包 | 关键配置 |
|---|---|---|
| `sdk-jsonrpc-server` | `@deepseek-ai/dsh-sdk-jsonrpc-server` | `maxTokensAsSuccess`（`DSH_MAX_TOKENS_AS_SUCCESS`，默认 true） |
| `llm-deepseek` | `@deepseek-ai/dsh-llm-deepseek` | `thinking: enabled`，`reasoningEffort: max`（模型经 JSON-RPC 按会话到达，不在此钉死） |
| `subprocess` / `bash` | `dsh-subprocess-local` / `dsh-bash-local` | bash `timeoutMs: 60000`，cwd = `DSH_CWD` |
| `agent-spine` | `@deepseek-ai/dsh-agent-spine-demo` | persona = `DSH_SYSTEM_PROMPT` ?? 'You are a coding agent.'；关闭 workspace 上下文/skills/后台 bash/jobs |
| `sessions` | `@deepseek-ai/dsh-session-persistence-jsonl` | root = `DSH_SESSION_ROOT` ?? './.sessions'；生产 zstd，snapshot 无压缩 |
| `session-checkpoints` | `dsh-session-checkpoint-policy` | 语义检查点策略 |
| `subagent` + `subagent-spawn-in-process` + `tool-subagent` | subagent seam | provider 名 `spawn`，前台 |
| `tool-todo` | `@deepseek-ai/dsh-tool-todo` | 允许并行进行中项 |
| `fs-local` + `fs-observation-policy` + `tool-fs` | fs seam | cwd = `DSH_CWD` |
| `token-meter` | `@deepseek-ai/dsh-token-meter` | token 计量 |
| `compaction-basic` | `@deepseek-ai/dsh-compaction-basic` | thresholdRatio 0.8 / retainRatio 0.16 / maxTokens 8192 / 重试 1 |

### 7.2 minimal 变体（`minimal.cordis.yml`）

Web `minimal` preset 的完整独立对应物，模型面向工具仅两个：

- owner 作用域持久 `bash`（PTY，300s 超时）；
- `str_replace_editor`（`view`/`create`/`str_replace`/`insert`，输出上限 16000 字符）。

特性：`DSH_SYSTEM_PROMPT` 选择系统提示（回退 `You are a helpful software engineer assistant.`）；抑制新会话的所有系统提示运行时上下文贡献；**不挂压缩**；`danger-full-access` 策略；无压缩 JSONL 持久化。

安全警告：Bash 与绝对编辑器路径可修改运行时进程可见的任何路径 —— 只应在一次性 checkout 或容器中运行；持久 PTY 需 POSIX 终端环境，不支持 Windows。

### 7.3 sdk-runtime 默认配置（零配置运行）

`python/sdk-runtime/runtime/cordis.yml`（入库）：JSON-RPC 服务条目 + agent 核心 + 预载 DeepSeek 适配器 + JSONL 持久化 + 显式组合的语义 checkpoint 策略 + 本地 bash + 有界工作区指令加载的本地 fs provider。

### 7.4 自定义组合要点

- **必须保留** `@deepseek-ai/dsh-sdk-jsonrpc-server` 条目，否则 agent 没有对外通道；
- **stdout 纯度是部署强制的**：周围配置仍可能加载 stdout logger 损坏 JSON-RPC 通道，插件不审查也不否决兄弟 logger；
- 自定义组合可挂载 `llm-pi-ai`，在其处配置 provider 凭证/端点，并选择 pi-ai 安装目录中的任何 provider/model；
- 运行时继承 `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`，可用真实端点或本地代理。

### 7.5 环境变量目录（jsonrpc-agent 运行时）

| 变量 | 用途 |
|---|---|
| `DEEPSEEK_API_KEY` | 传给 OpenAI 兼容宿主端点的凭证 |
| `DEEPSEEK_BASE_URL` | `dsh-llm-deepseek` 使用的宿主端点 |
| `DSH_CWD` | bash 与文件系统工具的 agent 工作区 |
| `DSH_CONTEXT_WINDOW` | minimal 变体中 `DSH_MODEL` 目录条目的上下文容量 |
| `DSH_MAX_TOKENS_AS_SUCCESS` | `true`（默认）接受 token 受限结果；`false` 报告为错误 |
| `DSH_MODEL` | `minimal.py` 的默认模型；`--model` 优先 |
| `DSH_SESSION_ROOT` | JSONL 会话目录 |
| `DSH_SYSTEM_PROMPT` | 部署提供的 coding persona |
| `DSH_CORDIS_CONFIG` | cordis.yml 路径（SDK 注入或显式设置） |
| `DSH_RUNTIME_MODE` | Python 运行时载体选择（`exe` \| `node`） |

---

## 8. 生命周期与拆除（Teardown）语义

### 8.1 TS 客户端拆除阶梯（`disposeRuntimeProcess`）

`close()` 的完整链路：

1. 尽力协议 `shutdown`（受 `shutdownTimeoutMs` 限制，默认 1s）—— 失败仅作诊断记录；
2. 关闭 stdin，允许协作式拆除与持久状态 flush（EOF 宽限 `disposeEofGraceMs`，默认 6s）；
3. POSIX：`SIGTERM`（优雅可捕获信号）；Windows 跳过直接强杀（Node 把两个信号都映射为 `TerminateProcess`）；
4. `SIGKILL` 并等待有界退出边（`disposeGraceMs`，默认 3s）；SIGKILL 后仍未退出则 reject。

阶梯私有于该客户端：它运行在任何 harness 上下文外，无法搭载 `dsh-subprocess` 服务 —— 这是该 seam 文档化的 SDK 管理 transport 例外。幂等；关闭后的客户端拒绝复用。

### 8.2 服务端 shutdown 语义

- 插件应答 `shutdown` → flush 响应 → dispose root context（SDK 拥有的 agent、订阅、持久化到达静止）→ 退出码 0；
- 竞态 shutdown 共享一个退出任务；
- EOF/信号退出由 app bin 负责；仅卸载插件只停服务不退进程。

### 8.3 会话状态持久性与复用策略

- 复用同一 harness + 会话 id 保留会话拥有的 Bash 进程（工作目录、导出变量、shell 函数）；
- 独立任务用新会话 id；仅当下次调用应延续同一持久对话时复用 id；
- 会话日志（JSONL）存于 `DSH_SESSION_ROOT`，含组装的模型请求与工具调用。

---

## 9. 能力边界与已知限制汇总

| 限制 | 影响与应对 |
|---|---|
| 无中途取消（no mid-turn cancel） | 线缆无 prompt-cancel 方法；放弃 turn 的唯一方式是关闭运行时 |
| 无 per-prompt 结果 | `messageId` 仅是入队回执；自动化区间由客户端自定义并观察（高层 `run()` 提供 receipt→idle 区间） |
| 无会话关闭方法 | SDK 创建的 agent 存活到进程 shutdown |
| 无协议版本协商 | 预发布立场，无兼容承诺 |
| server→client 请求未启用 | transport 支持，为未来审批流预留；Python SDK 已有 responder 面（`next_request`/`respond`） |
| TS 客户端无打包运行时解析 | 调用方显式给出可执行文件；打包发现留在 Python 侧 |
| 适配器自动挂载是 DeepSeek 专属 | `initialize` 可复用任何预注册适配器，但唯一回退只挂 `dsh-llm-deepseek` |
| stdout 纯度靠部署约束 | 周围配置仍可能加 stdout logger 损坏通道，插件不否决 |
| TS 版无 finish_reason | 需 turn 终止原因时用 Python SDK，或自行从 `events` 中提取 `turn/end` |
| 无客户端→服务端通知实现 | 两端线缆均未实现，transport 携带能力备用 |

---

## 10. 选型与实践建议

### 10.1 SDK 选型矩阵

| 场景 | 推荐 |
|---|---|
| Python 自动化/评测/无人值守 coding agent，零配置起步 | Python SDK（`deepseek-harness-sdk`）：打包运行时 + 默认配置 + `finish_reason` |
| 仓库内 TypeScript 消费者（如 `dsh-subagent-dsh-sdk` 后端）、精确控制启动规格 | TS 客户端（`@deepseek-ai/dsh-sdk-client`） |
| 需要自定义通知过滤/自建活动区间/低级请求 | 两语言的 `HarnessClient` 底层 API |
| 在自定义 cordis.yml 中提供 SDK 服务面 | 组合中加入 `@deepseek-ai/dsh-sdk-jsonrpc-server` |

### 10.2 关键实践要点

1. **始终关闭**：TS 用 `await using` 或 `close()`；Python 用上下文管理器 —— 保证子进程必被回收；
2. **cwd 绝对化**：两个 SDK 都在过线前解析绝对路径，自定义集成时保持同习惯；
3. **凭证策略自持**：TS `env` 传对象即整体替换子环境，隔离场景配合 `scrubbedParentEnv`；Python `env` 是合并覆盖；
4. **会话 id 策略**：独立任务新 id；延续对话+持久 shell 状态才复用 id；
5. **结果归因警告**：`finalResponse` 不归因于单个 prompt，steering/注入上下文/排队工作都可能贡献；需精确归因时自建观察区间；
6. **长 turn 超时**：`requestTimeoutMs`/`request_timeout_seconds` 默认无限等待是有意为之（turn 合理可能很长）；设限时注意超时只是客户端放弃，服务端工作仍运行到 close；
7. **安全**：minimal 组合是 `danger-full-access`，只在一次性 checkout/容器中跑；且持久 PTY 不支持 Windows。

### 10.3 仓库内 SDK 消费方参考

- `packages/subagent/subagent-dsh-sdk/`：把 dsh SDK 运行时作为 subagent 后端（仓库内 TS 客户端的典型消费者）；
- 快照测试体系通过 `DSH_SNAPSHOT` 环境变量切换 JSONL 无压缩模式回放。

---

## 附录：关键源码定位

| 主题 | 路径 |
|---|---|
| 线缆类型（3 请求 + 4 通知） | `packages/sdk/protocol/src/types.ts` |
| JSON-RPC 行传输 | `packages/sdk/protocol/src/transport.ts` |
| TS 高层 API | `packages/sdk/client/src/api.ts` |
| TS 底层客户端 + 订阅机制 | `packages/sdk/client/src/client.ts` |
| TS 拆除阶梯 | `packages/sdk/client/src/dispose.ts` |
| 服务端插件入口 | `packages/sdk/server/src/index.ts` |
| 服务端协议实现 | `packages/sdk/server/src/server.ts` |
| Python 高层 API | `python/sdk/src/deepseek_harness/api.py` |
| Python 底层客户端 | `python/sdk/src/deepseek_harness/client.py` |
| Python 运行时解析 | `python/sdk-runtime/`（`resolve_bundled_launch_args` 等） |
| 无人值守组合 | `examples/jsonrpc-agent/cordis.yml`、`minimal.cordis.yml`、`minimal.py` |
| 用户教程 | `docs/user/guide/python-sdk.md` |
| 设计决策 Agent Note | `.agents/notes/implemented/feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md`；`.agents/notes/implemented/simplification/2026-08-11-remove-sdk-project-toolchain.md` |
