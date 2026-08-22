# CHGR-20260822 官方代码同步报告（dsh 0.1.0-rc.7 → 0.1.1-rc.2）

- **日期**: 2026-08-22
- **分支**: master → wkj-dev（三方合并）
- **同步范围**: 上游 deepseek-ai/deepseek-harness 全仓库
- **上游范围**: `99f6f02fec`（0.1.0-rc.7）→ `b150a551b8`（0.1.1-rc.2）
- **新增标签**: `dsh-v0.1.0-rc.8`、`dsh-v0.1.1-rc.1`、`dsh-v0.1.1-rc.2`
- **合并提交**: `92f90cfdf6`（Merge branch 'master' into wkj-dev）
- **程序版本**: 0.1.1-rc.2（根 package.json）

## 一、同步概览

| 项目 | 数值 |
|---|---|
| 上游新增提交（含合并） | 743 |
| 实质提交（非合并） | 479 |
| 其中 feat / support | 50 |
| fix | 211 |
| refactor | 46 |
| test | 72 |
| docs | 66 |
| 上游修改文件 | 3319 |
| 上游新增包 | 227 |
| 上游删除文件 | 27 |
| wkj-dev 本地修改文件 | 32（全部保留） |
| 合并冲突 | 0（自动合并，无手动解决项） |

版本演进路径：**0.1.0-rc.7 → 0.1.0-rc.8（535 提交）→ 0.1.1-rc.1（172 提交）→ 0.1.1-rc.2（35 提交）**，rc.2 之后到 master 最新还有 1 个提交。

## 二、本次更新内容（按版本）

### 0.1.0-rc.8：基础设施与 Web UI 重构（535 提交）

**新增核心能力包（client 拆分重构）**：client 前端被拆分为 41 个独立包（`packages/client/ui-*` 系列），包括 ui-conversation、ui-settings、ui-subagent、ui-tool、ui-trajectory、ui-plan、ui-goal、ui-jobs、ui-workflow-run 等，每个 UI 组件独立成包，便于按需组合与插件化扩展。

**关键功能**：
- `feat(team)`：新增持久化 Agent Teams 运行时（多 agent 团队协作）
- `feat(subagent)`：Codex / Claude Code provider 直接可安装，支持命名实例与非交互权限模式
- `feat(pty)`：持久化 pwsh 工具 + Windows 最小预设栈（pty-local 的 pwsh 会话方言）
- `feat(subprocess)`：Windows 终端检查与信号处理
- `feat(web,cli)`：默认打开就绪的 Web UI
- `feat(llm-deepseek)`：支持多模态请求
- `feat(session)`：优化 SQLite 持久化布局
- `feat(client)`：通过 slots 组合部署品牌标识；注入公开构建环境
- `feat(workflow)`：用户可控制 run 与 phase 的可见性
- `feat(commands)`：composer 图片附件走斜杠命令路由
- `feat(web)`：模型选择器批量选择、插件加载进度、文件打开失败处理
- `feat(web)`：默认模型重试次数设为 5（refactor(llm): 集中部署重试默认值）
- `feat(feedback)`：消息反馈编辑器改为 popover 浮动
- `feat(python-sdk)`：支持打包的预设运行时依赖
- `feat(code-runtime-python)`：新增 fd-3 帧协议；TypedDict wire 镜像可执行化
- `feat(agent-loop)`：取消流时交付已发送前缀的收尾
- `support bounded multi-query web search`：有界多查询 web 搜索
- `feat(community,infra)`：README 资产通过 CDN 发布
- `feat(web)`：新增 file 与 session 引用

### 0.1.1-rc.1：凭据与授权体系（172 提交）

**新增凭据/授权能力包**：`packages/credentials/`（credentials、credentials-local、authorization）——将凭据引用升级为持久化凭据记录，授权由询问人类获取。

**关键功能**：
- `feat(authorization)`：通过询问人类获取凭据
- `feat(credentials)`：存储持久化凭据记录；启动时升级 pre-release 扁平文档
- `feat(llm-pi-ai)`：登录 provider 而非 withheld
- `feat(llm-deepseek)`：发布 vision 模型
- `feat(webserver)`：结构化 index 注入表与客户端 boot 接缝
- `feat(web)`：ask_user_question 支持多行回答；宽表格按列数自适应、悬停显示滚动条
- `feat(web)`：保留近乎满额的 cache-hit 精度
- `feat(atomic-write)`：写明 writer-lock 等待上限
- `feat(web)`：subagent header 切换器优化

### 0.1.1-rc.2：图片处理管线（35 提交）

