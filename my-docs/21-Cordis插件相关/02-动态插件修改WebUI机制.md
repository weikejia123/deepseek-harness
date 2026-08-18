# 动态 Cordis 插件修改 Web UI 的机制（DOM 增强实战）

- **文档更新时间**：2026-08-18
- **文档版本**：V1
- **dsh 程序版本**：`0.1.0-rc.5`（commit `12720b0ef9`，分支 `wkj-dev`）
- **实战来源**：`wspin-1`“工作区置顶”动态插件（Host 调 `workspaceRegistry.insertBefore` 持久化排序 + Client DOM 增强注入菜单项/金色文件夹图标；随后已按需求移除，本文沉淀其机制）

| 版本 | 更新时间 | 说明 |
| --- | --- | --- |
| V1 | 2026-08-18 | 初始版本：以“工作区置顶”插件为实例，沉淀动态插件修改 Web UI 的两条路线、执行环境边界、DOM 增强完整套路、数据走真实服务的正确姿势、审批流程与局限 |

本文回答一个问题：**当用户想要修改 dsh Web 界面（`http://127.0.0.1:3080`）里某个区域，而该区域没有 Slot 扩展点时，动态 Cordis 插件还能不能做到？** 答案：能，但分两条路，且有一条是“兜底路线”——DOM 增强。本文把两条路、判断标准、可复用的完整套路、以及踩过的边界全部记下来，供后续同类需求直接复用。

## 1. 结论先行：两条路与判断标准

| 路线 | 机制 | 适用场景 | 风险 |
| --- | --- | --- | --- |
| **正规路线：Slot 体系** | `ctx.slots.inject('目标slot', () => ctx.slots.register(...))`，向 Slot 树里已有的扩展点注册 UI | 目标区域有 Slot（侧边栏脚部 `sidebar.footer.action`、会话头部 `conversation.session.header.actions`、设置项、工具卡片等） | 低，受 Slot 契约约束 |
| **兜底路线：DOM 增强** | 动态 Client 半区直接操作浏览器 DOM（监听/注入/样式），数据变更仍走真实服务 | 目标区域**没有任何 Slot**，且替换整个 Slot 会遮蔽出厂 UI | 高，依赖当前 DOM 结构，产品改版即失效 |

**判断标准**（本次实战的核心教训）：

1. 先查 Slot 树：`cordis_inspect_query(platform: client, provider: Slots, method: listSubTree)`。`replaceRisk: "shadows-shipped-ui"` 的 Slot（如 `sidebar.workspaces` 整个左侧工作区区域）**不要整块替换**——那等于重写出厂组件（WorkspaceBrowser 约 1100 行 + 行组件 + 树推导 + CSS）。
2. 目标如果是**出厂组件内部的私有区域**（例如工作区行的“…”菜单项），且该组件没有声明任何子 Slot → 只能走 DOM 增强。
3. 数据层面如果有真实服务/注册表可驱动（如工作区排序有 `workspaceRegistry.insertBefore`）→ **数据变更必须走真实服务**，DOM 只做“没有数据面的展示层改动”（菜单项、图标颜色）。

## 2. 动态插件的执行环境（决定能做什么）

### 2.1 Client 半区：new Function 闭包，参数表即符号面

源码：`packages/extensions/cordis-client-runner/src/client/evaluator.ts`。Client 半区被包装为：

```js
new Function('React', 'console', 'styles', 'host', 'harness',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'fetch', 'require',
  'process', 'Buffer', `return (async () => { ...你的代码... })()`)
```

- **参数表里的符号可用**：`React`（无 JSX，用 `React.createElement`）、`console`（带包名标签）、`styles.insert(css)`（返回 disposer，卸载自动移除 `<style>`）、`host.call(method, args)`（调本包 Host 半区的 `harness.handle` 处理器）、`harness`（Client 侧是教学陷阱，碰即抛错）。
- **被遮蔽成“教学陷阱”的全局**：`setTimeout/setInterval/clearTimeout/clearInterval/fetch/require`——直接调用会抛错并提示正确做法（计时器用 `timer` 服务注入；网络归 Host 半区）。`process`/`Buffer` 为 `undefined`。
- **关键发现：`document` 未被遮蔽**。凡是不在参数表里的浏览器全局（`document`、`MutationObserver`、`Element`、`KeyboardEvent`、`Promise`、`Set` 等）都走 ambient 全局，**可以访问**——但不受保障、不在 Builtin 目录里。这是 DOM 增强路线的可行性基础，也是它“非正规”的原因。

