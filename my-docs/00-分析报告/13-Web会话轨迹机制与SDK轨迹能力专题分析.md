# Web 会话轨迹机制与 SDK 轨迹能力专题分析

> 分析日期：2026-08-17（基于 wkj-dev 分支，upstream/master = 47f943859b）
> 关联报告：《06-会话日志与事件溯源》（事件模型基线）、《12-SDK详尽说明书》（SDK 协议基线）
> 核心问题：Web 版会话"轨迹"（trajectory）如何产生、存储、渲染？SDK 使用时轨迹基础数据是否自动按标准存储，能否支撑自研轨迹渲染？

---

## 0. 结论速览

1. **dsh 的轨迹 = append-only session log**。没有独立的"轨迹存储"——轨迹就是会话日志本身：每个 turn/step/消息/工具调用/token 流都是日志中的一个事件，seq 单调连续、无损 JSON。这是架构公理「model-visible ⟺ logged」的直接产物：凡是到达模型请求的东西必须能从会话日志重构。
2. **存储自动且标准化**：持久化插件（JSONL 或 SQLite）把规范日志逐字节落盘。标准 SDK 组合（`examples/jsonrpc-agent/cordis.yml` 与 Python 零配置默认组合）**默认包含 JSONL 持久化**，所以用 SDK 时轨迹基础数据**会自动按标准格式存储**到 `DSH_SESSION_ROOT`。
3. **SDK 有两条轨迹数据通道**：实时通道（`session.event` 通知流，完整事件信封）+ 持久通道（运行时内持久化插件自动写 JSONL）。两者数据同源同格式。
4. **SDK 与 Web 的唯一实质差距**：Web 宿主网关会为 `tool/call`/`tool/result` 附带一个**不持久化**的渲染意图视图（`ToolEventView`）；SDK 协议只传原始事件。但工具自持的 `meta` 展示负载（如 fs 工具的 diff）在事件内、会持久化，自研渲染的信息基础完整。
5. **自研轨迹渲染完全可行**：离线解析 JSONL（注意 chunk 打包行与 zstd 编码两个格式点），或在线订阅 SDK 的 `session.event`。第 7 节给出完整开发指南。

---

