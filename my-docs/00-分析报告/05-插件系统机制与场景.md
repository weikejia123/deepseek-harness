# 插件系统设计机制（专项）

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

本文阐述 dsh 插件系统的完整机制：插件的两种形态、依赖与生命周期、补丁层组合、作用域注册、isolate realm，并用六个实际开发场景说明「能用插件解决什么问题」。所有示例均取自仓库真实代码。

## 1. 插件的两种形态

### 函数式插件（轻量贡献）

`packages/todo/tool-todo/src/index.ts`：

```ts
export const name = 'tool-todo'
export const inject = ['tools']            // 声明依赖：等 ctx.tools 就绪才加载

export const Config: z<Config> = z.object({
  allowParallelInProgress: z.boolean().required(),   // schemastery 校验，配错即 load 报错
})

export function apply(ctx: Context, config: Config): void {
  // 可选依赖：sessionProjections 出现才激活子注册
  ctx.inject(['sessionProjections'], (projectionCtx) => { ... })
  // 注册即 effect：返回 disposer，插件卸载时自动回收
  ctx.tools.register(defineTool({ name: 'todo_write', ... }))
}
```

### 类式插件（提供服务）

`packages/shell/bash-local/src/index.ts`：

```ts
export class LocalBashExecutor extends ShellExecutor {
  static inject = ['subprocess']           // 依赖 ctx.subprocess 服务

  static Config: z<Config> = z.object({
    timeoutMs: z.number().default(120_000),
    maxOutputBytes: z.number().default(64_000),
    ...
  })
  constructor(ctx: Context, config: Config) {
    super(ctx)   // 父类 super(ctx, 'shell') 完成 ctx.shell 服务注册
  }
}
```

两种形态的分工：**消费能力的用函数式 + `apply`，提供服务的用 `class extends Service`**。Service Definition 本身也是抽象类（如 `ShellExecutor`），通过 declaration merging 把 key 挂到 `Context` 接口上：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { shell: ShellExecutor }
}
```

同一 context 重复注册同名服务会直接抛错（Cordis 标准的 duplicate-service 行为）——配置错误在加载期爆炸，而不是运行期出现诡异行为。

## 2. 依赖解析与生命周期

- **`inject` 即加载顺序**：声明的服务未就绪时插件 fiber 处于等待态，服务出现后 inject checker 自动启动依赖它的 fiber。没有手工 boot 编排，也没有「插件顺序敏感」的坑。
- **`ctx.inject([...], cb)` 表达可选依赖**：服务出现才激活回调里的注册（tool-todo 对 sessionProjections 的用法）。
- **注册即 effect**：每个注册返回 disposer 或由 `ctx.effect()` 托管；卸载插件 = 逆序回收它的全部注册。这使得 HMR 热重载、运行时插件装卸（含 agent 自我修改）在框架层面安全。
- **生命周期隔离的范例**：`bash-local` 的后台进程归 `ctx.subprocess` 所有，executor 自己被 HMR reload 时进程不死——所有权被刻意放在更稳定的服务上。

## 3. 补丁层组合：cordis.patch.yml

插件树的组合单位是「行」（entry）：`{ id, name, config, group, disabled, inject, isolate }`（定义在 `vendor/loader/src/config/entry.ts`）。真实例子 `packages/bundle/base/cordis.patch.yml`：

```yaml
# patch replaces the targeted row's whole `config` rather than merging into it;
# later bundle patches and the user's profile cordis.patch.yml address these rows
# by id, with the last write winning per row.
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: session-persistence-sqlite
      name: '@deepseek-ai/dsh-session-persistence-sqlite'
      config:
        path: !!js dshHomePath('sessions')
    - id: bash-sandbox-macos
      name: '@deepseek-ai/dsh-bash-sandbox'
      disabled: !!js process.platform !== 'darwin'