### 2.2 Host 半区：VM 沙箱 + ctx 白名单 façade

- Host 半区在 VM 沙箱中求值，`apply(ctx)` 收到的是**白名单 ctx 门面**（`packages/extensions/cordis-host-runner/src/guard.ts` 的 `sandboxContext`）：
  - 生命周期动词白名单：`effect / on / once / provide / timeout / interval / setTimeout / setInterval / throttle / debounce`（计时器动词还需 `inject: ['timer']`）。
  - `ctx.get(name)` 是**可选查找**，无需 inject 声明，可读任意已注册服务（如 `workspaceRegistry`）——判空处理。
  - `ctx[name]` 属性访问**必须 inject 声明**，否则 Guard 拒绝。
  - 服务返回值过 `denyContext`：返回 Cordis `Context` 会被拒绝。
- Host Builtin：`harness.handle(method, handler)`（注册 Client 可调用的方法，返回 disposer）、`harness.defineTool`、`harness.registerTool`、`console`、`btoa/atob/TextEncoder/TextDecoder`。

### 2.3 动态插件生命周期

- 定义（`cordis_define`）→ 运行（`cordis_run`）→ **含 Client 半区时先要用户批准**（`awaiting-approval`，在 Web 面板允许）→ 批准后 Host 启动，页面自动拉取并激活 Client 半区（无需手动刷新）。
- 动态插件是**进程内/页面内**的：定义不落盘、重启即消失；每个浏览器标签页各自运行一份 Client 半区（Host 半区是全进程一份）。

## 3. DOM 增强完整套路（以“工作区置顶”为例）

目标：在左侧栏工作区行“…”菜单中，于“重命名”上方注入“置顶/取消置顶”；点击后工作区保持列表顶部、文件夹图标变金色。出厂组件（`ui-workspace` 的 WorkspaceBrowser/Rows）**没有任何菜单扩展点**，故走 DOM 增强。下面每一节都是可复用的套路。

### 3.1 目标识别：结构属性，绝不依赖哈希类名

CSS Modules 的类名是哈希的（如 `Rows_projectRow__a1b2c3`），不能用于选择。**用稳定的结构/语义属性定位**：

- 工作区行：`div[role="treeitem"][aria-expanded]`（会话行只有 `aria-selected`，无 `aria-expanded`，天然区分）。
- 行内第一个 `span` 是文件夹图标槽（`IconFolderClose16/IconFolderOpen16`，SVG 用 `fill="currentColor"`，所以给该 span 设 `color` 即可染色）。
- “…”按钮的 `aria-label` 携带工作区名（见 3.2），是行→身份的桥梁。
- 会话行菜单与工作区行菜单都含“重命名”，**用“同时含 重命名 和 删除工作区”判定工作区菜单**（会话菜单无删除项）。

### 3.2 上下文捕获：document capture 点击监听 + aria-label 解析

菜单是 portal 渲染的，从菜单 DOM 本身拿不到它属于哪个工作区。方案：**在 `document` 上挂 capture 阶段 click 监听**（先于 React 的 onClick 执行），命中“…”按钮时解析 aria-label 存入闭包上下文：

```js
// 中：工作区“NAME”的操作    英：Workspace actions for NAME
/^工作区“(.+)”的操作$/.exec(label) || /^Workspace actions for (.+)$/.exec(label)
```

键盘打开菜单（无点击）时回退读 `document.activeElement` 的 aria-label。语言（zh/en）也从模板样式判断，用于注入项的文案。

### 3.3 挂载检测：MutationObserver 盯 portal 菜单

`Menu` 组件（`packages/client/ui-primitives/src/Menu.tsx`）`portal` 模式下把列表渲染进 `document.body`，结构为 `div[role="menu"]` > `div`（itemWrap）> `button[role="menuitem"]` > `span`(icon) + `span`(label)。菜单每次打开都是**新建节点**，关闭即卸载。套路：

```js
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type !== 'childList') continue
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue
      if (node.matches('div[role="menu"]')) handleMenu(node)   // portal 列表直接挂 body
      else { const menu = node.querySelector('div[role="menu"]'); if (menu) handleMenu(menu) }
    }
  }
})
observer.observe(document.body, { childList: true, subtree: true })
```

MutationObserver 回调在微任务里跑，通常早于下一帧绘制，注入项基本无闪烁。

