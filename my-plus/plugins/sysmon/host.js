// 系统监控插件 · Host 半区
// 通过 ctx.shell 运行只读命令采集 CPU / 内存 / 进程 / 监听端口，
// 经 harness.handle 暴露私有 RPC（sysmon-stats）给 Client 半区。
//
// 沙箱兼容性说明（macOS Seatbelt）：
//   /bin/ps 与 /usr/bin/top 是 setuid-root 二进制，sandbox-exec 拒绝执行 setuid 程序
//   （Operation not permitted），因此 macOS 上改用 /usr/sbin/iostat（聚合 CPU）与
//   /usr/bin/pgrep（进程列表，无单进程 CPU/内存）。lsof / sysctl / vm_stat 不受影响。
//   Linux（bwrap 只读绑定 /proc，landlock 全盘只读）下 ps / ss / /proc 均可读。
return {
  apply(ctx) {
    const shell = ctx.get('shell')
    if (shell === undefined) return

    let osName = null
    let cache = null
    let inflight = null

    const run = async (command) => {
      const spec = shell.resolve({ command, timeoutMs: 12000, stdoutMaxBytes: 2 * 1024 * 1024 })
      const res = await shell.run(spec)
      return res && res.stdout ? (res.stdout.text || '') : ''
    }

    const detectOs = async () => {
      if (osName) return osName
      try {
        osName = (await run('uname -s')).trim().toLowerCase() || 'unknown'
      } catch (e) {
        osName = 'unknown'
      }
      return osName
    }

    // —— CPU 与内存 ——
    const sampleSystem = async (os, errors) => {
      const empty = { cpu: { used: 0 }, mem: { totalKB: 0, usedKB: 0, percent: 0 } }
      try {
        if (os === 'darwin') {
          // 内存：hw.memsize（总字节）+ vm_stat（页计数）+ hw.pagesize
          const out = await run('sysctl -n hw.memsize; echo ---SEP---; vm_stat; echo ---SEP---; sysctl -n hw.pagesize')
          const parts = out.split('---SEP---')
          const totalBytes = parseInt((parts[0] || '').trim(), 10) || 0
          const pageSize = parseInt((parts[2] || '').trim(), 10) || 4096
          const vm = parts[1] || ''
          const num = (k) => {
            const m = vm.match(new RegExp(k + '\\s*:\\s*([0-9]+)'))
            return m ? parseInt(m[1], 10) : 0
          }
          const free = num('Pages free')
          const inactive = num('Pages inactive')
          const speculative = num('Pages speculative')
          const totalKB = Math.round(totalBytes / 1024)
          const usedKB = Math.max(Math.round((totalBytes - (free + inactive + speculative) * pageSize) / 1024), 0)
          const percent = totalKB > 0 ? Math.round((usedKB / totalKB) * 1000) / 10 : 0
          // CPU：iostat -c 2 最后一行末 6 列为 us sy id 1m 5m 15m
          const cpuOut = await run('/usr/sbin/iostat -c 2 2>/dev/null | tail -n 1')
          const cm = cpuOut.match(/([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+[0-9.]+\s+[0-9.]+\s+[0-9.]+\s*$/)
          const idle = cm ? parseFloat(cm[3]) : NaN
          const used = isNaN(idle) ? 0 : Math.round((100 - idle) * 10) / 10
          return { cpu: { used }, mem: { totalKB, usedKB, percent } }
        }
        // Linux：/proc/meminfo（MemTotal/MemAvailable）+ /proc/stat 双采样
        const memOut = await run("awk '/^MemTotal/{t=$2}/^MemAvailable/{a=$2}END{printf \"%d %d\", t, a}' /proc/meminfo")
        const mm = memOut.trim().split(/\s+/).map((x) => parseInt(x, 10) || 0)
        const totalKB = mm[0] || 0
        const usedKB = Math.max(totalKB - (mm[1] || 0), 0)
        const percent = totalKB > 0 ? Math.round((usedKB / totalKB) * 1000) / 10 : 0
        const cpuOut = await run("a=$(awk '/^cpu /{u=$2+$3+$4+$6+$7+$8+$9;i=$5;print u,i,u+i}' /proc/stat); sleep 0.5; b=$(awk '/^cpu /{u=$2+$3+$4+$6+$7+$8+$9;i=$5;print u,i,u+i}' /proc/stat); au=$(echo \"$a\"|cut -d' ' -f1); at=$(echo \"$a\"|cut -d' ' -f3); bu=$(echo \"$b\"|cut -d' ' -f1); bt=$(echo \"$b\"|cut -d' ' -f3); du=$((bu-au)); dt=$((bt-at)); if [ \"$dt\" -gt 0 ]; then awk -v du=\"$du\" -v dt=\"$dt\" 'BEGIN{printf \"%.1f\", 100*du/dt}'; else echo 0; fi")
        const used = Math.round(parseFloat(cpuOut.trim() || '0') * 10) / 10
        return { cpu: { used }, mem: { totalKB, usedKB, percent } }
      } catch (e) {
        errors.push('system: ' + String((e && e.message) || e))
        return empty
      }
    }

    // —— 进程列表（Top 10）——
    // macOS 沙箱内拿不到单进程 CPU/内存（ps/top 为 setuid），按 PID 倒序取最近启动的 10 个；
    // Linux 使用 ps 按 CPU 占用排序。
    const sampleProcesses = async (os, errors) => {
      try {
        if (os === 'darwin') {
          const out = await run('/usr/bin/pgrep -fl . 2>/dev/null | head -n 60')
          return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
            const sp = line.indexOf(' ')
            const pid = parseInt(sp > 0 ? line.slice(0, sp) : line, 10)
            return { pid: pid || 0, cpu: null, mem: null, name: sp > 0 ? line.slice(sp + 1) : '(unknown)' }
          }).sort((a, b) => b.pid - a.pid).slice(0, 10)
        }
        const out = await run('ps -eo pid=,pcpu=,pmem=,args= --sort=-pcpu | head -n 11')
        return out.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 10).map((line) => {
          const f = line.split(/\s+/)
          return {
            pid: parseInt(f[0], 10) || 0,
            cpu: Math.round((parseFloat(f[1]) || 0) * 10) / 10,
            mem: Math.round((parseFloat(f[2]) || 0) * 10) / 10,
            name: f.slice(3).join(' ') || '(unknown)',
          }
        })
      } catch (e) {
        errors.push('processes: ' + String((e && e.message) || e))
        return []
      }
    }

    // —— 监听端口 ——
    const samplePorts = async (os, errors) => {
      try {
        if (os === 'darwin') {
          const out = await run('lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | tail -n +2')
          return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
            const f = line.split(/\s+/)
            if (f.length < 9) return null
            const address = f.slice(8).join(' ').replace(/\s*\(LISTEN\)\s*$/, '')
            return { address: address || (f[f.length - 1] || ''), pid: parseInt(f[1], 10) || null, process: f[0] || '' }
          }).filter(Boolean)
        }
        const out = await run('ss -tlnp 2>/dev/null | tail -n +2')
        return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
          const f = line.split(/\s+/)
          if (f[0] !== 'LISTEN') return null
          const users = f.slice(5).join(' ')
          const pm = users.match(/pid=(\d+)/)
          const nm = users.match(/"([^"]+)"/)
          return { address: f[3] || '', pid: pm ? parseInt(pm[1], 10) : null, process: nm ? nm[1] : '' }
        }).filter(Boolean)
      } catch (e) {
        errors.push('ports: ' + String((e && e.message) || e))
        return []
      }
    }

    const handler = async () => {
      if (inflight) return cache || { pending: true }
      if (cache && Date.now() - cache.ts < 1500) return cache
      inflight = (async () => {
        const errors = []
        const os = await detectOs()
        const sys = await sampleSystem(os, errors)
        const processes = await sampleProcesses(os, errors)
        const ports = await samplePorts(os, errors)
        const seen = new Set()
        const uniquePorts = ports.filter((p) => {
          const k = p.address + '|' + p.pid + '|' + p.process
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        const result = { os, ts: Date.now(), cpu: sys.cpu, mem: sys.mem, processes, ports: uniquePorts, errors }
        cache = result
        return result
      })()
      try {
        return await inflight
      } finally {
        inflight = null
      }
    }

    ctx.effect(() => harness.handle('sysmon-stats', handler))
  },
}
