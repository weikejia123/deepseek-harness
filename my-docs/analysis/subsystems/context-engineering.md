# 上下文工程：提示词装配与压缩

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

本文分析 dsh 如何构建模型每次请求所见的内容：system prompt 的分块装配、runtime context 快照、以及 compaction 的事务化压缩。

## System prompt：注册表 + 装配

`packages/core/system-prompt` 把系统提示词从「一个字符串模板」重构为**注册表装配**（`ctx.systemPrompt`）。插件可贡献四类条目：

| 条目 | 语义 |
|---|---|
| `section` | 带 `order` 的提示词块（约定：-100 harness identity、0 persona、100-199 工具指引） |
| `context` | 动态 runtime-context 源，渲染成 user-role 快照 |
| `tools` provider | 工具 schema 的额外来源 |
| `variable` | `{{variable}}` 严格插值，未知引用抛错（fail loud） |

装配由 `assemble()` 完成：收集 → 按 order 排序 → 过 `system-prompt/assemble` waterfall（返回值权威）。两个值得注意的设计：

- **`complete: true` 的 section 成为唯一 prompt**：agent preset 用它整体覆盖部署 persona（极简模式的 `You are a helpful software engineer assistant.` 就是这么来的），且 waterfall 之后被强制恢复——插件无法意外破坏它；
- **`toolOrder` 的 `<unlisted-tools>` 占位符**：未列出的工具按字典序插入占位处——跨机器确定性，工具列表不因注册顺序漂移。

ScopedLayers 机制让 per-agent 注册 shadow 全局同名条目（见插件系统文档 §4）。

## Runtime context：快照而非流水

时间、工作目录这类易变信息不走 system prompt（那会破坏 KV cache 前缀），而是走 `RuntimeContextProjection`（`packages/core/agent-loop/src/runtime-context.ts`）：

- 只在快照**变化时**生成一条 user 消息，前缀为 `"Current runtime context. This snapshot supersedes earlier runtime-context snapshots."`——模型的语义约定是「以最新快照为准」；
- 投影监听 surface replace 事件：被 compaction 遮蔽的快照清除 retained 状态，避免压缩后重复注入。

具体来源是 `packages/context/` 下的一组小插件：`time-context`（请求时标，挂 `agent/pre-step`，带 `refreshIntervalMs` 节流）、`agent-instructions`（把 AGENTS.md 类文件作为 `<system-reminder>` 注入）、`tmux-context`、`session-reference`。每个都是一个普通插件——上下文工程也是组合出来的。

## Compaction：日志上的追加事务

`packages/compaction` 是能力接缝：`CompactionEngine` 抽象服务（`compactIfNeeded` / `compactNow` / `compactRegion` 三方法），`compaction-basic` 是默认 provider。

**触发路径有两条**：

1. `agent/pre-step` 上的 token 压力检查（`compactIfNeeded('pressure')`）；
2. `agent/request-error` 上的 context-overflow 自愈——provider 确认超窗时即使低于阈值也强制压缩（`compactIfNeeded('context-overflow')`）。模型报错信号直接驱动压缩，形成闭环。

**事务协议**（`compaction-basic/src/region.ts`）：

```text
compaction/start        ← 标记即锁，期间拒绝新 turn
LLM 摘要调用
compaction/summary      ← 记录 shadowedRange/shadowedSeqs/token 数
user/message 落位       ← 携带 surfaceOp: { op: 'replace', start, end }
compaction/end
```

- span 在压缩期间变化则**拒绝提交**（region.ts:413）——压缩是对一个不变区间的操作，不与并发写入竞态；
- 手动 `compactNow` 走 `runMaintenance`，与 turn 严格串行（maintenance 相位）；
- 压缩边界必须 tool-pairing balanced（assistant 的 tool-call 与其 result 成对），否则投影出的历史对 API 非法。

**KV-cache 亲和**：`buildSummarizationInput` 重建「系统提示 + 工具 + 被遮蔽区间消息」的真实请求前缀——摘要调用是对话的真前缀，直接命中 provider 的 KV cache。这把压缩从「一次额外的昂贵调用」变成「复用已算过的前缀」。

## LLM 适配层的上下文相关设计

`packages/llm` 的几处设计直接服务上下文工程：

- `StreamChunk` 词汇（`block-start`/`text-delta`/`reasoning-delta`/`tool-call-delta`/`block-end`/`usage`/`finish`）即持久化词汇——chunk 直接入日志，回放免费；
- `TokenUsage` 计数互斥：`inputTokens` 仅未缓存输入，cache read/write 单列——为 KV-cache 计费而设计的账本；
- `llm/stream` 的请求 deep-frozen + 标记：「其内容是 session 日志的纯函数，监听器只读不改写」；
- DeepSeek provider 是 transport-only：连接事实经 thunk 每次操作重读（配置热生效），bearer token 按请求解析且只能来自与端点同一次解析——「一次请求永远不会把一代的 URL 配上另一代的密钥」。

## 评价

dsh 的上下文工程有一个统一审美：**一切进入请求的内容都有来源、可投影、可回放**。system prompt 来自注册表装配而非模板拼接；runtime context 是带 supersede 语义的快照而非散落注入；压缩是事务而非编辑。对开发者而言最重要的推论是：想给模型加上下文，正确入口永远是「注册一个 section/context 源或发一个 session 事件」，而不是在循环里拼字符串——框架用不变量把错误路径封死了。