```

三个关键语义：

1. **按 id 定位，整体替换**：后续层写 `- id: session-query-sqlite` + 新 `config`（不带 `insert`）即整体覆盖该行的 config，不做深合并——心智模型是「后写者赢」，不是「配置 diff」；
2. **`!!js` 表达式**：`config` 和 `disabled` 字段允许 `!!js` 前缀的 JS 表达式，在 loader context 上求值（可访问 `process`、`ctx.*` 服务、helper 如 `dshHomePath`）。平台条件禁用（`process.platform === 'win32'`）、环境变量分支（`DSH_PERMISSION_MODE` 推导审批策略）、跨插件取值（`ctx.headlessStartup.task`，需同时声明 `inject: [headlessStartup]`）都靠它；其他元数据保持字面量，环境选择插件的正经做法是 overlay 而非表达式；
3. **disabled 沿父链传染**：父 entry 禁用则子孙皆禁用。

组合顺序固定：`dsh.profile.bundles` 按序 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。`dsh --profile <name> --dump-config` 不启动即可看到最终树。

热更新也是一等公民：行 config 变更走热 patch（fiber.update），`name`/`inject`/`group` 变更则 dispose 旧 fiber 并重启，**失败时回滚旧插件**（loader 的事务化 reconciliation，是 dsh 对 vendored Cordis 的本地加固之一）。

## 4. 作用域注册（scope）：per-agent 的贡献

`packages/core/scope` 提供原语：

- `createScope(ctx, key)` mint 一个带标记的 context（背后是一个 Cordis fiber），经此 context 的注册归该 scope 拥有，`dispose()` 时全部回收；
- 注册表存储是 `global layer + 按 scope key 的 overlay layers`，`merge()` 按「最远祖先优先」合并，**最近作用域的同名注册赢**（shadowing）——per-agent persona、per-agent 工具变体由此实现；
- 事件沿 scope 链向上流、永不向下：父 agent 可观察后代，后代看不到父的私有事件；
- `tools.restrict(filter)` 只能在 scoped context 上调用（在全局 context 调用直接抛错——「全局 restriction 会遮蔽所有 agent」是设计要防的误用）。精妙处在于：restriction 只过滤**继承来的**工具（global + 祖先 layer），不过滤 scope 自己注册的——因为 delegation runtime 要往子 agent 自己的 layer 注册 report/structured-output 工具，过滤器不能把应答机制剥掉。restrictions 沿链取交集。

**一个事实驱动两个性质**：经 `agent.ctx` 的注册既只对该 agent 可见，又随该 agent 销毁回收。这是 scope 设计里最值得记住的一句话。

## 5. isolate realm：服务隔离

默认服务是进程级单例。但 preset（per-session agent 组合）要求「两个同名 preset 的同名服务互不干扰」。isolate realm 的解法是**给服务 key 换成带后缀的 Symbol**：`isolate: { planMode: true }` 是 entry 局部隔离，`isolate: { planMode: 'label' }` 跨 entry 共享。热迁移经 `loader/patch-context` waterfall 七步完成（换 prototype、转移实现、notify）。真实用例（`apps/cli/config/agent-presets/standard/agent.cordis.yml`）：

```yaml
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true       # plan 状态按 preset 隔离，不做进程级单例
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
```

判断依据写在注释里：plan 状态是 per-agent 的；`tokenMeter` 刻意不进 realm，因为它服务所有 session。

## 6. 实际开发场景：插件能解决什么问题

以下六个场景按「使用者身份」递进，每个都给出机制与仓库内的真实证据。

### 场景 A：最终用户——不改代码换掉一个 provider

**问题**：公司合规要求 shell 命令一律走审批（`ask`），且 SQLite 会话库要放到加密卷。

**解法**：在 `$DSH_HOME/cordis.patch.yml`（最高常驻层）写两行：

```yaml
- id: approval-policy
  config:
    policy: ask
- id: session-persistence-sqlite
  config:
    path: /Volumes/encrypted/dsh-sessions
