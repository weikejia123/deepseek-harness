# Cordis 插件详细介绍（DSH 插件体系专题）

- **文档更新时间**：2026-08-18 03:06:48
- **文档版本**：V1
- **dsh 程序版本**：`0.1.0-rc.5`（commit `12720b0ef9`，分支 `wkj-dev`，2026-08-17 07:04:07）

| 版本 | 更新时间 | dsh 版本 | 说明 |
| --- | --- | --- | --- |
| V1 | 2026-08-18 03:06:48 | `0.1.0-rc.5`（12720b0ef9） | 初始版本：核心机制、架构与流程、配置方法、开发规范、实战与排错 |

本文是 DSH（DeepSeek Harness）中 Cordis 插件体系的详细介绍，覆盖「一切皆插件」的核心机制、仓库插件与动态插件两种形态、Host/Client 双半区架构与运行流程、cordis.yml 配置方法、插件开发规范与标准，并以 `sysmon` 系统监控插件为完整实战案例。内容以本仓库真实代码、官方文档（`docs/cordis-primer.md`、`docs/architecture.md`）及动态插件开发实践为准。

## 1. 核心机制

### 1.1 一切皆插件（Everything is a Plugin）

DSH 基于 vendored Cordis 构建，**一切能力都是插件**：LLM 适配、shell/subprocess/fs/lsp/web 能力、会话持久化、subagent 委派、workflow、todo 工具、Web UI 的每个页面区域，全部以插件行的形式组合进运行时。没有"硬编码的主程序"，只有一棵由插件行组成的组合树。

插件的两种存在形态：

1. **仓库包插件**（源码位于 `packages/`，随构建产物分发）——开发期写 TS，经 tsc/tsdown 编译；
2. **动态插件**（进程内定义，`cordis_define` 创建）——纯 JS 函数体，不经过任何编译，定义即存在于当前进程，重启即消失。

### 1.2 Context：服务仓库

Cordis 的 `Context` 是服务的仓库。一个服务通过稳定键（`ctx.tools`、`ctx.llm`、`ctx.sessions`、`ctx.shell` 等）向 context 注册；其他插件**按键查找服务，而不是 import 具体实现**。这正是可组合性的来源：同一键可以替换实现，消费方无感知。

