# DeepSeek Harness 深度分析文档索引

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（npm 包 `@deepseek-ai/dsh`，根 `package.json` 与 `apps/cli/package.json` 一致）
- **代码基点**：commit `9b94491444`（无 tag，pre-release 阶段）
- **分析对象**：`/Users/weikejia/CODE/my-agent-group/projects/coder-agent/deepseek-harness`

## 目录结构

| 文档 | 内容 |
|---|---|
| [architecture/overall-architecture.md](architecture/overall-architecture.md) | 整体架构设计：Cordis 基座、profile/bundle 组合、turn/step 循环、能力接缝 |
| [architecture/runtime-sequence-diagram.md](architecture/runtime-sequence-diagram.md) | 核心运行时主链路时序图：boot/组合 → 会话 → turn/step → 模型请求 → 工具执行的 Mermaid 时序 |
| [architecture/design-highlights.md](architecture/design-highlights.md) | 优于同类产品的设计亮点（对比 Claude Code / Codex / LangGraph） |
| [plugin-system/mechanism-and-scenarios.md](plugin-system/mechanism-and-scenarios.md) | 插件系统设计机制专项：加载器、补丁层、作用域、实际开发场景举例 |
| [subsystems/session-log-event-sourcing.md](subsystems/session-log-event-sourcing.md) | 会话日志与事件溯源：append-only 日志、surface 投影、fork/resume |
| [subsystems/context-engineering.md](subsystems/context-engineering.md) | 上下文工程：system prompt 装配、runtime context、compaction 事务 |
| [subsystems/security-sandbox.md](subsystems/security-sandbox.md) | 安全边界：沙箱链路、审批协议、凭证管理、远程沙箱迁移 |
| [engineering/testing-and-quality.md](engineering/testing-and-quality.md) | 工程化：keyless 快照回放、覆盖率门禁、发布纪律、vendored 框架 |
| [ecosystem/integration-surfaces.md](ecosystem/integration-surfaces.md) | 接入面与生态：CLI/Web/ACP/SDK/Subagent、self-modification、Ralph/goal |

## 阅读建议

先读 `architecture/overall-architecture.md` 建立全局图景，需要可视化运行时流程时读 `architecture/runtime-sequence-diagram.md`（五张 Mermaid 时序图），再读 `architecture/design-highlights.md` 看差异化论点；插件开发者直接读 `plugin-system/mechanism-and-scenarios.md`。其余文档按需选读，均可独立成篇。

## 分析方法说明

本分析基于三个维度的证据：仓库自带权威文档（`docs/architecture.md`、`AGENTS.md`、各包 README 与 JSDoc 契约）、源码直读（`packages/`、`vendor/`、`apps/`）、以及 `.agents/notes/` 中的设计决策记录。所有引用的文件路径均针对上述 commit 基点验证过。
