# 20260819 session-orb 静态包加载失败排查（已验证结论）

## 现象

dsh web 启动后浏览器报：

```
Failed to load plugins
failed to import loader entry 6c41242a (@deepseek-ai/dsh-client-ui-session-orb):
client-modules: bundle script /plugins/@deepseek-ai/dsh-client-ui-session-orb/client.js?rev=32ec8b375968 failed to load
```

## 根因（已通过 git log 与现场验证）

1. `5b494a3ed9`（08-18 16:56）把 session-orb 客户端 UI 抽成静态包
   `@deepseek-ai/dsh-client-ui-session-orb`（packages/client/ui-session-orb），
   并注册进 `packages/bundle/web-app/cordis.patch.yml`（insert 行）与
   `packages/bundle/web-app/package.json` 依赖。
2. 运行中的 dsh web 进程会把该包计入 `__DSH_BOOT__` 启动图，浏览器按
   `/plugins/<包名>/client.js?rev=<hash>` 拉取 bundle。
3. `de096c4fd7`（08-19 04:40）整体回滚：删除包目录及 cordis.patch.yml /
   package.json / tsconfig / pnpm-lock 中的全部注册。
4. 报错来自"进程/页面还带着旧启动图，而 bundle 文件已被回滚删除"的窗口期：
   服务端 `/plugins/...` 路由对不在表中的 id 返回 404，浏览器即报
   "bundle script ... failed to load"，触发 AppRoot 的 Failed to load plugins 屏。

## 当前状态验证（08-19，全部通过）

- 仓库内无残留：`packages/bundle/web-app/cordis.patch.yml`、`package.json`、
  `pnpm-lock.yaml`、`tsconfig.base.json`、`tsconfig.client.json` 均无
  session-orb 引用；`packages/client/ui-session-orb` 目录已删除。
- `~/.dsh/profiles/web`（package.json 依赖、cordis.patch.yml、node_modules）
  无 session-orb 引用。
- 运行中的 `pnpm dsh web`（06:19 启动，晚于回滚提交）实测：
  `http://127.0.0.1:3080/` 注入的 `__DSH_BOOT__` 共 40 个 entry，无 orb；
  `/plugins/@deepseek-ai/dsh-client-ui-session-orb/client.js` 返回 404
  （即不在 clientModules 服务表中）。

## 结论与处置

- 该插件已无任何注册点，重启后不会再被加载；无需再做删除动作。
- 浏览器里若仍看到失败屏，是旧页面的缓存状态，硬刷新（或重启 dsh 后刷新）即消失。
- session-orb 后续一律走 my-plus/plugins/session-orb 动态插件形式
  （cordis_define + cordis_run），不再抽静态包。
