# 设计亮点：优于同类产品的差异化设计

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）
- **对比对象**：Claude Code（CC）、Codex CLI、LangGraph 及通用 agent 框架

以下亮点均从源码与仓库文档验证，按「对使用者的实际价值」排序。对比基于各同类产品公开可见的设计，同类产品均在快速演进，结论以本次分析时间为准。

## 1. 事件溯源会话日志：一份数据养活五个消费者

dsh 的 session log 是 append-only 的 `SessionEvent` 流（`packages/core/session`），`turn/*`、`step/*`、`user/message`、`assistant/chunk`、`tool/*` 全部落日志，并有运行时不变量强制 **model-visible ⟺ logged**。这份日志同时是：

- **模型历史的来源**——`deriveMessages()` 从日志投影，而非维护一份平行状态；
- **回放保真的来源**——`assistant/chunk` 保存 token 级原始流，`assistant/message` 携带 `sourceEventSeqs` 回溯到 chunk；
- **录制格式**——keyless 快照测试的回放脚本**直接从 `assistant/chunk` 事件推导**（`packages/test-support/llm-replay`），会话日志本身就是 record 格式，无需独立录制层；
- **fork/resume 的载体**——fork 是日志在某个 seq 边界复制（边界不得落在 open turn 内），resume 是冷载全量日志；
- **审计面**——审批决策（`approval/asked`/`approval/decided`）、hook 调用（`hook/invoked`/`hook/result`）都是日志事件，`effectiveApprovalPolicy(events)` 是一个纯 fold：「回放日志就是状态」。

**对比**：CC 的 transcript 是 JSONL 流水账（无 token 级 chunk、无 surface 语义）；LangGraph 用 checkpoint 存状态快照。dsh 把「状态」彻底消灭成「日志的投影」，崩溃恢复（持久化后端重载时自动以 `interrupted` 关闭遗留 open turn，容忍 torn-tail）、回放测试、审计合规由此成为同一笔投资。

另一个少见的严格性：`SessionEventMap` 成员**默认 required-on-read**——不识别的事件类型必须拒绝重构日志，只有显式标记 `ignorable: true` 的事件才可跳过。这是 fail-closed 的阅读策略，避免旧版本静默丢数据。

## 2. Compaction 是日志上的追加事务，不是历史重写

上下文压缩（`packages/compaction`）的机制：`compaction/start` 落锁 → LLM 摘要 → `compaction/summary` 记录遮蔽区间 → 一条带 `surfaceOp: { op: 'replace', start, end }` 的 user 消息落位 → `compaction/end`。span 在压缩期间变化则拒绝提交。

三个衍生设计值得单独点名：

- **人类 transcript 与模型视图分离**：append 起源的事件是人类历史的 durable 来源，replace 节点只存在于模型侧 surface——「用户看到的历史」和「模型看到的历史」是同一日志的两个视图，压缩永远不会篡改用户可见记录；
- **KV-cache 亲和**：摘要请求的输入重建「系统提示 + 工具 + 被遮蔽区间」的真实对话前缀，是对话的真前缀，**直接复用 provider 的 KV cache**——有意识的成本设计；
- **自愈闭环**：provider 返回 context-overflow 错误时，即使 token 压力低于阈值也强制压缩（挂在 `agent/request-error` waterfall 上）。

**对比**：CC 的 compaction 原地替换历史；LangGraph 靠 checkpoint 裁剪。把压缩做成「追加 + 视图遮蔽」使压缩本身可回放、可审计、可撤销推理。

## 3. 安全边界是可替换的服务，且策略逐调用携带

一次 Bash 调用的完整链路：`tool-bash`（Consumer）→ `ctx.shell`（Service Definition，`resolve(request): spec` 显式两段式）→ provider（`bash-local` / `bash-sandbox`）→ `ctx.sandbox.wrap(argv)` → `subprocess-local` spawn。

差异化点：

- **per-call policy**：`SandboxPolicy` 随每次调用携带，两个 Consumer 可以同时用不同策略；权限升级重试就是「带更宽策略的新调用」，并配套模型可读的升级协议（工具描述内嵌 escalation 规程：被拒绝后同 turn 内用 `sandbox_permissions` 带 justification 重试一次）；
- **诚实上报**：`SandboxEnforcement = 'full' | 'partial'` 如实报告实际强制力，沙箱不可用时 fail closed（`SANDBOX_UNAVAILABLE` 表示命令根本没跑，runner 失败优先于 denial 分类）；
- **本地 runner 链的工程质量**：Linux 是 bwrap → Landlock 链，其中 `native/landlock-run` 是约 300 行 C11、musl 静态链接的 self-restrict-then-exec launcher——ruleset 跨 execve 继承，被包裹命令及其全部子进程受限而宿主进程不受限，内核不能强制则退出不执行；macOS 用 Seatbelt，Windows 用 ACL restricted-token（每 workspace 派生写 SID）。每个 runner 做**功能性探测**（真跑 `true` 验证内核接受 profile），不探测即不可用，不靠平台名猜；
- **fs containment 不靠文本近似**：词法快路径之外，用文件系统身份（dev+ino）识别 Windows 8.3 别名和大小写等价。

