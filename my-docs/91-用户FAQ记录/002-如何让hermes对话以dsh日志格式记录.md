# FAQ-002：如何让 hermes 对话以 dsh 日志格式记录？

- **分析时间**：2026-08-15
- **分析方法**：双仓库源码核对（dsh：`deepseek-harness`；hermes：`~/.hermes/hermes-agent`），关键结论均附文件路径/行号
- **需求原文**：工作中用 hermes 做通用任务、用 dsh 做编码，希望「在 dsh 中调用 hermes 进行对话」，且 hermes 的对话也以 dsh 的日志格式记录，实现统一日志归档

## 结论（TL;DR）

这件事**可行，而且有接近零代码的起步路径**。核心发现三个：

1. **hermes 自带 ACP 服务端**（`hermes acp`，`acp_adapter/`），**dsh 自带通用 ACP 子代理 provider**（`@deepseek-ai/dsh-subagent-acp`，`command`/`args` 可配置）——两者可以直接对接，dsh 会话中自动记录 `tool/call` + `tool/result`，但只是**调用级粒度**（hermes 内部轮次不可见）。
2. **要 hermes 内部轮次的全保真记录**，需自写一个 `subagent-hermes` provider：消费 hermes ACP 的完整事件流（工具调用开始/完成、思考块、消息块），通过 `Session.append()` 重放进一个链接的子 dsh 会话。dsh 的 append 路径对插件完全开放，产生的日志是**真正可恢复的 dsh 会话**。
3. **如果你的真实用法是 hermes 独立运行（不经 dsh）**，则走 hermes 侧采集：hermes 插件钩子（`pre/post_llm_call`、`pre/post_tool_call`）实时翻译为 dsh 事件，或事后用 `hermes sessions export --format jsonl` 转换。hermes 的持久层保留了完整 transcript（含工具调用），重建是高可行的。

推荐路线见文末「推荐路径」。

## 需求拆解：两种解读

| 解读 | 场景 | 对应方案 |
|---|---|---|
| A（字面）：在 dsh 中调用 hermes 对话 | dsh 是宿主，hermes 作为被委派的外部 agent | 方案一 / 方案二 |
| B（动机）：hermes 独立使用，但日志统一归档为 dsh 格式 | hermes 是主力，dsh 格式只是存档格式 | 方案三 |

两种解读的工程落点完全不同，下文分别给出。

## 事实基础一：dsh 侧（日志格式与写入通道）

来源：`packages/core/session`、`packages/session/session-persistence-jsonl`、`packages/subagent`。

1. **日志即事件溯源**：`session.jsonl` 是 append-only 的 `SessionEvent` 流，LLM 消息历史是从日志**派生**的。信封 `{ type, seq, time, data, ignorable? }`（`packages/core/session/src/types.ts:404-436`），核心词汇含 `turn/start|end`、`user/message`、`assistant/message`、`tool/call`、`tool/result` 等（`types.ts:236-333`）。
2. **版本钉死为 0**：`SESSION_FORMAT_VERSION = 0`（`types.ts:56`），**无兼容性承诺**，后端加载时拒绝其他版本——直接手写文件需自担格式漂移风险。
3. **进程内 append 完全开放**：`Session.append(type, data)`（`packages/core/session/src/index.ts:604-655`）只校验 JSON 可序列化、surface 契约、无重入，**不校验写入者是不是 agent-loop**。任何持 `Session` 的插件都能追加 `user/message` / `assistant/message` / `tool/call` / `tool/result`。
4. **未知事件类型是地雷**：读取方遇到不带 `ignorable: true` 的未知事件类型会**拒绝整份日志**；而 `Session.append` 不暴露 `ignorable` 字段，仓库外注册事件类型的机制「推迟到有消费者再做」（`packages/core/session/src/known-event-types.ts:8-18`）。**结论：重放时只用核心事件类型，不要自定义 `hermes/*` 类型。**
5. **wire 层没有注入通道**：SDK 的 JSON-RPC 只有 `initialize` / `session/prompt` / `shutdown` 三个请求（`packages/sdk/protocol/src/types.ts:100-105`），事件仅从 server→client 单向通知；ACP server 同理。**不存在从外部进程向 dsh 会话追加事件的 RPC。**
6. **subagent 现成模式**：`packages/subagent/` 是完整能力缝。进程外 provider（`subagent-acp`、`subagent-claude-code`、`subagent-codex`）spawn 真实外部进程，父会话只记 `tool/call`（任务参数）+ `tool/result`（最终文本），**子代理内部轮次不进父日志**（`subagent-claude-code/src/run.ts:112-127`；`examples/headless-agent/README.md:18`）。进程内 provider 则给子代理建独立 dsh 会话，header 带 `parentSession` 链接——这是「外部 transcript 落成一等 dsh 会话」的模板。
7. **`subagent-acp` 是通用的**：`command` 必填、`args` 可配（`packages/subagent/subagent-acp/README.md:27-46`），不绑定特定子代理实现。其已知限制：只收集 `agent_message_chunk` 文本，推理/工具活动等留在子会话日志、不在 ACP 上发出（README:99）。

