# FAQ-002-附件：hermes 日志 → dsh 格式无损转换的实测验证报告

- **验证时间**：2026-08-15
- **验证环境**：hermes 生产库 `~/.hermes/state.db`（1.6 GB，913 个会话，105,278 条消息）；dsh 源码 `deepseek-harness`（wkj-dev 分支）
- **验证方法**：`hermes sessions export --format jsonl` 导出 + `sqlite3` 只读直查 DB 逐字段比对 + dsh 事件类型定义核对；主文档见 [002-如何让hermes对话以dsh日志格式记录.md](002-如何让hermes对话以dsh日志格式记录.md)

## 结论（TL;DR）

**消息体层面（user/assistant/tool 的内容、工具调用配对、推理内容、时间戳、排序）可以做到语义无损转换**，全部 3,155 条抽样消息验证通过。但「无损」有三个前提条件和三类固有缺口，转换器设计必须照单处理：

**必须处理的三个坑**（不处理就有损或产出不合法）：

1. **`hermes sessions export` 默认丢弃 inactive/compacted 行**——导出的是「当前视图」，不是全量历史。归档级转换必须直读 DB 或调 Python API `get_messages(sid, include_inactive=True)`。
2. **dsh `SessionHeader` 是封闭结构**（仅 `type/version/id/createdAt/cwd/parentSession/seedLength/origin/delegationDepth/agentPreset`），hermes 的会话级元数据（模型、聚合 token、成本、标题、source）**在 dsh 日志内没有合法容器**——须放 sidecar 文件，否则会话级信息有损。
3. **排序必须按消息 `id`（AUTOINCREMENT），不能按 `timestamp`**——实测存在 -2,480 秒的时钟回退对；hermes 自己的读取路径也是按 id 排序（`hermes_state.py:8866-8872`，WSL2 时钟回退教训，commit c03acca50）。

**三类固有缺口**（hermes 侧从未持久化，非转换缺陷，任何方案都拿不回）：

- 流式 delta（token 级增量）——hermes 只落最终消息行，dsh 的 `assistant/chunk` 事件无法合成；
- **每步 TokenUsage**——全库 assistant 消息的 `token_count` 全为 NULL，usage 只有会话×模型级聚合（`session_model_usage` 表），dsh `assistant/message.usage` 只能留空；
- 多模态工具结果原图——hermes 落库时已是文本摘要（`run_agent.py:2216-2229`）。

## 样本集

| 标签 | session id | source | 消息数 | 工具调用 | 选取理由 |
|---|---|---|---|---|---|
| cli-large | `20260621_090519_1a5f35` | cli | 1,902 | 820 | 最大 CLI 会话，长程工具密集 |
| acp | `def6d8bb-…-f9bc2` | acp | 293 | 133 | ACP 通道（与方案一/二同通道） |
| feishu | `20260702_044556_b124dbd0` | feishu | 323 | 154 | 消息网关来源，含 session_meta |
| subagent | `20260812_094405_274527` | subagent | 206 | 147 | 子代理会话（含 parent 链接） |
| cron | `cron_1be2196b5724_…` | cron | 94 | 52 | 定时任务来源 |
| api-content | `20260804_170850_943924` | cli | 1,513（导出 540） | 671 | 含 `api_content`，且 973 行被压缩 |

全库会话类型分布：cli 473 / cron 194 / acp 74 / subagent 66 / feishu 49 / wecom 49 / tui 4 / weixin 3 / desktop 1。样本覆盖了消息量前 6 的来源。

## 验证证据

### 1. 导出与 DB 的一致性（导出工具本身可信）

6 个单会话样本导出行数与 DB 行数完全一致；唯一字段差异是 `tool_calls` 在导出端由 JSON 字符串反序列化为对象——对 cli-large 全部 773 条做语义比对，**语义相等 773 / 语义差异 0**。即导出无信息损失，仅序列化形态变化。

例外见下一条。

### 2. 导出丢 inactive/compacted 行（关键坑）

api-content 样本：DB 实有 1,513 行，导出只有 540 行——**973 行 inactive（=compacted）行被过滤**。根因：`export_session` 调 `get_messages(session_id)` 时 `include_inactive` 默认 `False`（`hermes_state_portability.py:266-272` → `hermes_state.py:8856-8896`）。全库含 compacted 行的会话有 12 个，inactive 行共 8,390 行（含 rewind 软删除历史，有审计价值）。

**转换器必须直读 DB（`SELECT * FROM messages … ORDER BY id`）或用 Python API `include_inactive=True`**，并在 dsh 侧用 `surfaceOp: { op: 'replace' }` 表达压缩遮蔽关系，或将 inactive 行单独归档。

### 3. 工具调用结构完整可拆

全部 6 个样本：assistant 消息的 `tool_calls` 条目（共 1,497 条）**100% 含 `id`（→ dsh `callId`），`arguments` 100% 为字符串**（→ dsh `tool/call.arguments` 要求的「模型产出的原始 JSON 字符串」，恰好同构）。零解析异常。

### 4. tool/call ↔ tool/result 配对完整

全部样本：tool 结果行 100% 含 `tool_call_id`，**孤儿结果（无对应 call）= 0，无结果的 call = 0**。配对关系可无损重建（`tool/result` 的 `ToolResultBlock.toolCallId`）。

### 5. 角色覆盖与特殊行

- 出现的角色仅 `user / assistant / tool / session_meta`（全库另有 68 行 session_meta）。system prompt 不在 messages 表，在 `sessions.system_prompt`——正好对应 dsh 的 `request/header` 事件。
- `session_meta` 行是展示层占位（抽查 content 为字面量 `'None'`），非模型可见内容，转换时可安全丢弃（建议记进 sidecar 备查）。
- 空 assistant（无 content 且无 tool_calls）= 0；连续 user 消息存在（最多样本中 6 对）——合成 turn 边界时「连续 user 归同一 turn」即可。