服务键的类型通过 TypeScript declaration merging 挂到 `Context` 接口上：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { shell: ShellExecutor }
}
```

同一 context 重复注册同名服务会直接抛错（Cordis 标准的 duplicate-service 行为），配置错误在加载期爆炸，而不是运行期出现诡异行为。

### 1.3 插件的两种形态

**函数式插件**（轻量贡献，消费能力）：

```ts
export const name = 'tool-todo'
export const inject = ['tools']                       // 声明依赖：ctx.tools 就绪才加载
export const Config: z<Config> = z.object({ ... })    // schemastery 校验，配错即 load 报错
export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({ name: 'todo_write', ... }))
}
```

**类式插件**（提供服务）：

```ts
export class LocalBashExecutor extends ShellExecutor {
  static inject = ['subprocess']
  static Config: z<Config> = z.object({ ... })
  constructor(ctx: Context, config: Config) {
    super(ctx)   // 父类 super(ctx, 'shell') 完成 ctx.shell 服务注册
  }
}
```

分工：**消费能力的用函数式 + `apply`，提供服务的用 `class extends Service`**。Service Definition 本身也是抽象类（如 `ShellExecutor`），通过 declaration merging 把键挂到 `Context` 接口上。

### 1.4 inject：依赖即加载顺序

- `inject` 声明的服务未就绪时，插件 fiber 处于等待态；服务出现后 inject checker 自动启动依赖它的 fiber。没有手工 boot 编排，也没有「插件顺序敏感」的坑。
- `ctx.inject([...], cb)` 表达**可选依赖**：服务出现才激活回调里的注册。
- 插件代码中读取服务有两种方式：可选服务用 `ctx.get('name')`（需判空），硬依赖用 `inject: ['name']` 后直接 `ctx.name`。动态插件的 Guard 会拒绝未声明注入的 `ctx.xxx` 属性访问。

### 1.5 事件系统

服务之间通过**类型化事件**通信。事件名通过 TypeScript declaration merging 声明，按分发模式决定监听者的观察/包装/扇出/顺序执行：

| 模式 | 是否 await | 分发顺序 | 有无返回值 |
| --- | --- | --- | --- |
| `emit` | 否 | 按注册顺序 | 无 |
| `waterfall` | 否 | 按注册顺序 | 有 |
| `parallel` | 是 | 全部并行 | 无 |
| `serial` | 是 | 按注册顺序 | 有 |

分发模式是事件的公共契约的一部分；harness 事件用 `@mode` 标注，生成目录会校验声明与分发点一致。

**Waterfall 语义**（中间件）：监听者收到 `(...args, next)`。调用 `next()` 把（可能被包装的）结果交给下一个监听者；不调用 `next()` 直接 return 则短路。需要先于普通注册运行时用 `prepend: true`。单决策事件中，短路就是设计：策略监听者拥有决策时可以不带 `next()` 返回，只做注解/观察的监听者必须委托。

### 1.6 注册即 effect（可逆副作用）

**每个注册都是可逆的副作用**：prompt 段、工具 schema、适配器、provider、监听器都通过 `ctx.effect()` 或 `ctx.on()` 安装，返回 disposer。卸载插件 = 逆序回收它的全部注册。这使 HMR 热重载、运行时插件装卸（含 agent 自我修改）在框架层面安全。

### 1.7 能力缝（Capability Seam）

一个能力缝由三部分组成：**Service Definition（抽象契约）/ Service Provider（实现）/ Consumer（消费方）**。例如 shell 能力缝：`ShellExecutor`（Definition）+ `bash-local`/`bash-sandbox`（Provider）+ `tool-bash`（Consumer）。拆缝只发生在角色独立演进时；完整能力缝是常态。

## 2. 架构与流程

### 2.1 组合平面：HOST 与 AGENT PRESET

一个编辑属于哪个平面，由它服务的对象决定：

- **HOST 组合**（`cordis.yml` 根组合）持有注册表与跨会话共享的一切：持久化、沙箱与审批栈、模型路由、subagent 注册表及其后端。发布服务的行属于 HOST 组合，或属于 `isolate` realm（当该服务确实只被一个 agent 读取）。
- **AGENT PRESET**（`${DSH_HOME}/.agent-presets/<id>/` 下的 cordis.yml）持有单个会话贡献给注册表的东西：它的工具、persona、prompt 段。预设目录是每个预设一个目录，roster 报告真实路径；改预设就改副本，绝不改部署自带的 `agent-presets` 安装目录（升级会覆盖）。

### 2.2 插件树与补丁层

组合单位是「行」（entry）：`{ id, name, config, group, disabled, inject, isolate }`。组合通过补丁层叠加：基础 bundle（`packages/bundle/base/cordis.patch.yml`）→ 后续 bundle 补丁 → 用户 profile 的 `cordis.patch.yml`。**patch 替换目标行的整个 `config` 而非合并**；按行 id 寻址，最后写入者胜。

### 2.3 装载与生命周期流程

```
Loader 读取组合（cordis.yml / cordis.patch.yml / preset）
  → 解析每行 entry（config 经 !!js 表达式插值）
  → 按 inject 依赖解析加载顺序
  → 服务就绪后启动插件 fiber，执行 apply(ctx, config)
  → 注册即 effect，全部注册进 fiber
  → 卸载/HMR/停止时逆序回收 disposer
```

### 2.4 动态插件架构

动态插件有一套独立的身份与版本模型：

- **pluginId**：插件的稳定实例标识（可跨版本演进）。新建时只提交 3–6 位小写字母的语义前缀（如 `sysmon`），Host 分配最终 ID（如 `sysmon-1`）。
- **packageId**：一个不可变的 Host/Client 源码版本（如 `pkg-2`）。改代码 = 追加新 Package，绝不覆盖旧版本。
- **pluginRunId**：一次激活尝试的标识，连接审批、加载、错误与 Run 卡片。
- **currentPackageId**：最近一次完全成功的 Package；**nextPackageId**：等待审批/激活中或最近失败的 Package。停止、更新失败都不清除 current。

### 2.5 动态插件生命周期流程

```
cordis_define（定义源码，不运行；返回 pluginId/packageId）
  → cordis_run（激活）：
      - 首次激活/重启当前/回滚 → mode: run
      - 从当前版本切换到另一版本 → mode: update
  → 未经授权的 Client 半区产生审批请求（awaiting-approval）
  → 用户在 Web UI 允许（单勾 = 仅本次 Package；双勾 = 授权该插件未来所有版本）
  → 激活成功（starting → 异步完成）或技术失败（修复后 update 重试 / run current 回滚）
