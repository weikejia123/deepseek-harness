# sysmon（系统监控悬浮球）

一个 DSH 动态 Cordis 插件：在 Web 页面右上角显示一个可拖动的悬浮球，点击展开系统监控面板。

## 功能

- 悬浮球：默认固定在右上角，显示当前 CPU 使用率；可拖拽到任意位置（位置仅保存在当前页面会话内）。
- 面板内容：
  - CPU 与内存：使用率进度条 + 已用/总量。
  - 进程 Top 10：PID / CPU / 内存 / 命令。
  - 监听端口：所有 TCP LISTEN 地址及对应进程名（PID）。
- 每 4 秒自动刷新，面板内也有手动刷新按钮。

## 采集实现（Host 半区）

| 数据 | macOS | Linux |
| --- | --- | --- |
| CPU | `/usr/sbin/iostat -c 2`（末 6 列 `us sy id 1m 5m 15m`） | `/proc/stat` 双采样 |
| 内存 | `sysctl hw.memsize` + `vm_stat` + `hw.pagesize` | `/proc/meminfo`（MemTotal/MemAvailable） |
| 进程 | `/usr/bin/pgrep -fl .`（无单进程 CPU，按 PID 倒序） | `ps -eo pid,pcpu,pmem,args --sort=-pcpu` |
| 端口 | `/usr/sbin/lsof -nP -iTCP -sTCP:LISTEN` | `ss -tlnp` |

## 沙箱兼容性（重要）

DSH 的 bash 执行器默认把命令包在 sandbox-exec（macOS Seatbelt）下运行。
Seatbelt **拒绝执行 setuid-root 二进制**，而 `/bin/ps` 与 `/usr/bin/top` 恰好是 setuid，
因此它们会以 `Operation not permitted` 失败。本插件因此：

- CPU 改用非 setuid 的 `iostat`；
- 进程列表改用非 setuid 的 `pgrep`（代价：macOS 下拿不到单进程 CPU/内存，面板会显示 `—` 并给出提示）；
- `lsof` / `sysctl` / `vm_stat` 均非 setuid，不受影响。

Linux（bwrap 只读绑定 `/` 与 `/proc`，或 landlock 全盘只读）下上述命令均可正常读取。

## 安装 / 更新到当前会话

动态插件只存在于当前 DSH 进程，源码以此目录为准。工作流：

1. 让 Agent 读取 `host.js` 与 `client.js` 的内容；
2. Agent 调用 `cordis_define`：`idPrefix` 取 `manifest.json` 中的 `idPrefix`（本插件为 `sysmon`），
   `code.host` / `code.client` 直接使用两个文件的内容；
3. 调用 `cordis_run` 激活（首次或从旧版本切换用 `update`）；
4. 在 Web UI 中批准后，页面右上角即出现悬浮球。