### 6. usage 粒度缺口（固有）

全部样本的 assistant 消息 `token_count` 均为 NULL；usage 仅有会话级聚合（`sessions.input_tokens/output_tokens/cache_read_tokens/reasoning_tokens`）和 `session_model_usage` 表（会话×模型维度，997 行）。**dsh `assistant/message.usage`（每步 TokenUsage）无法重建，只能省略**（dsh 类型上 `usage` 本就可选，`types.ts:273`）。会话级聚合可进 sidecar。

### 7. 时间戳与排序

- hermes `timestamp` 为 REAL 秒（含小数），×1000 得 dsh 的毫秒 `time`，无精度问题。
- api-content 样本发现 1 对时间戳倒序（id 102529 → 102530，回退 -2,480 秒）：**seq 必须按 `id` 递增生成，`time` 允许非单调**（dsh 信封只校验 seq 连续，`SessionLogScanner`，`format.ts:272-378`）。

### 8. reasoning 与 finish_reason 可保留

- `reasoning_content` 在样本中大量存在（cli-large 833/919 条 assistant 消息），dsh `ContentBlockMap` 有 `reasoning` 块（`packages/llm/llm/src/types.ts:60-63`）——**推理内容可无损映射为 ReasoningBlock**。
- `finish_reason` 分布为 `tool_calls` / `stop` 两类，dsh `FinishReasonMap` 有同名成员（`types.ts:116-118`），可保留在消息或事件中。

### 9. api_content 是纯文本 sidecar（小众字段）

`api_content` **不是 JSON**，是纯文本的「线上实际发送内容」留痕（抽查：一条为中断响应标注 `[This response was interrupted by a user correction.]`）。全库仅 559/105,278 行（0.5%）携带。dsh 核心事件无对应容器——建议进 sidecar，或接受这 0.5% 行的该字段损失。

## 逐字段映射表（验证后的最终映射）

| hermes `messages` 列 | dsh 去向 | 验证结论 |
|---|---|---|
| `id`（AUTOINCREMENT） | 排序依据 → `seq` 递增 | ✅ 单调，全库可信 |
| `timestamp`（REAL 秒） | `time`（×1000 毫秒） | ✅ 可非单调 |
| `role=user` + `content` | `user/message`（TextBlock，surfaceOp append） | ✅ |
| `role=assistant` + `content` | `assistant/message`（TextBlock） | ✅ |
| `reasoning_content` | `assistant/message` 的 ReasoningBlock | ✅ dsh 有原生块类型 |
| `tool_calls`（JSON 字符串） | 每条拆一个 `tool/call`（`id`→callId，`arguments` 原样） | ✅ 1,497 条全含 id、arguments 全为字符串 |
| `role=tool` + `tool_call_id` + `content` | `tool/result`（ToolResultBlock） | ✅ 配对零孤儿 |
| `tool_name` | `tool/result.meta`（JsonValue 自由槽） | ✅ 可保留 |
| `finish_reason` | `assistant/message` 消息/事件保留 | ✅ 值域同构 |
| `token_count` | （dsh `usage`） | ❌ 全库 NULL，固有缺口 |
| `api_content` | sidecar | ⚠️ 0.5% 行，纯文本，核心事件无容器 |
| `active` / `compacted` | 过滤 / `surfaceOp: replace` / 单独归档 | ⚠️ 转换器须显式决策 |
| `session_meta` 行 | 丢弃（记 sidecar） | ✅ 非模型可见 |
| `sessions.*`（model、聚合 tokens、成本、title、source、cwd、git） | header 的 `cwd`/`parentSession` + sidecar | ⚠️ header 封闭，大部分进 sidecar |

## 转换器设计要点（据验证结论修正）

1. **数据源**：直读 `state.db`（只读 URI `mode=ro`），`ORDER BY id`；不要用 `hermes sessions export` 作为归档数据源（丢 inactive 行）。
2. **事件合成**：user 消息开 `turn/start`（连续 user 归同一 turn）；每条 assistant 消息开 `step/start`，其 `tool_calls` 逐条发 `tool/call`，后续 tool 行发 `tool/result`，`step/end` 收尾、`turn/end` 收官。边界是合成的，但消息内容零改动。
3. **压缩/回退历史**：`active=1` 行进主流派生面（surfaceOp append）；`active=0` 行两种处理——严格派生用 `surfaceOp: replace` 表达遮蔽（需维护 surface 节点编号），简单归档则写入后标记或进 sidecar。建议首版选后者。
4. **sidecar**：每个转换出的 dsh 会话旁边放一个 `hermes-sidecar.json`，存 hermes session 行全量字段 + session_model_usage 聚合 + api_content 映射 + 被丢弃的 session_meta——保证「dsh 日志 + sidecar = hermes 原始记录 100%」。
5. **session id 映射**：hermes session id → dsh session id 对照表写入 sidecar 与 dsh 会话 header 的 `parentSession`（subagent 样本天然有父子链，可直接链接）。
6. **只用核心事件类型**：不自定义 `hermes/*` 事件（原因见 002 正文「事实基础一.4」），hermes 特有信息一律走 `meta` 槽或 sidecar。

## 对 002 正文结论的修正

- 正文方案三 b「用 `hermes sessions export` 作为数据源」**降级为仅适用于快速原型**；归档级实现按本附件「数据源」条改为直读 DB。
- 正文称「hermes 持久层信息无损（除 delta）」需补充：per-step usage 同样不可恢复（本附件证据 6）。
- 其余结论（映射可行性、核心类型约束、双向往意）经实测确认不变。