```

按 id 整体替换 config，不动任何源码、不 fork。`dsh --profile web --dump-config` 验证组合结果。**证据**：`packages/bundle/web-app/cordis.patch.yml:30-33` 用同样手法把 `session-query-sqlite` 覆盖成 `:memory:`；base patch 的注释直接教用户「在后续层覆盖 `openAt`」。

### 场景 B：工具作者——给模型加一个新工具

**问题**：想给 agent 加一个「查询内部工单系统」的工具。

**解法**：写一个函数式插件，`inject = ['tools']`，`apply` 里 `ctx.tools.register(defineTool({...}))`。工具定义强制声明 `output`（canonical lossless-JSON + schema + 纯函数 `render(args, value)`）——**结果数据与呈现分离**：live streaming、日志回放、UI 渲染共用同一份 durable 数据；`timeoutMs` 是声明式预算且永不下发给模型（schema 白名单只含 name/description/parameters）。UI 渲染意图（`generic`/`terminal`/`diff`）在设计时决定，呈现方法是 args 的纯函数。**证据**：`docs/cookbook/adding-a-tool.md`；`tool-todo` 是最小完整样板。

### 场景 C：平台工程师——把执行环境整体迁到远程沙箱

**问题**：agent 要在客户机器上跑，但命令执行必须发生在公司云上的隔离沙箱。

**解法**：写一个 E2B provider 对：`fs-e2b`（实现 `ctx.fs` over E2B Filesystem API）+ `subprocess-e2b`（实现 `ctx.subprocess` over E2B Commands/PTY），在 profile patch 里替换两行 provider。**bash、terminal、lsp 等所有上层 Consumer 零改动**——它们只面向两个基础接缝编程。harness 进程、会话状态、模型调用留在本地。**证据**：`packages/e2b/` POC 正是这么做的；这是能力接缝三分（Definition/Provider/Consumer）设计的最强论证。

### 场景 D：集成工程师——复用已有的 Claude Code hooks 生态

**问题**：团队已有一批 CC 的 `hooks.json`（PreToolUse 审批、SessionStart 注入上下文），不想重写。

**解法**：挂载 `@deepseek-ai/dsh-hooks-claude-code` 插件，把未修改的 CC hooks.json 映射到 harness 拦截点：`agent/session-start`（SessionStart，detached 后台跑，结果 `agent.inject()`）、`agent/pre-step`（UserPromptSubmit）、`tools/pre-execute`（PreToolUse 的 allow/deny）、`tools/post-execute`、`agent/turn-stopping`（Stop）、`subagent/start|end`。每次 hook 调用落 `hook/invoked` + `hook/result` 事件对（可回放审计），多 hook 结果折叠为最严格决策；不支持的 CC 能力 warn 而非静默。**证据**：`packages/hooks/hooks-claude-code/src/index.ts:206-291`；cookbook 的论断点明了本质——「所谓 native hook 就是拦截点上的普通 Cordis 插件，桥接包只是把外部协议翻译成已有事件扩展点」。

### 场景 E：产品工程师——同进程跑多套异构 agent 配置

**问题**：Web 产品要同时提供「完整模式」和「极简模式」（只挂 bash + str_replace_editor + 固定 system prompt）。

**解法**：做两个 agent preset（各含一个 `agent.cordis.yml`），每个 session 创建时选定 preset。机制：preset standing mount 一次，agent scope 挂其下，视图 `agent → preset → global` 逐层遮蔽；per-preset 状态（如 plan mode）放 isolate realm；preset 切换只允许空会话（换工具集会让已 logged 的 tool call 无法重演——这是刻意的不变量保护）。**证据**：`apps/cli/config/agent-presets/`（standard/minimal）；`packages/preset/agent-presets/README.md`。

### 场景 F：高阶玩法——agent 给自己写插件

**问题**：让 agent 在运行时获得「当前任务需要但没有」的能力，比如临时加一个项目专用的检查工具。

**解法**：挂载 `tool-cordis`（`packages/extensions/`）。agent 先 `cordis_inspect_list` / `cordis_inspect_query` 查询自己运行时的插件树与服务 API，再 `cordis_define` 写插件代码、`cordis_run` 挂载（host 半在 `node:vm` 沙箱执行）、用完 `cordis_stop` 卸载。因为注册即 effect，卸载是干净的；因为 vm 沙箱隔离，动态代码不直接触碰宿主。**证据**：`packages/extensions/tool-cordis/src/index.ts`；`pnpm run demo:cordis` 演示完整流程。

## 7. 插件管理：`dsh plugin`

`dsh plugin --profile <name> <pnpm args...>` 是 out-of-tree 插件的管理通道（`apps/cli/src/plugin.ts`）：首次调用初始化 profile，然后在 profile 目录透传 pnpm（`add`/`remove`/`update` 均可）。每次成功后按**安装后状态** reconcile `dsh.profile.bundles`：装了声明 `dsh.bundle` 的包就入层栈，移除就出栈——层列表是安装状态的投影，不是手工维护的清单。相对路径 spec 锚定调用目录（`pnpm add .` 装的是当前 checkout，不会自链 profile）。git 依赖的 prepare 脚本被 pnpm ≥10 拦截时，给出 profile 级 `pnpm-workspace.yaml` 的 allowBuilds 指引。

## 8. 设计评价

站在插件作者视角，这套系统的优点与代价都很清晰：

**优点**

- 组合语义极简：「行 + id + 后写者赢 + 整体替换」四个规则覆盖全部定制场景，没有 merge 算法要学；
- 生命周期无需管理：注册即 effect + inject 依赖推导，插件作者不写 teardown 清单、不排启动顺序；
- 误用被设计成报错：全局 `tools.restrict` 抛错、duplicate service 抛错、Config schema 校验不过抛错——misconfiguration fails loud 是仓库级纪律；
- 一切皆可验证：`--dump-config` 看组合、`cordis_inspect_*` 看运行时、事件目录由源码生成。

**代价**

- 概念门槛：Context/inject/effect/waterfall/scope/realm 六个概念必须全懂才能写非平凡插件，比「注册一个回调」式的插件 API 陡峭；
- 调试间接性：行为由层叠组合决定，出问题时要先 `--dump-config` 定位是哪一层干的，而不是直接看代码路径；
- 生态年轻：文档中的 cookbook 质量不错，但 out-of-tree 插件的实例目前基本都是仓库自产自销，第三方生态尚未验证这套机制的亲和力。