**关键功能**：
- `feat(images)`：统一 master 与 Files 请求管线；扩展源上传信封
- `feat(tool-fs)`：read_image 报告缩放后尺寸与坐标比例
- `feat(attachment-local)`：存储确定性的规范图片编码

## 三、新增顶层/核心包清单（非 client）

| 领域 | 包 |
|---|---|
| 凭据/授权 | `credentials/credentials`、`credentials/credentials-local`、`credentials/authorization` |
| 代码运行时 | `code-runtime/code-runtime`、`code-runtime/code-runtime-python`、`code-runtime/code-runtime-worker-thread` |
| 反馈 | `feedback/command-feedback`、`feedback/message-feedback` |
| 目标 | `goal/goal`、`goal/goal-round-driver`、`goal/command-goal`、`goal/tool-goal` |
| 任务 | `jobs/jobs`、`jobs/jobs-local`、`jobs/tool-jobs` |
| 主机 | `host/webserver`、`host/apiproxy`、`host/frontend-static`、`host/directory-picker*`、`host/plugin-inventory` |
| MCP | `mcp/mcp-client` |
| 沙箱 | `sandbox/sandbox`、`sandbox/sandbox-local`、`sandbox/sandbox-policy`、`sandbox/sandbox-windows-acl` |
| Web 能力 | `web/web`、`web/tool-web`、`web/web-fetch-http`、`web/web-search-deepseek`、`web/web-search-exa`、`web/web-search-perplexity` |
| 扩展 | `extensions/cordis-client-runner`、`extensions/cordis-host-runner`、`extensions/tool-cordis`、`extensions/ui-cordis` |
| 运行时诊断 | `runtime-diagnostics/invariants` |
| 打包 | `bundle/web-app` |

## 四、合并方式与冲突处理

按 FORK-CONVENTIONS.md 同步流程执行三方合并：`git fetch upstream` → `master` 快进到 `upstream/master`（`git branch -f master upstream/master`）→ `merge master` 到 `wkj-dev`。

**合并结果：零冲突自动合并**。原因分析：

- 本次上游改动面广（3319 文件）但集中在 `packages/`、`docs/`、`scripts/`、`apps/` 等官方区域；
- wkj-dev 的 32 个本地修改文件中，仅 `.gitignore` 与 `AGENTS.md` 与上游改动重叠，且改动位于不同区域，git 自动合并成功；
- 其余 30 个本地文件（FORK-CONVENTIONS.md、my-docs/、my-chg-logs/、my-scripts/、TOKEN计费.md、vendor/ 等）上游未触碰，原样保留。

**保留的二开内容（对比合并前 wkj-dev HEAD 8b68fb9e，diff 均为 0）**：

| 文件 | 说明 |
|---|---|
| FORK-CONVENTIONS.md | 二开规约 |
| my-docs/（全部） | 自有文档 |
| my-chg-logs/ | 变更日志 |
| my-scripts/start-dev.sh | 开发启动脚本 |
| TOKEN计费.md | 计费记录 |
| vendor/cordis/src/{events,fiber,logger,utils}.ts | vendored Cordis 本地修改 |
| vendor/README.md | vendor 清单 |
| AGENTS.md fork-local 段 | 分支规约（3 处 fork-local 标记保留） |
| .gitignore 本地条目 | .kimi/、apps/cli/pnpm-workspace.yaml |

**上游引入的新内容**：AGENTS.md 新增 `experimental/` 目录说明与 credentials 描述更新；.gitignore 新增 `.dsh-build/`。

## 五、验证

- `pnpm install`（CI=true）：通过，246 个 workspace 项目
- `pnpm run build`：通过（exit 0），含 200 个 client 产物
- `pnpm run typecheck`：通过（exit 0，含 contracts-ready）
- 冲突标记扫描：无

## 六、Git 操作记录

- master：`99f6f02fec` → `b150a551b8`（快进，743 提交）
- wkj-dev：`8b68fb9e5e` → `92f90cfdf6`（Merge branch 'master' into wkj-dev）
- 推送：gitea（本地备份）`8b68fb9e5e..92f90cfdf6` ✅；未推送 origin（GitHub，按规约）

## 七、遗留事项

- 上游新增 `experimental/` 目录（私有原型，不参与官方发布），wkj-dev 未做特别处理；
- vendor/ 上游本次未改动，本地 Cordis 修改维持现状；上游 cordiverse/cordis 的 open PR 若后续合入可减少本地补丁（见上次同步报告遗留事项）；
- `apps/web` 前端包名未变（`@deepseek-ai/dsh-web-frontend`），my-scripts/start-dev.sh 兼容，无需改动。