## 事实基础二：hermes 侧（可观测面）

来源：`~/.hermes/hermes-agent`（`acp_adapter/`、`hermes_cli/plugins.py`、`hermes_state*.py`）。

1. **消息模型就是 OpenAI 格式**：`{"role": "system|user|assistant|tool", ...}`，assistant 消息带 `tool_calls`，工具结果是 `role="tool"` 消息（`run_agent.py:2230-2251`）。与 dsh 事件词汇存在自然的机械映射。
2. **ACP 服务端流式输出完整**：`hermes acp`（`acp_adapter/entry.py`）通过 stdio JSON-RPC 说 Agent Client Protocol；`acp_adapter/events.py` 发出 `ToolCallStart`（`:114-182`）、思考块（`:189-202`）、工具完成更新（`:209-259`）、`agent_message_chunk` 文本增量（`:266-279`）。**ACP 客户端能实时看到完整轮次流。**
3. **插件钩子系统是最强观测点**（`hermes_cli/plugins.py:156-382` `VALID_HOOKS`）：`pre_llm_call`（带完整 `conversation_history`，`agent/turn_context.py:1163-1180`）、`post_llm_call`（`agent/turn_finalizer.py:577-596`）、`pre/post_tool_call`（带 tool 名+参数+结果+`session_id`/`turn_id`/`tool_call_id`，`model_tools.py:1116-1167,1362-1375`）、`on_stream_start/delta/end`。插件放 `~/.hermes/plugins/` 即在 CLI/gateway/ACP/TUI 所有进程生效；官方 langfuse/nemo_relay 观测插件就是同构先例。
4. **持久层可完整重建 transcript**：SQLite `~/.hermes/state.db` 的 `messages` 表（`hermes_state_common.py:318-342`）有序保存 role、content、`tool_calls` JSON、`tool_call_id`、`tool_name`、`finish_reason` 及 `api_content`（线上字节保真 sidecar）；`hermes sessions export --format jsonl`（`hermes_cli/session_export.py:41-60`）现成导出，`export_session_lineage`（`hermes_state_portability.py:274-292`）能拼接压缩链。
5. **已知缺口**（决定保真度上限）：流式 delta 不持久化（只有最终消息行）；多模态工具结果只存文本摘要（`run_agent.py:2216-2229`）；compaction 会重写历史（需走 lineage 拿真实历史）。

## 方案对比

### 方案一：复用 `subagent-acp` 直接对接 `hermes acp`（解读 A，最低成本）

cordis.yml 加一段配置即可，零新代码：

```yaml
- id: subagent-acp
  name: '@deepseek-ai/dsh-subagent-acp'
  config:
    providerName: hermes
    command: hermes
    args: ['acp']
    permission: reject  # 或 allow，hermes 的审批提示会被自动应答
```

- **得到**：dsh 会话中 `tool/call`（委派给 hermes 的任务）+ `tool/result`（hermes 最终回答文本），随 dsh 日志天然落盘、可回放、compaction 安全。
- **失去**：hermes 内部轮次（它自己的 LLM 往返、工具调用、推理）在 dsh 日志中不可见——与现有 claude-code/codex 子代理同款限制（`subagent-acp/README.md:99` 明确只收集 `agent_message_chunk`）。
- **风险**：hermes 的 ACP 实现与 dsh ACP 客户端的握手兼容性未经实测（权限请求、能力声明细节）；需要一次真实联调验证。
- **工作量**：极小（配置 + 联调）。

### 方案二：自写 `subagent-hermes` provider，全保真重放进子 dsh 会话（解读 A，全保真）

仿照 `subagent-claude-code` 结构写 provider，但不只收最终文本，而是消费 hermes ACP 的完整事件流（`ToolCallStart`→工具完成更新、`agent_thought_chunk`、`agent_message_chunk`），同时：

1. 为每次委派建一个子 dsh 会话（header 带 `parentSession` 链接 + `origin: 'subagent'`，仿进程内 subagent 模式，`packages/core/session/src/types.ts:74-91`）；
2. 把 hermes 事件翻译为核心事件类型，经 `session.append()` 重放：`turn/start` → `user/message`（surfaceOp append）→ `assistant/message`（带 usage）→ `tool/call` / `tool/result` → `turn/end`。