**对比**：`SandboxMode` 词汇与 Codex 同源（`read-only`/`workspace-write`/`danger-full-access`），但 Codex 是进程级静态模式，CC 是 settings 里的静态权限表；dsh 把它做成了 per-call 可审计策略 + 动态升级协议。而「整个执行世界迁去远程沙箱」（E2B POC：bash/terminal/lsp 零改动跟随）是接缝三分架构的直接红利，同类产品中无对应物。

## 4. 一进程多异构 agent：preset + scope + isolate realm

Web 产品里同一个进程可以同时跑着不同工具集、不同 persona、不同 plan-mode 状态的会话（如「极简模式」只挂 bash + str_replace_editor + 固定 prompt）。机制：preset 是 standing mount 到常驻 scope，每个 agent 的 scope 挂在 preset 下，注册只存一份；`isolate` realm 用 Symbol 换服务 key，让两个 preset 的同名服务互不冲突（`apps/cli/config/agent-presets/standard/agent.cordis.yml` 里 `planMode` 按 preset 隔离，而 `tokenMeter` 刻意留在进程级）。

**对比**：同类 CLI 基本是「一进程一 agent 配置」。「多个不同组合的 agent 共存于一个服务进程」是 Web 多会话产品的硬前提，dsh 把它做成了框架原语而非应用层 workaround。

## 5. 竞品即子代理：subagent seam 的统一抽象

subagent 是一个标准能力接缝（`packages/subagent`）：Service Definition 定义 provider 注册与 delegation 契约，provider 家族包括——进程内 spawn、进程内 fork（继承父历史）、经 ACP 的任意进程外 server、**真实 Codex app-server child**、**经官方 Claude Agent SDK 的真实 Claude Code child**、经 SDK 的另一个 Harness 进程。

亮点不在「能调竞品」，而在两点工程诚实：

- 能力差异显式化：ACP provider 声明「advertises no start-time capabilities」且 `inheritsParentContext: false`——本地服务会**拒绝**要求深度限制、工具过滤、persona 的请求，而不是静默省略；
- 生命周期严谨：销毁走 EOF grace → SIGTERM → SIGKILL 阶梯，父模型只收到 child 最终文本。

## 6. 自我修改是正式能力：agent 检视并挂载自己的插件

`packages/extensions/` 提供模型可见的 `cordis_inspect_*` / `cordis_define` / `cordis_run` / `cordis_stop` 工具（`cordis-host-runner` 用 `node:vm` 沙箱执行模型写的插件代码），agent 可以先查询自己运行时的插件树结构，再动态挂载/卸载插件。因为「注册即 effect、卸载即回收」是框架级保证，这个在别的框架里等于玩火的能力，在这里是一个可控的 demo（`pnpm run demo:cordis`）。

## 7. 框架层完全自有：vendored + rescope + 修改日志

Cordis 不是依赖而是 vendored 源码（`vendor/`，9 个包按上游 SHA 固定），全部 rescope 进 `@deepseek-ai/*` 随产品一起发布，**18 条本地修改逐条记录**（fiber 生命周期加固、loader 事务化 reconciliation 等），每条注明覆盖测试，sync 流程文档化（`vendor/README.md`）。框架层的可审计、可打补丁、可固定——这在「框架出问题只能等上游」的常态里是稀缺品。

## 8. 工程纪律即产品设计的一部分

- **keyless 快照回放是默认 CI 路径**：回放安装成一个真 `LlmAdapter`，被测的是完整装配的应用（cordis.yml → Loader → CLI/ACP 子进程）而非 mock 循环；`ReplayHandle` 拆除时做消费检查，欠跑即报错。AGENTS.md 把「每个非平凡的模型可见行为变更必须同 PR 附带 keyless snapshot」写成政策；
- **per-file 100% 覆盖率门禁**（statements/branches/functions/lines，作用于 `packages/*/*/src`）；
- **jscpd 跨文件克隆检测**超阈值即失败；
- **十几个 doc-sync 生成物门禁**：tool catalog、config catalog、事件图、模块图全部由源码生成并校验同步，文档不会腐化；
- **发布纪律**：family 共享版本号、CI 永不写仓库、pack 无凭证运行、publish 只发包好的字节、`verify-packed-install` 验证 tarball 实际可装；
- **Agent Notes 与 PR 绑定**：非平凡改动必须附设计笔记，文档中保留决策脉络。

## 总结：亮点的共同根源

以上八点不是八个孤立 feature，而是两个根决策的复利：

1. **一切皆插件 + 接缝三分** → 安全边界可替换（#3）、竞品可接入（#5）、自我修改可控（#6）、多异构 agent 共存（#4）；
2. **日志即唯一事实源** → 回放测试免费（#1、#8）、压缩不篡改历史（#2）、审计面天然完整（#1、#3）。

同类产品里，单项设计或有近似者（Codex 的沙箱词汇、LangGraph 的 checkpoint、CC 的 hooks），但把这些统一进一个自洽架构、并以工程纪律守住不变量的，目前仅此一家。