### 3.4 注入原生观感 UI：自建样式 + 主题变量

注入的菜单项不能复用哈希类名，做法是**自建类名 + `styles.insert()` 注入样式**，观感对齐出厂 Menu 项（抄 `Menu.module.css`：min-height 40、padding 8px 10px、radius 10、font 14/22、hover 背景用 `--dsw-alias-interactive-bg-hover`）。菜单项结构照抄：`div > button[role="menuitem"] > span(icon) + span(label)`，图标用内联 SVG。插入位置：`renameButton.parentElement.insertBefore(wrapper, renameButton.parentElement)`（“重命名”上方）。

主题适配：颜色用产品主题变量（`--dsw-alias-*`），明暗两套用 `body[data-ds-dark-theme]` 属性选择器覆盖（深色主题属性来自 `ui-theme`）。文件夹金色示例：

```css
:root { --dsh-ws-pin-gold: #b8860b; }
body[data-ds-dark-theme] { --dsh-ws-pin-gold: #e8b64a; }
div[role="treeitem"][aria-expanded][data-dsh-ws-pinned="1"] > span:first-child {
  color: var(--dsh-ws-pin-gold);
}
```

给行打 `data-dsh-ws-pinned="1"` 属性而非直接改内联色，样式收敛在一个 `<style>` 里，卸载时好清理。选择器特异性（属性+结构）高于出厂 `.folderActive`，无需 `!important`。

### 3.5 关闭应用自己的菜单

注入项是纯 DOM 节点，不经过 React 的 `onSelect`，Menu 不会自己关。`Menu` 组件在 `document` 上挂了原生 `keydown` 监听，**派发 Escape 即可关闭**：

```js
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
```

### 3.6 生命周期与清理：ctx.effect + disposer

全部 DOM 副作用放进一个 `ctx.effect(() => { ...; return cleanup })`，cleanup 里：移除 capture 监听、`observer.disconnect()`、执行 `styles.insert` 返回的 disposer、清掉打过的 `data-*` 属性。插件停止/更新/卸载时自动回收，不留残留。

## 4. 数据变更走真实服务，不要动 DOM 顺序

**最关键的架构决策**：置顶排序没有去挪 DOM 节点（React 重渲染会打回原形），而是走真实数据面——Host 半区直接调工作区注册表服务：

```js
const registry = ctx.get('workspaceRegistry')   // 可选查找，无需 inject
registry.list()                                  // Workspace[]：id/title/path/sessionIds
registry.insertBefore(id, firstId)               // 移到顶部（anchor 省略 = 追加到末尾）
registry.insertBefore(id, anchorId)              // 恢复到 anchor 之前
```

- **为什么列表会跟着变**：`insertBefore` 写入持久化的显示顺序，`api-proxy` 的 Host 帧流监听 `domain/changed`（workspace 域），推送 `host/workspace-order-changed` 帧；客户端 runtime 的 workspaces manager 收到帧后更新 store，`useWorkspaces` 驱动的侧边栏**响应式重排**——和拖拽排序完全同一条链路，天然不打架。
- **置顶语义**：Host 闭包内存维护 `pinned[]`（按 id，重命名不丢）+ 首次置顶时的全量顺序快照；置顶 = `insertBefore(id, 当前第一个)`；取消置顶 = 按快照找到“原本在它后面的第一个未置顶工作区”作 anchor 插回。
- **身份键**：Host 端按 id 记状态、按需取实时 title；Client 端 DOM 只能拿到 title（aria-label），因此 Client 镜像以 title 为键——UI 的重命名流程会阻止重名，实际可用，但 Host 底层允许重名（`Workspace` 文档明示 duplicates are allowed），重名是已知边界。

### 4.1 RPC 桥：harness.handle ↔ host.call

- Host：`ctx.effect(() => harness.handle('ws-pin-toggle', (args) => toggle(args)))`（返回值 JSON 化；handler 抛错时调用方收到 reject）。
- Client：`host.call('ws-pin-toggle', { title })`——返回 handler 的**裸返回值**；handler 抛错或信封非 ok 时 **Promise reject**（见 `cordis-client-runner/src/client/index.ts` 的 invoke 解包）。因此领域错误（如“工作区不存在”）应作为 `{ ok: false, error }` 返回值返回，而不是 throw。

### 4.2 状态镜像

