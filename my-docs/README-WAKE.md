# deepseek-harness — DeepSeek 官方 Agent Harness（dsh）

| 维度 | 内容 |
|------|------|
| **用途** | DeepSeek AI 开发的开源 agent harness（`dsh`），核心架构「一切皆插件」（Everything is a Plugin），基于 vendored Cordis 构建 |
| **应用场景** | 构建可组合的 agent 运行时：LLM 能力（DeepSeek providers）、shell/subprocess/fs/lsp/web 能力、subagent 委派、workflow、plan 模式、ACP 自动化服务器、Web UI（默认 3080 端口） |
| **标签** | Agent Harness · DeepSeek · TypeScript · 插件化 · Cordis · ACP · Web UI |
| **技术栈** | TypeScript pnpm workspaces（packages/@deepseek-ai/dsh-* 约 30+ 包）；vendor Cordis；Python SDK（python/）；native landlock 插件（native/） |
| **内部版本** | V1-20260814 |
| **关联** | 上游 `deepseek-ai/deepseek-harness`（★68,763，MIT）；fork `weikejia123/deepseek-harness`；本地 `projects/coder-agent/deepseek-harness/`；Gitea `dzsoft/deepseek-harness` |

## 目录位置

`projects/coder-agent/deepseek-harness/` — 归入 coder-agent 分类目录（AI 编程 Agent 集合，与 codex/claude-code/grok-build/pi 等并列）。

## Fork 策略

- **Add-only**：不修改上游代码文件，仅新增 my-docs/ 本地文档
- 分支：`master` = upstream/master（纯净，同步上游）；`wkj-dev` = 二开分支
- 三远程：upstream（官方上游）/ origin（个人 fork）/ gitea（本地备份）

## 核心能力

| 能力 | 说明 |
|------|------|
| 一切皆插件 | Cordis 插件架构：LLM/shell/fs/lsp/web/subagent/workflow 等均为可组合插件 |
| LLM 能力 | Service Definition/Consumer + DeepSeek providers（llm 包） |
| 沙箱 | e2b（E2B 沙箱）+ native landlock（node-addon） |
| 会话 | dsh-session 持久化（SQLite SCHEMA_VERSION + SESSION_FORMAT_VERSION） |
| ACP | 纯自动化 Agent Client Protocol 服务器（automation-only） |
| 自修改 | self-modification 插件：agent 可检查/挂载自己的插件 |
| Web UI | `npx @deepseek-ai/dsh web` 启动，默认 http://127.0.0.1:3080 |
| 状态 | **Developer preview**：兼容性破坏性变更频繁 |

## 构建 / 运行

```bash
# 源码运行
pnpm install
pnpm run build
pnpm dsh web                    # Web UI（127.0.0.1:3080）

# 测试
pnpm run test                   # vitest 单元测试
pnpm run test:e2e               # 真实 API 测试（需 DEEPSEEK_API_KEY）
pnpm run typecheck && pnpm run lint
```

## 与目录内其他 Agent 的定位差异

- **deepseek-harness（deepseek-ai）** — DeepSeek 官方 harness，插件化架构 + 自修改能力
- **codex（openai）** — OpenAI 官方 CLI agent，Rust/Bazel
- **DeepSeek-Reasonix** — 独立 Go 实现（非官方），DeepSeek 原生、六形态
- **claude-code / grok-build / pi** — 各厂商/社区 CLI agent

## 评估记录

- 2026-08-14: 加入 fork（weikejia123/deepseek-harness），存 coder-agent/ 分类目录，分支 wkj-dev，Gitea 备份完成
