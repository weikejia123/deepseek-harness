# 安全边界：沙箱、审批与凭证

- **分析时间**：2026-08-14 13:45:40 CST
- **项目版本**：`0.1.0-rc.5`（commit `9b94491444`）

本文跟踪一次工具调用从模型意图到操作系统边界的完整链路，分析 dsh 的安全架构。核心论点：**安全策略不是硬编码的开关，而是接缝上的可替换服务 + 逐调用携带的策略 + 落日志的审计面**。

## 一次 Bash 调用的完整链路

```text
model → tool-bash (Consumer, args 校验 + escalation 配对)
      → ctx.shell.resolve(request): ShellExecSpec   ← 显式两段式，默认是显式解析步骤
      → bash-sandbox (Provider)
      → ctx.sandbox.wrap(argv)                       ← 按 SandboxPolicy 包裹命令行
      → sandbox-local 选 runner（平台探测）
      → subprocess-local spawn（进程树 + 环境清洗）
```

沿途每一层都是可替换的插件行。

## 工具层：把权限协议写成模型可读的契约

`tool-bash`（`packages/shell/tool-bash/src/index.ts`）的 args 校验强制 escalation 配对：`sandbox_permissions` 必须与 `justification` 同现。工具描述内嵌完整升级规程：被拒绝后同一 turn 内可用 `sandbox_permissions` 带理由重试一次（这是唯一受 sanction 的例外）；`never` 策略下 denial 即终局。**权限协议是提示词的一部分**，模型知道规则、知道如何合规地请求升级，而不是撞墙后乱试。

工具定义层面还有两道通用防线（`packages/core/tools`）：

- `tools/pre-execute` waterfall 是 allow/deny/ask 门；无 approval 支持时 ask **降级为拒绝**（fail-closed）；
- `tools/execute` 的 around-dispatch wrapper 只能替换 `exec.signal`，registry 在 body 执行前**重新融合原始 caller signal**——包装器无法让工具脱离调用方的取消；
- 超时由 `guard/timeout-policy` 以 signal-swap 实现（`using d = deadline(exec.signal, ...)`），只有自己的计时器触发才替换结果为结构化 `TOOL_TIMEOUT`——不 race、不抛弃已启动的 promise。

## 沙箱接缝：per-call policy + 诚实上报

`packages/sandbox/sandbox` 的 Service Definition：

- `SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'`（词汇与 Codex 同源）；
- **`SandboxPolicy` 随每次调用携带**——两个 Consumer 可同时用不同策略，升级重试就是带更宽策略的新调用；
- `SandboxEnforcement = 'full' | 'partial'` **诚实上报**实际强制力；
- 沙箱缺失/不可用 = fail closed，错误归因严格区分：runner 启动失败 → `SANDBOX_UNAVAILABLE`（命令根本没执行），runner 失败优先于 denial 分类，`result.sandbox` 报告实际 mode/enforcement/denied。

### 本地 runner 链（`sandbox-local`）

| 平台 | 机制 |
|---|---|
| Linux | bwrap → Landlock 链 |
| macOS | Seatbelt（`sandbox-exec -p`） |
| Windows | ACL restricted-token runner（每 workspace 派生写 SID + 每会话随机私有 temp SID） |

每个 runner 做**功能性探测**（真跑 `true` 验证内核接受 profile），探测不了即声明 unusable——不靠平台名猜测能力。

`native/landlock-run` 值得单独看：约 300 行 C11、musl 静态链接的 self-restrict-then-exec launcher——先对自己装 Landlock ruleset 再 `exec`，ruleset 跨 execve 继承，**被包裹命令及其全部子进程受限而宿主 harness 进程不受限**；内核不能强制则退出不执行。按平台 npm 包分发，无 install-time 构建回退（避免编译环境差异成为攻击面或故障源）。

### fs 侧：containment 不做文本近似

`fs-sandbox/containment.ts`：词法快路径之外，用文件系统身份（dev+ino）回退识别 Windows 8.3 短名别名和大小写等价——路径包含判断不会被 `PROGRA~1` 之类的别名绕过。

### 进程管理（`subprocess-local`）

detached 进程树 spawn、tail-keep 输出收集 + spill 文件、POSIX 进程组 / Windows taskkill 树级信号、SIGTERM→SIGKILL 阶梯、`scrubbedParentEnv()` 环境清洗。

## 审批：事件溯源的审计面

`packages/interaction/user-approval`：

- `approval/asked` + `approval/decided` 成对的 **log-only 审计事件**（不进模型 transcript）；
- `approval/policy` 记录会话策略切换（`ask`/`never`；`never` 是 CI/headless 的确定性姿态）；
- `effectiveApprovalPolicy(events)` 是**纯 fold**——回放日志就是状态，没有第二份审批状态可失同步；
- 审计对必须 turn-enclosed：turn 外的裸事件被当作崩溃截尾静默丢弃——审计合法性由 turn 边界保证；
- `permission-presets` 把 sandbox-mode × approval-policy 打包成用户可切换预设。

## 凭证：配置携带引用，不携带秘密

`packages/credentials` 的规则一句话：「Configuration carries references, not secret values. Consumers resolve those references at their operation boundary」。配置文件里是 `CredentialRef`，运行时按操作解析；DeepSeek provider 的 bearer token 按请求解析且只能来自与端点同一次解析——配置热更新时不会出现「新 URL + 旧密钥」的错配。遥测默认全本地，`DSH_TELEMETRY_MODE` 显式开启才外流，且文档明确警告「无默认脱敏规则」（`apps/cli/reference/README.md:78`）——默认关闭是刻意的部署决策。

## 评价

同类产品的安全模型大多是「静态配置 + 进程级开关」（CC 的 settings 权限表、Codex 的全局 sandbox mode）。dsh 把它提升为动态协议：策略逐调用携带、升级有模型可读的规程、每次决策落日志可回放、强制力诚实上报。这套设计的成本是概念多（policy/enforcement/mode/approval 四个正交轴），收益是**安全态势本身成为可审计、可组合、可测试的产品行为**——对企业的合规叙事而言，这比任何单一沙箱技术都值钱。