Client 半区维护一份 pin 标题的镜像 `Set`，在插件启动、每次 toggle 后、每次菜单打开时（注入前/后）用 `host.call('ws-pin-list')` 刷新；行颜色由镜像 + MutationObserver 里的微任务去重刷新（`Promise.resolve().then(...)` 做批内去重，避免每次 DOM 变更都发 RPC）。重命名后镜像随下一次刷新自愈。

## 5. 审批与激活流程（DOM 增强插件同样适用）

1. `cordis_define`（仅定义，不执行）→ 返回 `pluginId/packageId`。
2. `cordis_run`（mode: run）→ 含 Client 半区时返回 `awaiting-approval`，**必须由用户在 Web 面板允许**（单勾授权当前版本，双勾授权后续版本）。
3. 批准后 Host 半区启动，页面自动激活 Client 半区；`currentPackageId` 更新为成功版本。
4. 修复 = 同一 pluginId 追加新 Package（`cordis_define` kind: existing）→ `cordis_run` mode: update；停用 = `cordis_stop`；永久删除 = `cordis_undefine`。

## 6. 局限与风险（必须如实告知用户）

- **依赖当前 DOM 结构**：产品改版（改 Menu 结构、改 aria 模板、改行结构）即失效，需要随版本跟进。这是“非正规路线”的固有代价。
- **进程/页面级生命周期**：插件与置顶标记都是内存态，DSH 进程重启即消失（工作区排序本身是持久化的，会停留在被移动到的位置）；每标签页各一份 Client 半区。
- **无持久化设置**：动态插件不建议做持久化存储（skill 指引），交互状态放内存即可。
- **身份按标题**：重名工作区（Host 允许）会解析到第一个匹配。
- **仅分组视图有工作区行**：单列表/搜索视图没有工作区行，注入点只在“按工作区”视图出现。
- **不强制锁定**：置顶只是移动到顶部，不阻止用户后续手动拖拽移动。

## 7. 附录：实战关键事实速查（可复查的源码锚点）

| 事实 | 位置 |
| --- | --- |
| Client 半区闭包参数表 / 教学陷阱 / document 未被遮蔽 | `packages/extensions/cordis-client-runner/src/client/evaluator.ts` |
| Host ctx 白名单门面（ctx.get 免注入、属性需 inject、denyContext） | `packages/extensions/cordis-host-runner/src/guard.ts`（`sandboxContext`） |
| host.call 返回裸值、handler 抛错即 reject | `packages/extensions/cordis-client-runner/src/client/index.ts`（invoke 解包） |
| 工作区行/菜单 DOM（role=treeitem、aria-expanded、aria-label 模板、文件夹 currentColor） | `packages/client/ui-workspace/src/client/rows/Rows.tsx` |
| Menu portal 结构（div[role=menu] 进 body、button[role=menuitem]、Escape 关闭） | `packages/client/ui-primitives/src/Menu.tsx` |
| 菜单项观感数值 | `packages/client/ui-primitives/src/Menu.module.css` |
| 深色主题属性 `body[data-ds-dark-theme]` | `packages/client/ui-theme/src/client/index.ts` |
| 工作区注册表服务（list/insertBefore/get/create/delete/archiveSession） | Host `Service.listService`（`workspaceRegistry`）；`packages/workspace/workspace/src/index.ts` |
| Host 帧流：workspace 域变更 → `host/workspace-order-changed` | `packages/host/apiproxy/src/api-proxy.ts`（host frame 流） |
| 客户端按帧安装新顺序 | `packages/client/runtime/src/client/workspaces/manager.ts`（insertBefore / handleHostEnvelope） |
| 工作区重名允许、未来 unarchive | `packages/workspace/workspace/src/types.ts`、`README.md` |
| 归档会话无查看/取消归档界面（Known Limitations） | `packages/client/ui-workspace/README.md` |

## 8. 决策速查（下次直接照用）

- 目标区域有 Slot？→ 走 Slot 注册，别碰 DOM。
- 目标在出厂组件内部、无 Slot、且整块替换代价过大？→ DOM 增强：结构属性定位 + capture 监听捕获上下文 + MutationObserver 盯挂载 + 自建样式注入 + ctx.effect 清理。
- 需求涉及数据排序/持久化？→ 找真实服务（Host 半区 `ctx.get` 调注册表/服务），让 GUI 经帧流自动刷新；DOM 只负责展示层。
- 中英文界面都要支持？→ 从 aria-label 模板识别语言，注入文案跟随。
