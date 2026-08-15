# 整体架构设计

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

## 一句话概括

DeepSeek Harness（dsh）是一个「一切皆插件」的 agent 运行时：模型适配器、工具注册表、会话日志乃至 agent 循环本身都是挂载在共享 Cordis context 上的插件，整个产品没有不可替换的特权内核，一切行为都可以从配置层重组合。

## 分层视图

```text
┌─────────────────────────────────────────────────────┐
│ 接入面    dsh CLI · Web UI · ACP server · JSON-RPC SDK │
├─────────────────────────────────────────────────────┤
│ 组合层    profile → bundle patch 层 → 用户 patch 层     │
│           （cordis.patch.yml / --patch overlay）       │
├─────────────────────────────────────────────────────┤
│ 产品脊骨  session · system-prompt · tools · agent ·    │
│           agent-loop（packages/core/*）                │
├─────────────────────────────────────────────────────┤
│ 能力接缝  llm · shell · subprocess · fs · sandbox ·    │
│           lsp · skill · web · subagent · workflow …    │
│           （Service Definition / Provider / Consumer） │
├─────────────────────────────────────────────────────┤
│ 框架层    vendored Cordis（vendor/，完全自有）           │
└─────────────────────────────────────────────────────┘
```

## 框架层：Cordis 五要素

Cordis 是 vendored 进 `vendor/` 的插件框架（上游 4.0.0-rc.7，按 commit SHA 固定），dsh 的架构语义全部由它的五个概念支撑（`docs/cordis-primer.md`）：

1. **插件即 Service**：一个带可选 `inject` 和 `apply(ctx)` 的对象，或一个 `Service` 子类。
2. **Context 即服务仓库**：服务占据稳定的 `ctx.<key>`（如 `ctx.tools`、`ctx.llm`），消费方按键查找而非 import 具体实现。
3. **`inject` 声明依赖**：插件列出所需服务，加载顺序由服务依赖推导，而非手工编排启动序列。
4. **类型化事件**：通过 TypeScript declaration merging 声明事件名，按 `emit` / `waterfall` / `parallel` / `serial` 四种模式分发；分发模式是事件公共契约的一部分。
5. **注册即可逆 effect**：所有贡献经 `ctx.effect()` / `ctx.on()` 注册，插件卸载时自动回收——热重载（HMR）和运行时插件装卸由此成立。

关键语义补充：`waterfall` 是 around-middleware，监听器收到 `(...args, next)`，**不调用 `next()` 就是短路**——策略监听器（如审批拒绝）靠短路拥有决策权，只观察的监听器必须委托。

## 组合层：profile 与 bundle

一个运行中的 `dsh` 是从空条目列表逐层叠加出来的插件树（`docs/architecture.md:15-37`）：

- **bundle** 是「cordis 配置行 + 代码」的分发格式（如 `@deepseek-ai/dsh-base` 提供模型适配、工具、持久化、沙箱、审批策略的共享核心；`dsh-web-app`、`dsh-headless` 在其上叠加）；
- **profile** 是 Harness home 下的具名组合：列出要叠的 bundle、可容纳 out-of-tree 插件、持有用户自己的 `cordis.patch.yml`；
- 层的应用顺序固定：profile 声明的 bundle（按序）→ profile 的 `cordis.patch.yml` → home 级 patch → 命令行 `--patch` overlay。**每行按 id 定位，后写者整体替换 config（不做深合并）**。

这个设计的直接后果：产品里任何一行的配置都可以被上一层整体替换，`dsh --profile web --dump-config` 不启动即可审查最终组合。「默认产品」与「用户定制」之间没有代码分叉，只有层叠配置。

## 产品脊骨：turn/step 循环

`packages/core/` 五个包构成 API 脊骨（`docs/architecture.md:41-51`）：`session`（append-only 事件日志，`ctx.sessions`）、`system-prompt`（提示词分块装配）、`tools`（带守卫执行管线的工具注册表）、`agent`（Agent 接口与 `agent/*` 事件）、`agent-loop`（默认驱动实现）。运行时的核心循环（`docs/architecture.md:65-84`）：

```text
turn/start
  claim next-step input + 一条排队消息
  装配 prompt sections + tool schemas
  -> agent/pre-step                可 reject / 改写消息
     step/start
     user/message 落日志
     deriveMessages() 从日志投影模型历史
     agent/request -> llm/stream -> assistant/chunk* -> assistant/message
     tool/call* -> tools/pre-execute -> tools/execute -> tools/post-execute
     step/end
     工具要求下一轮请求，或 inbox 来了新输入 -> 下一个 step
  -> agent/turn-stopping
turn/end
```

三个结构性事实：

