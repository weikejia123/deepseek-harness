# 工程化：测试、门禁与发布纪律

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

本文从工程质量角度分析 dsh 的测试基础设施、静态门禁与发布流程。结论先行：这个仓库把「agent 产品不可测试」的行业成见当作问题正面解决了，解法是架构红利的兑现——**事件溯源日志本身就是录制格式**。

## 测试金字塔

三层（根 `package.json` 与各 vitest config）：

| 层 | 命令 | 说明 |
|---|---|---|
| 单元 | `pnpm run test` / `test:coverage` | vitest；CI 门禁是 `packages/*/*/src` 的 **per-file 100%**（statements/branches/functions/lines） |
| 快照 | `pnpm run test:snapshot` | **keyless 回放**：无需 API key，对录制响应做端到端 diff |
| e2e | `pnpm run test:e2e` | 真实 API；`DEEPSEEK_API_KEY` 缺失自动 skip（22+ 处 `describe.skipIf`） |

## Keyless 快照回放：架构红利的兑现

机制核心在 `packages/test-support/llm-replay`：

- **回放脚本直接从 `assistant/chunk` 事件推导**——按 `finish` chunk 切分每次 `stream()` 调用；`compaction/summary` 标记的辅助 LLM 调用也还原成 canonical 流。因为「token 级 chunk 入日志」是产品设计，会话日志本身就是 record 格式，**不需要独立的录制层**；
- 回放安装成一个真 `LlmAdapter` 注册进 `ctx.llm`——**被测的是完整装配的应用**（cordis.yml → Loader → CLI/ACP 真实子进程），不是 mock 的循环；
- 三模式：`replay`（无 key 只读 fixture，可并行）/ `record`（真 API 重录，唯一读 `.env`）/ `refresh`（重放已提交脚本刷新期望输出）；
- `ReplayHandle` 拆除时做**消费检查**：场景发出的调用少于录制数 = 明确报错，杜绝「静默欠跑」的 fixture 漂移；
- 父子会话按 `createdAt` 排序绑定 first-call 顺序，支持 subagent 嵌套回放；`acp-snapshot` harness 进一步归一化 ACP 协议输出做 golden diff。

配套政策（AGENTS.md）：**每个非平凡的模型/用户可见行为变更必须在同 PR 附带 keyless snapshot**，且必须经真实可运行的 example 驱动——package 测试和 mock fixture 不算数。这条政策把「快照覆盖」从测试指标变成了评审纪律。

对照：LangGraph 生态依赖 langsmith 录制服务，Claude Code 无公开 replay 设施。无 key CI 能跑真实装配的端到端 transcript diff，是 dsh 测试体系与同类产品最大的代差。

## 静态门禁（hygiene + doc-sync）

`pnpm run hygiene` 与 `pnpm run doc-sync` 合计挂着二十多个门禁，值得注意的有：

- **knip + publint + workspace constraints + NodeNext consumer check**：依赖与发布的卫生；
- **jscpd 克隆检测**（`.jscpd.json`，minTokens 60，超阈值 exit 1）：跨文件复制粘贴直接失败；
- **verify-package-invariants**：每个包带 `invariant.ts` 运行时自检，且规则是「断言拥有的关系（事件流/可变数据），不断言服务存在性」——不变量测的是行为不是形状；
- **verify-export-jsdoc**：每个导出必须有契约级 JSDoc（`@param`/`@returns`），文档不是可选装饰；
- **生成物同步门禁**：tool catalog、config catalog、event producer-consumer 图、module graph、persistence catalog 等全部由源码生成并校验与提交物一致——文档无法腐化于代码之外；
- **lefthook pre-commit**：含行尾单换行门禁这类细节。

## Vendored 框架的治理

`vendor/` 9 个包按上游 commit SHA 固定（cordis 4.0.0-rc.7 等），全部 rescope 进 `@deepseek-ai/*` 随产品发布（避免占用上游包名）。**18 条本地修改逐条记录**在 `vendor/README.md`（fiber 生命周期重入加固、loader 事务化 reconciliation、HMR 精确 config 监听等），每条注明覆盖测试；sync 流程五步走（记 SHA → 拷 src → 重放本地修改 → 更新 manifest → 全量 test+build）。这种「fork 纪律」在 vendored 依赖的实践中属于教科书级。

## 发布流程

`scripts/release/`（bump/verify/pack/publish/verify-packed-install）：

- **family 制版本**：dsh 全家共享一个版本号（vendor 每包一条版本线但整族同发）；
- **CI 永不写仓库**：version bump 落在 manifest 的提交里，tag 由人在合并后创建；
- **凭证最小化**：pack 步骤无凭证运行、产出全部 tarball；publish 只发那些字节；
- `verify-packed-install` 验证打出的 tarball 实际可安装——发布产物有冒烟测试。

## 评价

这套工程体系的特点是**门禁与架构不变量互相指涉**：测试政策引用 model-visible ⟺ logged，覆盖率门禁支撑「预发布期优先正确地基」的立场，Agent Notes 与 PR 绑定保证决策可追溯。它不是贴上去的质量流程，而是架构设计的延伸。对个人开发者这是重量级负担；对一个要承载企业用户的 agent 平台，这是合理且少见的认真。