## 1. 全景图：一条轨迹的完整旅程

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│ ① 数据源（运行时进程内）                                                            │
│   agent-loop 的每个动作 → Session.append() → append-only SessionEvent 日志        │
│   （turn/step 骨架、user/assistant 消息、token chunk、工具调用/结果、请求头快照…）       │
│                          │ ctx.emit('session/event')                             │
│                          ▼                                                        │
│ ② 持久化（自动）                     │                                             │
│   session-persistence 协调层 ──write-behind──▶ JSONL/SQLite 后端落盘               │
│   （checkpoint-policy 决定每次请求后的持久化检查点）                                   │
│                                                                                   │
│ ③a Web 链路                          │ ③b SDK 链路                                 │
│   host/apiproxy 网关                  │   dsh-sdk-jsonrpc-server 插件              │
│   ├─ session.history 分页读（冷/热）    │   └─ ctx.on('session/event')               │
│   └─ EventsApi.mux 流：                │      → session.event JSON-RPC 通知          │
│      session/event 帧 + ToolEventView  │      （完整信封，全部会话，无过滤）             │
│                          │             │                        │                  │
│                          ▼             │                        ▼                  │
│ ④a 浏览器 client-runtime              │ ④b SDK 调用方                              │
│   Session.events 原始事件窗口          │   订阅流 / RunResult.events                 │
│   → Definitions 状态机组装             │   （+ 运行时已自动落盘的 JSONL）              │
│   → ConversationSnapshot              │                                            │
│     ├─ Chat 视图（对话渲染）            │                                            │
│     └─ TrajectorySnapshot（轨迹视图）  │                                            │
│                          │             │                                            │
│                          ▼             │                                            │
│ ⑤a ui-trajectory 组件树渲染            │ ⑤b 自研渲染（数据基础完备，见 §7）             │
└─────────────────────────────────────────────────────────────────────────────────┘
```

以下按 ①→⑤ 由浅入深展开。

---

## 2. 第一层：数据源 —— SessionEvent 事件模型

> 源码：`packages/core/session/src/types.ts`

### 2.1 事件信封（envelope）

每条轨迹记录就是一个 `SessionEvent`，判别联合按 `type` 窄化 `data`：

```ts
{
  type: SessionEventType,      // 判别标签
  seq: number,                 // 会话内单调连续序号（轨迹的天然排序轴）
  time: number,                // Unix 毫秒时间戳（轨迹的时间轴）
  data: SessionEventMap[K],    // 类型化负载
  ignorable?: true,            // 读取方不认识该类型时可安全跳过的标记
  // 仅 surface 事件（user/message、assistant/message、tool/result）：
  sourceEventSeqs?: number[],  // 溯源：产生该事件的先前事件 seq（如 chunk → message）
  surfaceOp?: 'append' | { op: 'replace', start, end }  // 进入模型 surface 的方式
}
```

轨迹开发的三个关键事实：

- **`seq` + `time` 即轨迹坐标系**：seq 保证无损排序与缺口检测，time 提供时间轴（Web 的 Overview 时间线就靠它）；
- **`sourceEventSeqs` 是内建溯源链**：`assistant/message` 回溯到构建它的 `assistant/chunk` seq 集合；compaction 的 replace 节点引用被遮蔽的节点——轨迹的"因果箭头"不需要外部推导；
- **版本策略 fail-closed**：`SESSION_FORMAT_VERSION = 0`，不认识的必需事件类型**拒绝重构**而非静默丢弃（`ignorable: true` 除外）。自研解析器应保留同样立场。

### 2.2 事件类型目录（轨迹词汇表）

核心 `SessionEventMap`（插件可通过声明合并扩展）：

| 分类 | 事件类型 | 轨迹含义 |
|---|---|---|
| **turn/step 骨架** | `turn/start` `{turn}` | 轨迹分组边界：一个用户回合开始（Web 用粗分隔线渲染） |
| | `turn/end` `{turn, reason}` | 回合结束及原因（`completed`/`max-tokens`/`error`/`interrupted`…）；**turn 边界即持久化 commit 边界** |
| | `step/start` `{turn, step}` | 一步 = 一次模型调用 + 它请求的工具执行（Web 用紧凑行内标记渲染） |
| | `step/end` `{turn, step}` | 步结束 |
| **内容** | `user/message` | 用户消息（含三种来源：人类 prompt、`agent.inject()` 合成上下文、goal 延续轮；`source` 字段区分） |
| | `assistant/chunk` `{chunk}` | **token 级原始流**（回放保真度来源） |
| | `assistant/message` `{message, usage?}` | 一步的组装后 assistant 消息 + token 用量（usage 与输出同载，无独立 usage 记录） |
| **工具** | `tool/call` `{callId, name, arguments}` | 模型请求的工具调用；`arguments` 是模型原样的未解析 JSON 字符串；`callId` 配对结果 |
| | `tool/result` `{message, error?, meta?}` | 工具完成结果；`meta` 是工具私有展示负载（JSON 可序列化、追加时运行时校验），如 `dsh-tool-fs` 的上下文 diff |
| **请求锚点** | `request/header` `{header, reason}` | 下次请求的完整头（调用配置 + 系统提示 + 工具 schema）；`reason ∈ initial/resume/change`；log-only，最新快照重构请求头 |
| | `request/context` | provider/model 路由元数据（上下文窗口容量等），仅变化时记录 |
| **其他域** | `todo/write` | todo 全量快照（last-write-wins，log-only UI 状态） |
| | `session/end-seed` | fork/resume 种子历史与 live 工作的边界标记 |
| | 插件扩展 | `agent/inbox/*`（inbox 入队/splice）、`session/title`、`approval/*`、`hook/*`、`compaction/*`、subagent 事件等 |

### 2.3 Surface 投影：一份日志，两个视图

`surface.ts` 规定只有 `user/message`、`assistant/message`、`tool/result` 三类事件可进入**模型历史**；其余全部是 log-only（骨架、chunk、todo、请求头…）。compaction 用 `replace` 节点遮蔽模型视图，但**人类可见的完整日志永不被篡改**——这正是"轨迹永远比对话视图更完整"的结构性保证：你从日志渲染轨迹，天然能看到被压缩掉的原始历史。

---

## 3. 第二层：存储 —— 持久化格式与位置

> 源码：`packages/session/session-persistence-jsonl/src/format.ts`、`index.ts`；`packages/core/session/src/chunk-rows.ts`

### 3.1 目录布局（JSONL 后端）

```
<DSH_SESSION_ROOT>/
└── --Users-weikejia-CODE-project--/      ← projectKey(cwd)：项目路径人类可读编码（分隔符→'-'）
    └── session-abc123/                    ← encodeSegment(sessionId)：全 UTF-16 单射转义（防遍历/碰撞）
        └── session.jsonl.zstd             ← 事件日志（zstd 帧）；compression:'none' 时为 session.jsonl
```

- `root` 无默认值（必须显式配置），避免随进程 cwd 漂移散落；
- 无 cwd 的会话归入 `_no-cwd/`；
- 子代理会话是**独立文件**，通过 header 的 `parentSession` + `delegationDepth` 建立谱系。

### 3.2 文件格式

**第 1 行：会话头**（`type: 'session'` 记录）：

```json
{"type":"session","version":0,"id":"session-abc","createdAt":1755400000000,
 "cwd":"/abs/path","parentSession":"…","seedLength":42,"origin":"subagent",
 "delegationDepth":1,"agentPreset":"minimal"}
```

**后续行：事件**。每行是一个 `StorageRecord`，二选一：

1. **普通事件行**：`SessionEvent` 逐字节 JSON；
2. **chunk 打包行**（`packChunks` 默认开启，日志缩小约 60%）：连续 `assistant/chunk` delta 运行被打包为：
   - `{ type: 'text-chunks', seq0, time0, data: TextRunData }`
   - `{ type: 'reasoning-chunks', seq0, time0, data: TextRunData }`
   - `{ type: 'tool-call-chunks', seq0, time0, data: ToolCallRunData }`

   成员 `k` 重构为 seq `seq0 + k`；时间戳用差值编码（整数保证精确）。打包无损，读取与布局无关（`decodeStorageRecord` 统一解码）。

**物理编码**：默认 zstd（带校验和帧），`compression: 'none'` 为明文 JSONL（snapshot 回放模式即用此）。

### 3.3 写入与修复语义

- **write-behind 批量写**（协调层 `session-persistence`）+ `session-checkpoint-policy` 拥有每请求持久化检查点：loop 不在 turn 边界等待 flush，读取方在 `whenIdle()` 后自行 flush；
- **torn-tail 容忍**：最后一个 `turn/end` 之后的 seq 空洞/坏行视为崩溃截尾，物理修复（截断到安全偏移）；之前的损坏则拒绝加载。崩溃不是异常路径，是格式内一等语义（`turn/end` 的 `interrupted` 理由即持久化后端重载时关闭崩溃遗留 open turn 的标记）；
- **版本 fail-closed**：头部 `version` 与本构建 `SESSION_FORMAT_VERSION` 不符直接拒绝（提示升级 harness，而非误报损坏）。

### 3.4 其他存储面

| 组件 | 角色 | 是否轨迹主存储 |
|---|---|---|
| `session-persistence-sqlite` | SQLite 后端，`events` 表 1:1 映射 SessionEvent（WAL、application_id 防误写、同样的 torn-tail 扫描语义） | 是（与 JSONL 同语义双后端） |
| `session-query-sqlite` | 派生 FTS5 全文检索索引（`.sessions/session-query.db` 即此类），**一次性可重建**，绝不指向持久化数据库 | 否（查询加速层） |
| `session-projection(-cache)` | 水位线投影（标题、统计等派生值） | 否（派生缓存） |

---

## 4. 第三层：Web 数据链路 —— 从运行时到浏览器

> 源码：`packages/host/apiproxy/`（API 网关）、`packages/client/runtime/src/client/sessions/`

### 4.1 宿主网关（`dsh-host-apiproxy`）

Web 客户端不直接读存储，而是通过共享 API 网关。线缆是四象限判别联合（谁发起 × 请求/响应），与物理通道解耦：`ClientRequest`（POST `/api/<method>`）、`ServerResponse`、`ServerRequest`（SSE 帧）、`ClientResponse`（POST `/api/respond`）。

轨迹相关的两个核心接口（`EventsApi` + `SessionsApi`）：

#### 4.1.1 `session.history` —— 分页拉取原始事件

- 已 attach 的会话读内存，冷会话**直接经持久化后端检查日志**（不 resume、不发布 Agent）；
- 按 append 起源消息边界分页；`maxMessages` 只计以 append 进入 surface 的 user/assistant 消息，模型侧 replace 副本不耗配额；
- 每页保持一段**连续原始事件区间**（compaction 的 log-only `compaction/summary` 与引用它的 replace 同页）；
- 尾页额外携带 `projections` 块（标题等水位线投影快照）。

#### 4.1.2 `EventsApi.mux` —— 全会话聚合实时流

SSE 帧流，轨迹核心帧：

```ts
{ type: 'session/event', sessionId, event: SessionEvent, view?: ToolEventView }
```

**原始 SessionEvent 透传** —— 与持久化存储的是同一份信封。另有控制帧（`session/subscribed` 携带 lastSeq 供缺口修复）、审批/提问帧、`session/queue` 全量快照帧等。

#### 4.1.3 `ToolEventView`：不持久化的渲染意图

```ts
type ToolEventView =
  | { for: 'call';   view: ToolCallView }
  | { for: 'result'; view: ToolResultView }
```

关键契约：它是**发出时刻注册的 presenter 对 args/result 的纯派生**，永不持久化（会话日志只带事件）——同一事件在之后的投递中可能携带不同的 view（或没有）。缺省 view 时客户端用文档化默认（generic JSON 卡片）。工具的 UI 渲染意图（`generic`/`terminal`/`diff`、`locations`）是工具设计的一部分，presentation 方法是 args 的纯函数。

> 对轨迹自研的含义：渲染意图是可重算的派生值，不是数据缺口；而 `tool/result.meta`（工具自持展示负载）在事件内且持久化，才是不可再生的展示数据。

### 4.2 浏览器侧 client-runtime（`dsh-client-runtime`）

`Session` 类（`client/sessions/session.ts`）维护：

- `events: SessionEvent[]` —— **原始日志切片**（与持久化同格式），`views` 平行数组存 envelope 级 `ToolEventView`（不合并，保持 events 纯净：model-visible ⟺ logged）；
- `liveBuffer` —— open/resync 期间的实时事件缓冲，历史页落地后按 seq 缝合；缺口修复时实时事件绕行缓冲；
- `loadOlder()` 向前分页（历史回溯）；`installWindow()` 安装历史窗口；
- 上行帧 `{event, view}` 经 `acceptLiveEvent()` 追加。

### 4.3 对话节点组装（Definitions 状态机）

原始事件不直接渲染，而是经**事件 Definitions**（声明式事件状态机，`match`/`start`/`update` 生命周期）组装成业务记录：

- 组装结果分目标（target）：Chat 对话快照与 **Trajectory 目标**各自独立组装（不同视图对同一份事件的投影不同）；
- Trajectory 的贡献类型（`TrajectoryContribution`）：`node`（用户/上下文消息）、`assistant`（含 partial 流式态 + request 视图）、`tool`（工具调用树，含子工具）、`request-header`（系统提示/工具目录状态及变更）、`compaction`、`turn-end`、`session-end`；
- 取消冻结语义：Trajectory 目标保留已完成回复的组装块、计时与 usage；Chat 窗口保留原始 Events。

---

## 5. 第四层：Web 渲染 —— `ui-trajectory` 组件

> 源码：`packages/client/ui-trajectory/`；由 `packages/bundle/web-app/cordis.patch.yml` 挂载

### 5.1 插件形态与挂载

浏览器纯客户端插件（宿主侧 `apply()` 为空），`inject: ['slots', 'conversationEvents', 'conversationViews', 'sessions', 'locale']`；不定义服务、不声明 Context 合并；向会话的 `'conversation.view'` 插槽环注册**一个 tab**（插件卸载即移除 tab）+ 目标专属事件 Definitions + Trajectory 视图构建器。

### 5.2 UI 形态（轨迹台账）

按官方 README 的权威描述：

- **turn 感知事件台账**：可选的 User / Assistant / Tool / 嵌套 Subtool 记录；粗分隔线标 Turn 边界，紧凑行内标记标 Step；
- **主台账三列**：序号（`#N`）、事件、内容；选中打开本地检查器（token usage、时长、Input、Output、Timing）；
- **Overview 时间轴**：台账上方固定，左→右投影真实记录起始/时长；assistant 跨度拆分 TTFT 与解码段；悬停 500ms 显示精确时钟/时长；拖选区间聚焦该区间内活跃记录，滚轮缩放时间域，右键清除/平移；
- **虚拟滚动**：长台账从当前尾部打开，只挂载可见行窗口 + 少量 overscan；到达已加载范围顶部自动加载上一页旧记录；前向加载未就绪时首行控件可手动加载；流式 content-only 帧保留虚拟行键与高度、不重复写尾滚；向上滚动暂停跟随；
- **compaction 定位**：独立压缩请求按时间线放在自己的 `Between turns` 区；带编号的压缩留在所属 turn 内；
- **搜索/折叠/导航**：选中、时间线导航、折叠、搜索、Request 总量均覆盖当前已加载窗口；
- 进行中状态不编造：`partial`/`runningCalls` 行不虚构时长，Overview 只画起始标记。

### 5.3 组件清单与数据契约

| 文件 | 职责 |
|---|---|
| `trajectory-record.ts` | 记录数据契约 `TrajectoryCellProps` + 稳定身份 `trajectoryRecordId`（recordId → callId → sourceSeq → index 降级） |
| `trajectory-snapshot-builder.ts` | 从注册的视图节点组装 `TrajectorySnapshot`（eventNodes、requests、callSchemas、partial、runningCalls）；处理压缩中断/turn 错误 |
| `trajectory-*-definition.ts` | 事件 Definitions：assistant、tool、message（含 inbox 状态机）、compaction、request-header |
| `TrajectoryView.tsx` / `TrajectoryTable.tsx` / `TrajectoryCell.tsx` | 视图主体 / 虚拟台账 / 单元格 |
| `TrajectoryTurn(.tsx)` / `TrajectoryTurnHeader` / `TrajectoryGroupHeader` | turn 分组与标头 |
| `TrajectoryTimeline.tsx` / `timeline.ts` / `duration-store.ts` | Overview 时间轴与时长存储 |
| `TrajectoryToolbar.tsx` / `trajectory-search-index.ts` | 工具栏与搜索 |
| `trajectory-virtual-rows.ts` / `layout.ts` | 虚拟行与布局 |

记录类型闭集 `TrajectoryCellKind`：`system | user | context | compacted | message | tool | subtool`。每条记录携带：索引、稳定身份、文本摘要、`sourceSeq`（跨记录导航）、input/output/thinking 详情、sourceBlocks/outputBlocks（原始块保序）、schemaDetail（调用时刻工具 schema）、assistantMetrics（TTFT/解码计时与 token）、耗时/起始时间、input/cacheRead/cacheWrite/output/think token 计数等 —— **这就是从事件到可渲染轨迹记录的完整映射样板**。

### 5.4 会话日志导出（Web 侧轨迹归档面）

`GET /api/session.export?sessionId=…&includeDescendants=true`（宿主下载面，非 RPC）：

- 流式 ZIP，文件 = 每个会话**存储工件文本逐字节**（持久化后端 `readRaw` 的准确持久字节，非解析重构）；
- 根会话在顶层，子代理后代在 `subagents/<id>/`，引用的图片在 `media/<attachmentId>.<ext>`；
- 导出前对每个 live 会话穿越 `SessionStore.flush` 持久化屏障；fflate 流式压缩（级别 0–9 可配，默认 6）；
- 无持久化服务 → 500；后端无逐会话原始工件 → 501；根会话缺失 → 404；后代缺工件/图片不可读 → 流失败（fail-loud）。

---

## 6. SDK 轨迹能力分析（核心问题解答）

### 6.1 问题：用 SDK 时，轨迹基础数据会不会按标准自动存储？

**答案：会 —— 前提是 cordis.yml 组合包含持久化插件（标准组合默认包含）。** 机制拆解：

1. SDK 服务端（`dsh-sdk-jsonrpc-server`）创建的每个会话就是标准 harness Session，走同一条 `Session.append()` → `session/event` → 持久化链路；SDK 不改变也不绕过任何日志语义；
2. `examples/jsonrpc-agent/cordis.yml`（TS/Python 自定义组合模板）已含：`dsh-session-persistence-jsonl`（root = `DSH_SESSION_ROOT` ?? `./.sessions`）+ `session-checkpoint-policy`；Python 零配置默认组合（`deepseek-harness-runtime-bin` 入库 `runtime/cordis.yml`）同样包含 JSONL 持久化 + checkpoint 策略；
3. 因此每次 `harness.run()` 结束后，轨迹（含 token 级 chunk、工具调用、请求头快照、用量）已按 §3 的标准 JSONL 格式落盘，目录结构、文件格式、谱系头与 Web 版完全一致。

验证路径：SDK 会话头记录 `initialize.cwd`，所以会话会按你的工作区 cwd 归组到 `DSH_SESSION_ROOT` 下对应项目目录。

### 6.2 SDK 的两条轨迹数据通道

| 通道 | 载体 | 内容 | 适用 |
|---|---|---|---|
| **实时流** | `session.event` JSON-RPC 通知 | 完整 `SessionEvent` 信封；运行时内**所有会话**（含子代理）无过滤推送，线缆顺序 | 在线轨迹监控/自渲染；`subscribeSessionTree(id)` 客户端侧按谱系过滤 |
| **持久存储** | 运行时内持久化插件自动写 JSONL | 规范日志逐字节（含打包行/zstd） | 离线分析/回放/自渲染数据源；进程退出后仍在 |

高层 API 的补充面：

- `RunResult.events`（TS/Python）：活动区间内 root 会话事件，按线缆顺序；`RunResult.notifications`：含发现的后代会话通知；
- Python 额外提供 `finish_reason`（最后一个 `turn/end` 的 kind）；
- 低层 `prompt()` 只返回入队回执，自建观察区间时需自行订阅。

### 6.3 SDK 通道 vs Web 链路：能力对照

| 能力 | Web | SDK | 说明 |
|---|---|---|---|
| 原始事件流（含信封全字段） | ✅ mux `session/event` | ✅ `session.event` | 同源同格式 |
| `ToolEventView` 渲染意图 | ✅ 随帧附带 | ❌ 协议不含 | 纯派生值，可用工具 presenter 重算；不影响数据完整性 |
| 工具 `meta` 展示负载（如 diff） | ✅ | ✅ | 在 `tool/result` 事件内，两通道都有且都持久化 |
| 分页历史读（session.history） | ✅ | ❌ 协议无 | SDK 用 JSONL 文件离线读替代 |
| 会话搜索（session-query FTS） | ✅ | ❌ | 可自建索引或直接 grep JSONL |
| 日志导出 ZIP | ✅ `/api/session.export` | ❌ | JSONL 文件本身即工件，直接拷贝即可 |
| 子代理谱系 | ✅（导出含 subagents/） | ✅（`subagent.started/finished` 通知 + 独立 JSONL 文件 + header 谱系） | SDK 只报告进程内子代理运行（`local` 标志） |
| 自动持久化 | ✅ | ✅（组合含持久化插件时） | 两者同一机制 |

### 6.4 使用 SDK 时的注意事项

1. **持久化不是 SDK 协议的一部分，是运行时组合的一部分**：若自定义 cordis.yml 删掉了持久化条目，则只有实时流、无落盘 —— 轨迹自研场景请保留；
2. **stdout 纯度**：持久化日志写文件不占用 stdout，与 JSON-RPC 通道无冲突；
3. **读取时机**：write-behind 写入 + checkpoint 策略；`close()`（协议 shutdown → dispose root）后全部落盘；若要在运行中读尾，理解最后一个 `turn/end` 之后可能存在未提交尾部；
4. **会话 id 自持**：SDK 会话 id 由调用方铸造（`session-<uuid>`），轨迹文件按该 id 定位；复用 id = 续写同一轨迹文件；
5. **maxTokens 终止**：轨迹中体现为 `turn/end` 的 `max-tokens` 理由；`maxTokensAsSuccess` 只影响 `subagent.finished` 的状态映射，不改变日志。

---

## 7. 自研轨迹渲染开发指南

### 7.1 数据路线选型

| 路线 | 数据源 | 优点 | 代价 |
|---|---|---|---|
| **A. 离线解析 JSONL**（推荐起步） | `DSH_SESSION_ROOT` 下会话文件 | 完整无损（含 chunk）、进程无关、可回放 | 需处理 zstd + 打包行两个格式点 |
| **B. 在线订阅 `session.event`** | SDK 订阅流 | 实时、无解析负担（信封直接可用） | 需运行中；错过即失（无重放） |
| **C. A+B 混合** | 订阅做实时层，JSONL 做持久层 | Web 同款架构 | 需 seq 对齐（两者同源，对齐自然） |

### 7.2 JSONL 解析要点（路线 A）

1. **定位文件**：`<root>/--<cwd 编码>--/<sessionId 编码>/session.jsonl.zstd`；项目目录名 = cwd 分隔符换 `-` 的可读 slug；建议直接递归扫描 root 按首行 header 筛选，而非自行实现编码；
2. **zstd 解码**：标准帧带校验和；配置 `compression: 'none'`（如 snapshot 模式）则明文。Python 可用 zstandard 库；若自研解析器不想处理打包行，可在自己的 cordis.yml 里设 `packChunks: false`（每事件一行，诊断友好，代价是日志大约 60%）；
3. **逐行解码**：首行必为 `type:'session'` header；后续行区分：
   - `type ∈ {text-chunks, reasoning-chunks, tool-call-chunks}` → 打包行：成员 `k` = seq `seq0+k`，逐个还原为 `assistant/chunk`（时间戳差值编码）；不需要 token 级回放时可整行跳过；
   - 其他 → 普通事件行，`type` 即 `SessionEventMap` 键；
4. **完整性立场**：校验 seq 连续；未知类型无 `ignorable: true` 时应拒绝而非丢弃（与官方读取方一致）；最后一个 `turn/end` 之后的缺口/坏行按崩溃截尾处理；
5. **谱系重建**：header 的 `parentSession`/`delegationDepth`/`seedLength`；`session/end-seed` 标记种子/live 边界。

### 7.3 在线订阅要点（路线 B）

```python
# Python 低层客户端示例：实时采集轨迹事件
from deepseek_harness import DeepSeekHarness

with DeepSeekHarness(cordis="examples/jsonrpc-agent/cordis.yml") as harness:
    client = harness.client
    session = harness.start_session("trace-demo-001")
    trajectory = []
    with client.subscribe_session_notifications(session.id) as sub:
        message_id = client.session_prompt(session.id, [{"type": "text", "text": "任务…"}])
        while True:
            ntf = sub.next()
            if ntf.method == "session.event":
                trajectory.append(ntf.payload["event"])   # 完整 SessionEvent 信封
            elif (ntf.method == "session.status"
                  and ntf.payload.get("sessionId") == session.id
                  and ntf.payload.get("status") == "idle"):
                break
# 此后轨迹同时也已（将）落盘为 JSONL，可交叉验证
```

TS 侧等价：`client.subscribeSessionTree(id)` + `for await` 迭代。

### 7.4 事件 → 轨迹记录映射参考（对齐 Web `TrajectoryCellKind`）

| 你的记录类型（参考 Web） | 来源事件 | 提取要点 |
|---|---|---|
| user | `user/message` | `source` 区分人类/注入；inbox 事件提供排队/取消上下文 |
| context | `user/message`（inject 源）/ `agent/inbox/*` | 注入上下文单独成类 |
| message (assistant) | `assistant/message` | usage（input/output/cache/think）；TTFT = 首个 chunk time − step/start time；`sourceEventSeqs` 回指 chunk |
| tool | `tool/call` + `tool/result`（按 `callId` 配对） | arguments 原样 JSON 字符串；结果取 `message.content`；`error` 标失败；`meta` 渲染差异/diff；时长 = result.time − call.time |
| subtool | 子代理会话事件（谱系关联） | `subagent.started/finished` + 子会话独立日志 |
| system | `request/header` | config + system 提示 + 工具 schema；`reason` 区分 initial/resume/change |
| compacted | `compaction/*` + replace 节点 | `surfaceOp.replace` + `sourceEventSeqs` 定位被遮蔽区间 |
| turn 分隔 | `turn/start` / `turn/end` | reason 渲染回合结局；interrupted = 崩溃/取消 |
| step 标记 | `step/start` / `step/end` | 分组模型调用与其工具执行 |
| 时间轴 | 所有事件的 `time` | Overview 类组件直接用；进行中项不虚构时长 |

### 7.5 建议的最小可行架构

1. **采集层**：路线 B 订阅流写自己的轨迹数据库（或直接追加自己的 JSONL）；
2. **归档层**：依赖运行时自动落盘的标准 JSONL 作为 source of truth，定期扫描归档；
3. **投影层**：按 §7.4 映射表把事件折叠为记录（turn/step 分组 + callId 配对 + usage/计时派生）；
4. **渲染层**：台账（seq 排序）+ 时间轴（time 投影）+ 检查器（详情面板）——Web `ui-trajectory` 的三件套结构可直接借鉴；
5. **一致性**：同一会话的实时流与落盘日志同源，用 seq 对齐即可互相校验。

---

## 8. 总结

- **轨迹在 dsh 中不是功能，是地基**：append-only 会话日志同时是模型历史的来源、持久化的内容、回放的底片、审计的证据，Web 轨迹视图只是它的一个投影；
- **Web 轨迹机制分四层**：事件模型（坐标 seq/time + 内建溯源）→ 标准存储（JSONL/SQLite，torn-tail 修复，fail-closed 版本）→ 网关链路（history 分页 + mux 实时帧，渲染意图不持久化）→ 目标化组装与虚拟渲染（Definitions 状态机 → TrajectorySnapshot → 台账/时间轴/检查器）；
- **SDK 完整复用这套地基**：轨迹基础数据自动按标准格式存储（组合含持久化插件时），实时事件流与落盘日志同源同格式；与 Web 的唯一实质差距是不持久化的 `ToolEventView` 派生视图，可重算，不构成数据缺口；
- **自研轨迹渲染的推荐路径**：以标准 JSONL 为 source of truth（离线路线 A），以 `session.event` 订阅为实时层（路线 B），按 §7.4 映射表折叠记录，借鉴 ui-trajectory 的台账 + 时间轴 + 检查器三件套结构。

---

## 附录：关键源码定位

| 主题 | 路径 |
|---|---|
| 事件类型/信封定义 | `packages/core/session/src/types.ts` |
| Surface 投影规则 | `packages/core/session/src/surface.ts` |
| chunk 打包行格式 | `packages/core/session/src/chunk-rows.ts` |
| JSONL 文件格式/目录/扫描修复 | `packages/session/session-persistence-jsonl/src/format.ts` |
| JSONL 后端配置（root/packChunks/compression） | `packages/session/session-persistence-jsonl/src/index.ts` |
| SQLite 持久化后端 | `packages/session/session-persistence-sqlite/` |
| 会话查询能力（FTS 派生索引） | `packages/session-query/`、`docs/subsystems/session-query.md` |
| Web API 网关（mux 流/history/导出） | `packages/host/apiproxy/src/api/events.ts`、README |
| 浏览器 Session 事件窗口 | `packages/client/runtime/src/client/sessions/session.ts` |
| 轨迹 UI 包 | `packages/client/ui-trajectory/`（contract/record/snapshot-builder/definitions/组件） |
| SDK 服务端事件转发 | `packages/sdk/server/src/server.ts`（`ctx.on('session/event')`） |
| SDK 标准组合（含持久化） | `examples/jsonrpc-agent/cordis.yml`、`python/sdk-runtime/runtime/cordis.yml` |