- **step** = 一次模型请求 + 它引发的工具调用；**turn** = 零或多个 step 的一次输入排空。turn 边界即 durable commit/replay 边界：崩溃恢复、fork 边界校验、审计事件的合法性全部以 turn 为锚。
- **session log 是唯一事实源**。`deriveMessages()` 从日志投影模型所见历史；`assistant/chunk` 保存 token 级原始流，回放与 UI 保真由此而来。仓库用运行时不变量强制「**model-visible ⟺ logged**」：任何进入模型请求的内容必须能从日志重构，新增模型可见输入必须新增 session 事件类型。
- **事件分三个域**：session 事件（持久事实）、agent 事件（`agent/*`，携带 live Agent，拦截在途工作）、capability 事件（`fs/*`、`tools/*` 等，往接缝上挂策略）。选对事件域是大多数改动的第一个设计决策。

## 能力接缝（capability seam）

接缝是 dsh 最重要的结构单元（`docs/glossary.md:9`）：一个可替换能力固定由三个角色组成——

- **Service Definition**：声明接口与 `ctx.<key>` 的抽象类（如 `ShellExecutor`），绝不是裸 TypeScript interface；
- **Service Provider**：实现接口（如 `bash-local`、`bash-sandbox`、`subprocess-e2b`）；
- **Consumer**：使用能力的一方，通常是模型可见工具（如 `tool-bash`）。

接缝的复利在 `packages/e2b` 的 POC 里体现得最清楚：filesystem 与 subprocess 两个 provider 共享同一个「执行世界」，把它们指向 E2B 远程沙箱后，Bash、PTY、LSP 等所有上层 Consumer **零改动**随之迁入远程环境——因为 Consumer 只面向 `ctx.fs` / `ctx.subprocess` 两个接缝编程，不知道也不需要知道执行发生在哪里。

## 作用域（scope）：per-agent 注册

`packages/core/scope` 提供第四维结构：贡献（工具、prompt section、变量、限制、监听器）可以是**全局**的，也可以**按 agent 作用域**注册。关键机制：

- 每个 agent 创建时 mint 自己的 scope（`core/agent-loop/src/agent.ts:94`），经 `agent.ctx` 的注册既是作用域可见、又随作用域生命周期回收——一个事实驱动两个性质；
- **shadowing**：同名注册最近作用域优先，实现 per-agent persona 与 per-agent 工具变体；
- **restriction**（`tools.restrict`）按交集过滤继承来的工具集，被过滤的全局工具在提示词里消失且拒绝执行——与不存在不可区分；
- 事件沿 scope 链向上流动、永不向下（`events flow up the chain, never down`），父 agent 可以观察后代，反之不行。

由此，「一个进程同时跑多个异构组合的 agent 会话」（agent preset）成为可能：preset 挂载一次到常驻 scope，每个 session 的 agent scope 挂到其下，视图解析 `agent → preset → global` 逐层遮蔽。

## 数据流与边界一览

| 关注点 | 机制 | 位置 |
|---|---|---|
| 模型历史 | `deriveMessages()` 从日志投影 | `core/session` |
| 持久化 | SQLite（`SCHEMA_VERSION=15`）/ JSONL 双后端，torn-tail 容忍 | `session/session-persistence-*` |
| 提示词 | section/context/variable 三类注册 + `assemble()` | `core/system-prompt` |
| 上下文压缩 | 日志上的追加事务（surface replace），非历史重写 | `compaction/*` |
| 工具守卫 | `tools/pre-execute` allow/deny/ask → execute 包装 → post-execute | `core/tools` + `guard/*` |
| 沙箱 | per-call policy，本地 runner 链（bwrap/Landlock/Seatbelt/ACL）或 E2B | `sandbox/*`、`native/landlock-run` |
| 后台工作 | `ctx.jobs` 注册表 + `job_*` 工具 | `jobs/*` |
| 自愈续跑 | goal（同会话）与 Ralph（fresh-child）两种正交模式，都是插件 | `goal/*`、`workflow/tool-ralph` |

## 架构判断

从资深 agent 开发者视角看，这套架构的本质是**把 agent 产品从「一个主循环 + 若干配置项」重构为「一个组合框架 + 一组接缝」**。它付出的代价是概念密度（Cordis 语义、事件域、scope、seam 都要先学会）和间接层；换来的东西在同类产品中少见：

1. **没有内核特权**——agent 循环自己也是插件，`Plugins, not loop changes` 是写进 AGENTS.md 的硬纪律；
2. **组合发生在部署层而非代码层**——profile/bundle/patch 让定制不需要 fork；
3. **日志即协议**——持久化格式、回放格式、SDK wire 协议是同一份 SessionEvent 词汇（`packages/sdk/protocol` 明确「the session vocabulary is part of the wire contract」）。

这三点互相咬合：因为一切皆插件，所以组合层成立；因为日志即事实源，所以插件的贡献天然可回放、可审计。后续的亮点文档和插件系统文档会分别展开这两点。
