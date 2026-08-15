# 会话日志与事件溯源

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

本文分析 dsh 的数据基石：append-only session log 及其投影机制。这是整个架构中杠杆率最高的设计——持久化、模型历史、回放测试、fork/resume、审计全部由此派生。

## 事件模型

`SessionEvent` 是判别联合（`packages/core/session/src/types.ts:404-436`）：每个事件带 `type`、`seq`、`time`、`data`，`switch (event.type)` 无需 cast 即可窄化 `data`。核心事件类型：

- 循环骨架：`turn/start`、`turn/end`、`step/start`、`step/end`；
- 内容：`user/message`、`assistant/chunk`（token 级原始流）、`assistant/message`（携带 `usage` 和 `sourceEventSeqs` 回溯到 chunk）；
- 工具：`tool/call`、`tool/result`（携带可选 `meta` 展示负载）；
- 请求锚点：`request/header`、`request/context`；
- 其他域：`todo/write`、`session/end-seed`（fork 种子边界）、`approval/*`、`hook/*`、`compaction/*` 等。

`TurnEndReason` 含 `interrupted` 变体：**持久化后端重载时以该理由关闭崩溃遗留的 open turn**——崩溃不是异常路径，是日志格式内的一等语义。

## 版本策略：fail-closed

- `SESSION_FORMAT_VERSION = 0`：单一单调整数，pre-release 阶段无兼容性承诺，结构性格式变化才 bump；
- 逐事件的 `ignorable: true` 保护普通新增事件类型；**默认 required-on-read**：不识别的事件类型必须拒绝重构日志，而不是静默丢弃；
- SQLite 后端的 `SCHEMA_VERSION = 15` 与事件格式版本正交（存储 schema 与语义格式分开演进）。

对比同类产品的 transcript 处理（遇到未知行跳过），这是更严格但更安全的阅读策略：旧版本宁可拒绝打开新会话，也不丢数据。

## Surface 投影：一份日志，两个视图

`packages/core/session/src/surface.ts` 定义了模型可见 surface 的规则：

- 只有三类事件可进入模型历史：`user/message`、`assistant/message`、`tool/result`；
- `SurfaceOp = 'append' | { op: 'replace', start, end }`——replace 节点是 compaction 的载体；
- `deriveEventMessage()` 是唯一投影规则，verbatim 透传不做 envelope 包装。

关键设计区分：**append 起源的事件是人类 transcript 的 durable 来源，replace 节点只存在于模型侧**。压缩历史遮蔽的是模型视图，人类可见记录永远不被篡改。

`deriveMessages()`（`core/session/src/index.ts:726-747`）做增量缓存：surface 的 `replaceGeneration` 不变则只处理新增节点（O(新节点)），compaction 触发 replace 时整体重建。

## 持久化

双后端同一语义：

- **SQLite**（`session/session-persistence-sqlite`）：WAL 默认，`events` 表 1:1 映射 SessionEvent（含 `source_event_seqs`、`surface_op`、`ignorable` 列），application_id 防误写；`scanRows()` 实现 **torn-tail 容忍**——最后一个 `turn/end` 之后的 seq 空洞/坏行视为崩溃截尾做物理修复，之前的则是 corruption 拒绝加载。turn 边界即 commit 边界的原则在这里落成存储语义；
- **JSONL**（`session/session-persistence-jsonl`）：zstd 压缩，处理 win32 路径；
- 协调层 `session-persistence`：write-behind 批量写 + projection cache 检查点。

## Fork 与 Resume

`SessionStore.fork(source, boundary?, childSessionId?)`（`core/session/src/index.ts:1081-1138`）：

- boundary 必须是存在的连续 seq，且**不得落在 open turn 内**（`OPEN_TURN` 错误码）——fork 出的子会话必须能被合法回放；
- 种子复制进 child，`SessionHeader` 记录 `parentSession` + `seedLength`（durable fork 谱系），构造器追加 `session/end-seed` 事件区分种子历史与 live 工作；
- resume 即冷载全量日志，首个请求以 `reason: 'resume'` 重锚 `request/header`。

## Inbox 与 Turn 的咬合

输入经单一 inbox 进入驱动（`@deepseek-ai/dsh-agent`），分三类：`followup`（下一 turn + 唤醒）、`steer`（当前 turn 的下一 step + 唤醒）、`inject`（下一 step，不唤醒——注入的上下文等下一条消息顺带带入）。`agent/pre-step` waterfall 可改写或拒绝 claim 到的消息；被拒绝的首次 claim 仍关闭一个「零 step 的 durable turn」——**日志记录这次尝试**，拒绝不是静默消失。

agent-loop 用 `Phase = idle | maintenance | running` 相位机 + 每相位独立 `AbortController` 消除取消竞态；compaction 等运维操作在 maintenance 相位串行执行。`turn/end` 在 `finally` 中提交——每个出口都写入 turn 结局。

## 工具调度的日志合法性

`packages/core/agent-loop/src/tool-calls.ts` 的调度契约值得单独记录：dispatch 可重叠（parallel 组滚动池），但 policy/result/context **严格按模型给出的顺序提交**；abort 时未启动的调用写入合成 error result（`TOOL_ABORTED_BEFORE_DISPATCH`）保证 replay 合法，已启动的不伪造结果（「started promise reaches quiescence before its outcome becomes ABORTED」）。

## 评价

这个子系统回答了一个所有 agent 产品都绕不开的问题：「模型看到的东西从哪来」。dsh 的答案是**从一份 append-only 日志投影，且没有第二份事实**。代价是所有模型可见输入都必须先定义成事件类型（扩展成本高一步）；收益是崩溃恢复、回放、审计、fork 全部免费且互相一致。对需要合规审计或严肃测试的产品形态，这是正确的地基。