```

停止用 `cordis_stop`（保留定义、grant、版本指针）；永久删除用 `cordis_undefine`（先停再删）。授权 grant 在技术失败后仍然有效；用户拒绝后不得再次请求审批。

### 2.6 Host / Client 双半区架构

一个动态插件可有**两个半区**，各自独立运行：

- **Host 半区**：运行在 DSH Node.js 进程，适合文件、网络、命令、Agent/Session 访问、服务/事件、模型工具、可被 Client 调用的 JSON 方法。内置符号：`ctx`、`harness`（`handle`/`defineTool`/`registerTool`）、`console`、`btoa`、`atob`、`TextEncoder`、`TextDecoder`。
- **Client 半区**：运行在浏览器页面，适合主题、布局、页面状态、工具卡片、槽位 UI。内置符号：`ctx`、`React`（`createElement`/`useState`/`useEffect`）、`host`（`call`）、`styles`（`insert`）、`console`。

通信是**单向 Client→Host 的 Package 私有 JSON RPC**：Host 用 `harness.handle(method, handler)` 注册（返回 disposer），Client 用 `host.call(method, args)` 调用。只允许无损 JSON 跨过边界；禁止传函数、React 元素、类实例、Context、服务等运行时对象。

### 2.7 Web 槽位系统（Slots）

Client UI 必须注册到某个**槽位**（Slot），不能由 `apply()` 直接返回元素。槽位树以 `root` 为根：`sidebar`、`conversation`、`details`、`shell.overlay` 等。槽位协议分 `single`（占满即替换）、`list`（并列追加）、`keyed`（按 key 分发）、`chain`（选择器路由）四类。

常用槽位：
- `shell.overlay`（list，root 作用域）：帧级悬浮层，默认点击穿透、条目自行 opt-in 指针事件——悬浮球、toast 栈、状态徽章都放这里；
- `tool.view.cordis`（keyed）：最新 `cordis_run` 卡片内的交互区，key 固定为 `self`；
- `settings.section` / `settings.general.item`：设置页/单行偏好；
- `conversation.*` 系列：会话视图、消息操作、输入区扩展。

注册模式：`slots.inject('target.slot', () => slots.register({ name: 'target.slot', id: 'my-id' }, (props) => ReactElement))`。不要占用 `root` 等单槽位——那会遮蔽整个内置 UI。

## 3. 配置方法

### 3.1 cordis.yml 与 entry 行

```yaml
plugins:
  - id: my-plugin
    name: '@scope/my-plugin'
    config:
      key: value
    disabled: false
