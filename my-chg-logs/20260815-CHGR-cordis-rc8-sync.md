# CHGR-20260815 cordis 官方代码同步分析报告

- **日期**: 2026-08-15
- **分支**: master → wkj-dev
- **同步范围**: vendor/ 下 vendored Cordis 框架包
- **上游**: cordiverse/cordis(官方), shigma/cosmokit, shigma/schemastery

## 一、官方更新核查结论

对 9 个 vendored 包逐一比对官方仓库(npm gitHead + 官方 git 历史):

| 包(固定版本) | 官方最新 | 是否有更新 |
|---|---|---|
| **cordis** 4.0.0-rc.7 | **4.0.0-rc.8**(2026-08-10 发布) | ✅ **有** |
| loader 1.0.0-rc.5 | 1.0.0-rc.5(npm gitHead == 固定 commit,src 无改动) | ❌ |
| include/group/timer/hmr/logger-console | npm 版本均等于固定版本,官方 src 无改动(仅 chore bump) | ❌ |
| cosmokit 1.8.1 | 官方 shigma/cosmokit HEAD == npm 1.8.1 发布 commit | ❌ |
| schemastery 3.18.0 | packages/core 自 3.18.0 后无提交(后续仅 packages/form) | ❌ |

## 二、cordis rc.8 变更内容(固定 commit 56b3d4f7 → main 8cc9e33)

上游 main 共领先 8 个 commit,其中 6 个实质修复 + 2 个 chore:

| Commit | 内容 | 涉及文件 |
|---|---|---|
| eb5604d | fix: info/warn 日志级别交换(WARN=1, INFO=2) | logger.ts |
| fd96b0a | fix: logger exporter 释放(删除捕获的 exporter id 而非自增号) | logger.ts |
| 29581f6 | perf: 事件分发避免逐次绑定回调,未监听时跳过 internal/dispatch 探测 | events.ts |
| be7d36e | fix: 影子应用到可调用服务(继承属性描述符查找) | utils.ts |
| 752dbee | fix: 包装 fiber 状态保持规范(restart/update 委托 ctx.fiber) | fiber.ts |
| 8abd903 | fix: 跟踪直接服务调用者(symbols.caller) | utils.ts, logger.ts |

## 三、同步方式与本地修改合并

按 vendor/README.md 同步流程,对 4 个变更的 src 文件做三路合并(base=56b3d4f7, ours=本地 fork 版, theirs=8cc9e33):

- **events.ts**(1 处冲突): 采用上游 _resolve + 弃用 dispatch 包装;保留本地 JSDoc。harness 大量调用 ctx.events.dispatch(...),上游保留该 API(仅标记 @deprecated),无破坏。
- **fiber.ts**(1 处冲突): 保留本地 lazy-config 解析(本地修改 #15,上游 #41 未合入),同时采用上游的 ctx.fiber 委托(本地修改 #6 的 fiber 生命周期硬化全部保留)。
- **logger.ts / utils.ts**: 自动合并无冲突。
- 本地修改 #4(.ts 后缀)、#7(JSDoc)、#10、#15、#16、#17 均保留。

其他文件(context/registry/reflect/service/index.ts)上游未改动,保持原样。vendored README.md 为 harness 自撰,不上游同步。

## 四、验证

- vendor/cordis 单独编译:通过
- pnpm run build:lib:host:通过(exit 0,无 TS 错误)
- pnpm run test:见测试结果
- 行为注意:LoggerLevel 数值交换为 cordis 内部行为,harness 无直接依赖该枚举的代码(session-telemetry-otel 使用自己的 OTel 映射)。

## 五、Git 操作

- master: 提交 vendor/cordis src 同步 + vendor/README.md 清单更新(rc.7→rc.8, commit 56b3d4f7→8cc9e33,新增本地修改日志 #19)
- wkj-dev: 合并 master
- @deepseek-ai/cordis 包版本保持 4.0.1(版本 bump 属 release commit 决策,建议下次发布 bump 至 4.0.2)

## 六、遗留事项

- 上游 cordiverse/cordis 有 17 个 open PR,其中多个是本仓库本地修改的上游化且**未合入 main**: #39(fiber 可重入生命周期,对应 #6)、#41(lazy config,对应 #15)、#47/#57(include 串行化/补丁重放)、#53(timer)、#54/#44/#52/#51/#56/#55 等。待这些 PR 合入后再同步可减少本地补丁。
- deepseek-harness org 下所有 fork 仓库为私有,无法匿名核对;本次结论基于 npm gitHead + 官方公开仓库内容比对。