- **得到**：hermes 每轮对话成为一份**真正可查询、可恢复的 dsh 会话日志**，与 dsh 自身编码会话同构——这是「统一日志」的完全体。
- **硬约束**：只用核心事件类型（见事实基础一.4）；遵守 surface metadata 要求；注意「模型可见 ⟺ 已落日志」是双向的——若之后用 dsh 恢复该子会话，重放的 hermes 轮次会进入发给 DeepSeek 模型的历史。
- **工作量**：中（一个新包 + 事件翻译层 + 快照/回放测试）。

### 方案三：hermes 独立使用，日志统一归档为 dsh 格式（解读 B）

**3a 实时采集（推荐形态）**：写一个 `~/.hermes/plugins/dsh-recorder` hermes 插件，挂 `pre/post_llm_call`、`pre/post_tool_call` 钩子（相关性 ID 现成：`session_id`/`turn_id`/`tool_call_id`），把每个事件翻译为 dsh `SessionEvent` 追加到目标 `session.jsonl`。先例：langfuse/nemo_relay 插件做的就是同构工作。

- 痛点：直接写 dsh JSONL 文件绕过了 dsh 的全部校验（seq 连续性、header、surface 契约需自行保证，`format.ts:272-378` 的 `SessionLogScanner` 会在加载时检查），且 `SESSION_FORMAT_VERSION=0` 无兼容承诺，dsh 升级可能破坏读取。

**3b 事后转换（最稳起步，已经过实测验证 ✅）**：直读 `~/.hermes/state.db`（只读）→ 独立 Python/TS 转换器 → dsh `session.jsonl` + sidecar。实测验证报告见 [002-附件-hermes日志转换dsh格式的实测验证.md](002-附件-hermes日志转换dsh格式的实测验证.md)（抽样 6 类来源、3,155 条消息，消息体映射语义无损）。

- 优点：不侵入任何运行时，hermes/dsh 各自升级互不影响，转换器是唯一耦合点。
- 缺点：非实时。
- 实测修正（详见附件）：`hermes sessions export` 默认丢弃 inactive/compacted 行，只能用于快速原型，归档级必须直读 DB；per-step usage hermes 未持久化（dsh `usage` 只能留空）；dsh `SessionHeader` 封闭，hermes 会话级元数据须放 sidecar。

### 方案四：经 dsh SDK / ACP 从外部注入事件 —— 不可行

dsh 的 wire 协议没有 append 动词（事实基础一.5）。要让外部进程写入，只能加一个自定义插件暴露 append RPC——但那本质上是把方案二/三的写入点搬进 dsh 进程，复杂度高于直接做方案二，不推荐作为起点。

### 对比总表

| 维度 | 方案一 subagent-acp | 方案二 全保真 provider | 方案三a hermes 插件 | 方案三b 事后转换 |
|---|---|---|---|---|
| 匹配解读 | A | A | B | B |
| 日志粒度 | 调用级（call+result） | hermes 内部轮次全量 | hermes 内部轮次全量 | hermes 内部轮次全量 |
| 实时性 | 实时 | 实时 | 实时 | 事后 |
| 新代码量 | ≈0（配置） | 中（一个 provider 包） | 中（一个 hermes 插件） | 小（一个转换脚本） |
| 绕过 dsh 校验 | 否 | 否（走 `Session.append`） | 是（直写文件） | 是（直写文件） |
| 版本 0 格式漂移风险 | 无 | 低（进程内 API） | 高 | 高 |
| 主要风险 | ACP 握手兼容性 | 事件翻译的正确性 | 双写一致性 | 无（离线） |

## 推荐路径

**用户已选定方案三（2026-08-15）**：无论 hermes 如何使用，只要能把 hermes 现有会话日志无损转换到 dsh 统一格式。方案三 b（事后转换）已通过生产库实测验证，报告见 [002-附件](002-附件-hermes日志转换dsh格式的实测验证.md)；方案一/二保留为未来「在 dsh 内统一入口」时的备选。

1. ~~先做方案一~~ → **做方案三 b 转换器**：直读 `state.db`（只读），按附件「转换器设计要点」合成 dsh 事件 + sidecar；首版 inactive 行进 sidecar，不做 `surfaceOp: replace`。
2. 转换器自测对照 `format.ts` 的校验逻辑（header、seq 连续、版本 0），降低版本 0 格式漂移的爆雷面；dsh 侧可用 `session-persistence-jsonl` 的 `SessionLogScanner` 做加载冒烟验证。
3. 坚持只用 dsh 核心事件类型；hermes 会话 id → dsh 会话 id 的对照写入 sidecar 与 header `parentSession`，便于双向追溯。
4. 若日后有实时需求，再评估方案三 a（hermes 插件钩子实时翻译）。
