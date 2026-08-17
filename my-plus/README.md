# my-plus —— 自定义 DSH 插件仓库

本目录统一存放我们自己开发的 DSH 插件源码（动态 Cordis 插件）。每个插件一个子目录，
源码以 `my-plus` 为唯一事实来源，通过 Agent 工作流安装到当前 DSH 会话运行。

## 目录结构

```
my-plus/
├── README.md               # 本文件：总览与约定
├── plugins/                # 每个自定义插件一个子目录（目录名 = 插件 id）
│   └── <plugin-id>/
│       ├── manifest.json   # 插件元数据（必填字段见下）
│       ├── host.js         # Host 半区源码（纯 JS 函数体，返回 Cordis Plugin；可省略）
│       ├── client.js       # Client 半区源码（纯 JS 函数体，返回 Cordis Plugin；可省略）
│       ├── README.md       # 插件说明：功能、采集实现、沙箱注意、安装方式（建议）
│       └── assets/         # 可选：插件附带资源（图片等）
└── scripts/
    └── check.mjs           # 校验所有插件的 manifest 与源码语法（node scripts/check.mjs）
```

## 插件规范

### 目录与命名

- 目录名即插件 id：小写字母 + 数字 + 连字符（kebab-case），如 `sysmon`。
- `manifest.json` 必填字段：

| 字段 | 说明 | 约束 |
| --- | --- | --- |
| `id` | 插件 id，必须与目录名一致 | kebab-case |
| `name` | 展示名（cordis_define 的 `name`） | 任意字符串 |
| `purpose` | 一句话用途（cordis_define 的 `purpose`） | 任意字符串 |
| `idPrefix` | cordis_define 的 `idPrefix` | 3–6 位小写英文字母 |
| `version` | 插件源码版本（语义化版本） | 可选 |

- `host.js` / `client.js`：**纯 JavaScript 函数体**（`return { apply(ctx) {...} }`），
  不做 TypeScript / JSX / import 转换。只写实际需要的半区；单半区插件可缺省另一文件。

### 源码约定

- Host 半区：通过 `ctx.get('shell')` 等可选服务采集数据，用 `harness.handle(method, handler)`
  暴露私有 RPC；所有副作用放入 `ctx.effect()`。
- Client 半区：通过 `slots.inject(...)` + `slots.register(...)` 注册 UI，用
  `host.call(method, args)` 调 Host RPC；样式用 `styles.insert(css)`，定时器用 `timer` 服务。
- 只读系统命令请在插件 README 里记录沙箱兼容性（见 `plugins/sysmon/README.md` 的例子）。

## 工作流

### 新增一个插件

1. 在 `plugins/` 下新建 `<plugin-id>/` 目录，写入 `manifest.json` 与所需源码文件；
2. 运行 `node scripts/check.mjs` 校验；
3. 让 Agent 读取 `host.js` / `client.js` 内容，调用 `cordis_define`（`idPrefix` 取自 manifest），
   再 `cordis_run` 激活，最后在 Web UI 中批准。

### 更新一个已安装的插件

1. 修改 `my-plus` 下的源码文件并更新 `manifest.json` 的 `version`；
2. Agent 用 `cordis_define`（kind: existing，沿用原 pluginId）追加新 Package；
3. `cordis_run` 以 `update` 模式切换到新版本。

### 校验

```sh
node scripts/check.mjs
```

逐个检查：manifest 必填字段、id 与目录名一致、idPrefix 格式、源码文件存在且可解析为函数体。

## 注意事项

- 动态插件只在当前 DSH 进程内存在，进程重启后需要重新安装；`my-plus` 中的源码是持久化的事实来源。
- 不要修改 DSH 部署自带的 `agent-presets` 或 `packages/` 下的代码；自定义内容一律放在 `my-plus/`。
- macOS 沙箱下 setuid 二进制（如 `/bin/ps`、`/usr/bin/top`）无法执行，采集命令需选用非 setuid 替代品。