```

行字段：`id`（行标识）、`name`（插件包名）、`config`（配置对象）、`group`、`disabled`、`inject`、`isolate`。插件自己的 `Config` 用 schemastery 声明，加载期校验，配错即报错。

### 3.2 !!js 表达式与 overlay

`cordis-plugin-include` 把 `!!js` 解析为表达式节点：行的 `config` 在声明依赖激活后、针对该插件 context 插值；`disabled` 在每次装载决策时、针对 loader context 求值。**其他行元数据保持字面量**。环境选择插件用 overlay，而不是条件元数据。

### 3.3 补丁层与 profile

`cordis.patch.yml` 以行 id 寻址替换（整行 `config` 替换而非合并），最后写入者胜。用户 profile 补丁在 bundle 补丁之后应用。装载时 `agentPresets.mount()` 把预设组合挂到会话上下文。

### 3.4 动态插件审批与授权

- 单勾授权当前 Package；双勾授权未来所有版本（同插件）。
- grant 在技术失败后仍生效；更新失败不会自动重启旧版——用 `update` 重试目标版，或用 `run` 回滚 current。
- Client Package 未授权时 `cordis_run` 返回 `awaiting-approval`；授权后返回 `starting` 并异步完成，`currentPackageId` 仅在完全成功后变更。

### 3.5 my-plus 自定义插件仓库（本仓库约定）

`my-plus/plugins/<id>/`：`manifest.json`（id/name/purpose/idPrefix/version）+ `host.js`/`client.js`（纯 JS 函数体）+ `README.md`。`node my-plus/scripts/check.mjs` 批量校验。安装工作流：读取文件 → `cordis_define`（idPrefix 取 manifest）→ `cordis_run` → Web UI 批准。动态插件只在当前进程存在，`my-plus` 是持久化事实来源。

## 4. 插件开发的规范与标准

### 4.1 源码形态约束（动态插件）

- Host/Client 代码是**纯 JavaScript 函数体**（`return { apply(ctx) {...} }`），不做 TypeScript/JSX/bundler 转换。
- 禁止：TS 类型、`as`、装饰器、`import`、`require`、JSX。
- Client React 只能用 `React.createElement(...)`，绝不写 `<Component />`。
- 不假设 `process`、`Buffer`、`window`、`document`、`fetch`、原生定时器可用；先查对应平台 Builtins。

### 4.2 ctx.get vs inject

- 可选服务：`ctx.get('name')` 并处理 undefined。
- 硬依赖：`inject: ['name']`，之后才能 `ctx.name`；Guard 拒绝未声明注入的属性访问。
- 定时器是**服务**（`timer`，非 Builtin）：先 `ctx.get('timer')` 或 `inject: ['timer']`，再 `ctx.interval/timeout/throttle/debounce`；绝不使用 `setTimeout` 等全局定时器。

### 4.3 生命周期与副作用管理

- 所有副作用（服务/事件/工具/处理器/定时器/槽位/样式/主题覆盖）都必须属于当前 fiber。
- 用 `ctx.effect()`、`ctx.on()` 或返回 disposer 的官方 API 托管，保证 stop/update/undefine 时全部回收。
- 定时器回调返回 disposer，组件内 `useEffect` 的 cleanup 返回它。

### 4.4 事件监听规范

- 普通事件：`ctx.on('some/event', (payload) => ...)`。
- Waterfall 事件：**必须调用并返回 `next()`**，除非有意短路；不调用就断链。
- 事件 JSDoc 需要 `@mode` 与 payload `@param`；会话事件成员默认 required-on-read，需 `ignorable: true` 才能容忍未知类型。

### 4.5 数据约束（不序列化 live data）

服务实例、事件载荷、槽位 props、会话/对话快照、工具状态都是内部 live data：**不**对其 `JSON.stringify`/`structuredClone`/递归枚举/整体复制/整对象展示。只读取任务所需叶子字段，构造最小的自有 JSON 对象；RPC 返回值只能是纯 JSON。

### 4.6 Client UI 规范

- 先 `Slots.listSubTree` 查槽位协议（注册字段、props、占用者、替换风险），再写注册代码。
- 样式：`styles.insert(css)`（包级样式，随 Client run 清理）；改全局主题先查 `Theme.listTokens`。
- 数据就近原则：槽位 props 已有会话/工作区数据就直接用，不为已存在数据加 Host RPC。
- 悬浮/覆盖类 UI 放 `shell.overlay`（list 槽位，全新 `id` 并列添加，不替换任何内置条目）。

### 4.7 动态工具规范（Host）

`harness.defineTool` + `harness.registerTool(ctx, tool)` 注册下一模型步骤可调用的工具。参数与返回值必须 JSON 兼容；`execute` 拥有业务结果，render/展示只负责模型与原生 UI 所见。注册属于当前 fiber，stop/update 自动移除。注册前用 `Tool.listTools` 查冲突。

### 4.8 仓库包插件规范（packages/）

- 服务包默认导出服务类；函数插件具名导出 `name`/`inject`/`Config`/`apply` 且无默认导出（混用会被 Loader 丢弃命名空间）。
- 可选服务用 `ctx.get(name)`；注册走 `ctx.effect()`/`ctx.on()` 并证明可回收。
- 每个包拥有 `./invariant`（注册清单名，检查事件/数据关系或给出理由）。
- 产品可见插件需要非单元的真实组合测试；测试描述行为而非正确性；非平凡变更需 Agent Note。

### 4.9 沙箱兼容性要点

DSH 的 bash 执行器默认把命令包在沙箱下（macOS Seatbelt / Linux bwrap+landlock，默认 `read-only`：全盘可读、仅禁写）。注意：

- **macOS Seatbelt 拒绝执行 setuid-root 二进制**：`/bin/ps`、`/usr/bin/top` 直接 `Operation not permitted`；
- 改用非 setuid 替代：`iostat`（聚合 CPU）、`pgrep`（进程）、`lsof`（端口）、`sysctl`/`vm_stat`（内存）；
- Linux 下 bwrap 只读绑定 `/` 与 `/proc`，`ps`/`ss`/`/proc` 均可读。

## 5. 实战剖析：sysmon 系统监控插件

完整案例见 `my-plus/plugins/sysmon/`（manifest + host.js + client.js + README），此处给出设计决策链：

1. **需求**：页面右上角可拖动悬浮球，点击弹出面板显示 CPU/内存、Top 进程、监听端口。
2. **平台选型**：系统数据在 Host（shell 采集），展示交互在 Client → 双半区。
3. **UI 槽位**：`shell.overlay`（list、additive、点击穿透）——悬浮球与面板都注册于此，全新 id `sysmon-ball`，不遮蔽内置 UI。
4. **通信**：Host `harness.handle('sysmon-stats', handler)`，Client `host.call('sysmon-stats', {})`，每 4 秒 `timer.interval` 轮询。
5. **采集命令**：macOS 用 `iostat`/`pgrep`/`lsof`/`sysctl`/`vm_stat`；Linux 用 `/proc/stat`、`/proc/meminfo`、`ps --sort=-pcpu`、`ss -tlnp`（见 4.9 沙箱原因）。
6. **生命周期**：`ctx.effect(() => harness.handle(...))`、`ctx.effect(() => styles.insert(css))`；组件内 `useEffect` 返回 interval disposer。
7. **安装流程**：`cordis_define`（idPrefix `sysmon`）→ `cordis_run` → Web UI 批准 → 悬浮球出现；改版追加新 Package 后 `update`。

## 6. 常见问题与排错

| 症状 | 检查 |
| --- | --- |
| `service "x" is not declared` | 是否未声明 `inject: ['x']` 就用了 `ctx.x`；改用 `ctx.get('x')` 判空或声明硬依赖 |
| `cannot get property "timer" without inject` | 先查 `timer` 服务，声明 `inject: ['timer']` |
| Client 解析失败 | 是否用了 JSX/TS/import/不可用全局 |
| 槽位注册失败 | 是否查过实时子树、槽位存在、id/key/selector 满足协议 |
| UI 加载但页面报错 | 看 `client-render` 诊断与堆栈，定义新 Package 修复 |
| `host.call` 失败 | Host 处理方法名、当前 `pluginRunId`、JSON 参数、handler 内真实服务依赖 |
| 更新失败 | 保持 current/next 语义：修复 next 再 update，或 run current 回滚 |
| 审批被拒 | 不得自动重试或再次请求；用户拒绝即停 |
| macOS 命令 `Operation not permitted` | setuid 二进制被沙箱拒绝，换非 setuid 命令 |

## 7. 参考资料

- 官方：`docs/cordis-primer.md`（Cordis 五思想、分发模式、Waterfall 语义、Loader 配置）、`docs/architecture.md`（组合与扩展点）、`docs/cordis-tutorial/`
- 本仓库分析：`my-docs/00-分析报告/05-插件系统机制与场景.md`（两种形态/依赖/补丁层/isolate）
- 技能：`cordis-plugin-development`（动态插件开发全流程）、`editing-cordis-compositions`（组合编辑）
- 本仓库约定：`my-plus/README.md`（自定义插件仓库规范）、`my-plus/plugins/sysmon/`（实战案例）
