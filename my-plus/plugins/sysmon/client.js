// 系统监控插件 · Client 半区
// 在 shell.overlay 槽位注册一个可拖动的悬浮球：默认右上角，拖拽移动、点击展开面板。
// 面板每 4 秒通过 host.call('sysmon-stats') 拉取 Host 采集的系统数据。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const timer = ctx.get('timer')

    ctx.effect(() => styles.insert(`
.dsh-sysmon-ball {
  position: fixed;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, #7aa2ff, #4c6ef5 55%, #2f3fa8);
  box-shadow: 0 6px 18px rgba(30, 40, 90, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
  touch-action: none;
  z-index: 2147483000;
  pointer-events: auto;
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: -0.5px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
.dsh-sysmon-ball:hover { box-shadow: 0 8px 24px rgba(30, 40, 90, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.3); }
.dsh-sysmon-ball:active { cursor: grabbing; }
.dsh-sysmon-panel {
  position: fixed;
  width: 460px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  background: rgba(17, 20, 32, 0.94);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  color: #e6e9f2;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  z-index: 2147483001;
  pointer-events: auto;
}
.dsh-sysmon-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: sticky;
  top: 0;
  background: rgba(17, 20, 32, 0.96);
  border-radius: 14px 14px 0 0;
}
.dsh-sysmon-title { font-weight: 700; font-size: 13px; }
.dsh-sysmon-os { font-size: 11px; color: #9aa3c0; text-transform: uppercase; letter-spacing: 0.5px; }
.dsh-sysmon-close {
  margin-left: auto;
  cursor: pointer;
  border: 0;
  background: rgba(255, 255, 255, 0.08);
  color: #c6cbe0;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 1;
}
.dsh-sysmon-close:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
.dsh-sysmon-body { padding: 10px 14px 12px; display: flex; flex-direction: column; gap: 12px; }
.dsh-sysmon-section-title {
  font-size: 11px;
  font-weight: 700;
  color: #8f98bd;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin: 0 0 6px;
}
.dsh-sysmon-note { font-size: 10px; color: #6f7899; margin: -4px 0 4px; }
.dsh-sysmon-gauge { display: flex; align-items: center; gap: 10px; }
.dsh-sysmon-gauge-label { width: 34px; color: #c6cbe0; font-weight: 600; }
.dsh-sysmon-bar { flex: 1; height: 8px; border-radius: 4px; background: rgba(255, 255, 255, 0.1); overflow: hidden; }
.dsh-sysmon-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #4c6ef5, #7aa2ff); }
.dsh-sysmon-gauge-value {
  width: 150px;
  text-align: right;
  font-family: ui-monospace, Menlo, monospace;
  color: #e6e9f2;
  white-space: nowrap;
}
.dsh-sysmon-high .dsh-sysmon-bar-fill { background: linear-gradient(90deg, #f59f00, #ffc078); }
.dsh-sysmon-crit .dsh-sysmon-bar-fill { background: linear-gradient(90deg, #e03131, #ff8787); }
.dsh-sysmon-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.dsh-sysmon-table th {
  font-size: 10px;
  color: #8f98bd;
  text-align: left;
  font-weight: 600;
  padding: 2px 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.dsh-sysmon-table td { padding: 3px 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); font-size: 11px; vertical-align: top; }
.dsh-sysmon-table tr:last-child td { border-bottom: 0; }
.dsh-sysmon-num { font-family: ui-monospace, Menlo, monospace; text-align: right; color: #c6cbe0; }
.dsh-sysmon-name {
  color: #e6e9f2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sysmon-ports { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow-y: auto; }
.dsh-sysmon-port { display: flex; align-items: baseline; gap: 10px; padding: 3px 6px; border-radius: 6px; }
.dsh-sysmon-port:nth-child(odd) { background: rgba(255, 255, 255, 0.04); }
.dsh-sysmon-port-addr {
  font-family: ui-monospace, Menlo, monospace;
  color: #7aa2ff;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-sysmon-port-proc { color: #c6cbe0; font-family: ui-monospace, Menlo, monospace; }
.dsh-sysmon-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8f98bd;
  font-size: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 8px;
}
.dsh-sysmon-refresh {
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #c6cbe0;
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 11px;
  margin-left: auto;
}
.dsh-sysmon-refresh:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
.dsh-sysmon-err { color: #ff8787; font-size: 11px; }
`))

    const fmtKB = (kb) => {
      if (!kb) return '0 B'
      const units = ['KB', 'MB', 'GB', 'TB']
      let v = kb
      let i = 0
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
      }
      return v.toFixed(1) + ' ' + units[i]
    }

    function SysmonWidget() {
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)
      const drag = React.useState(() => ({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, moved: 0, vw: 1200, vh: 800 }))[0]

      const refresh = () => {
        host.call('sysmon-stats', {}).then((v) => {
          setData(v)
          setError(null)
        }).catch((e) => {
          setError(String((e && e.message) || e))
        })
      }

      React.useEffect(() => {
        refresh()
        if (!timer) return undefined
        return timer.interval(refresh, 4000)
      }, [])

      const handleDown = (e) => {
        const el = e.currentTarget
        const rect = el.getBoundingClientRect()
        const view = el.ownerDocument.defaultView || {}
        drag.active = true
        drag.startX = e.clientX
        drag.startY = e.clientY
        drag.baseX = pos ? pos.x : rect.left + rect.width / 2
        drag.baseY = pos ? pos.y : rect.top + rect.height / 2
        drag.moved = 0
        drag.vw = view.innerWidth || 1200
        drag.vh = view.innerHeight || 800
        try { el.setPointerCapture(e.pointerId) } catch (_err) { /* capture 非关键路径，忽略 */ }
      }

      const handleMove = (e) => {
        if (!drag.active) return
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy))
        const R = 30
        const nx = Math.min(Math.max(drag.baseX + dx, R), drag.vw - R)
        const ny = Math.min(Math.max(drag.baseY + dy, R), drag.vh - R)
        setPos({ x: nx, y: ny })
      }

      const handleUp = (e) => {
        if (!drag.active) return
        drag.active = false
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_err) { /* 忽略 */ }
        if (drag.moved < 6) setOpen((o) => !o)
      }

      const cpuUsed = data && data.cpu ? data.cpu.used : null
      const mem = data && data.mem ? data.mem : null
      const processes = data && Array.isArray(data.processes) ? data.processes : []
      const ports = data && Array.isArray(data.ports) ? data.ports : []
      const procCpuUnavailable = processes.length > 0 && processes[0].cpu == null

      const ballStyle = pos
        ? { left: pos.x, top: pos.y, transform: 'translate(-50%, -50%)' }
        : { right: 16, top: 16 }
      const ballText = cpuUsed === null ? '···' : String(cpuUsed) + '%'

      const ball = React.createElement('div', {
        className: 'dsh-sysmon-ball',
        style: ballStyle,
        title: '系统监控（拖拽移动，点击展开）',
        onPointerDown: handleDown,
        onPointerMove: handleMove,
        onPointerUp: handleUp,
        onPointerCancel: handleUp,
      }, ballText)

      const gaugeClass = (v) => {
        if (v == null) return 'dsh-sysmon-gauge'
        if (v >= 85) return 'dsh-sysmon-gauge dsh-sysmon-crit'
        if (v >= 60) return 'dsh-sysmon-gauge dsh-sysmon-high'
        return 'dsh-sysmon-gauge'
      }

      const cpuGauge = React.createElement('div', { className: gaugeClass(cpuUsed) },
        React.createElement('span', { className: 'dsh-sysmon-gauge-label' }, 'CPU'),
        React.createElement('div', { className: 'dsh-sysmon-bar' },
          React.createElement('div', { className: 'dsh-sysmon-bar-fill', style: { width: (cpuUsed == null ? 0 : Math.min(cpuUsed, 100)) + '%' } }),
        ),
        React.createElement('span', { className: 'dsh-sysmon-gauge-value' }, cpuUsed == null ? '--' : cpuUsed + '%'),
      )

      const memGauge = React.createElement('div', { className: gaugeClass(mem ? mem.percent : null) },
        React.createElement('span', { className: 'dsh-sysmon-gauge-label' }, '内存'),
        React.createElement('div', { className: 'dsh-sysmon-bar' },
          React.createElement('div', { className: 'dsh-sysmon-bar-fill', style: { width: (mem ? Math.min(mem.percent, 100) : 0) + '%' } }),
        ),
        React.createElement('span', { className: 'dsh-sysmon-gauge-value' },
          mem ? fmtKB(mem.usedKB) + ' / ' + fmtKB(mem.totalKB) + ' (' + mem.percent + '%)' : '--',
        ),
      )

      const fmtPct = (v) => (v == null ? '—' : String(v) + '%')
      const procRows = processes.map((p, i) =>
        React.createElement('tr', { key: String(p.pid) + '-' + i },
          React.createElement('td', null, String(i + 1)),
          React.createElement('td', { className: 'dsh-sysmon-num' }, String(p.pid)),
          React.createElement('td', { className: 'dsh-sysmon-num' }, fmtPct(p.cpu)),
          React.createElement('td', { className: 'dsh-sysmon-num' }, fmtPct(p.mem)),
          React.createElement('td', { className: 'dsh-sysmon-name', title: p.name }, p.name),
        ),
      )

      const procTable = React.createElement('table', { className: 'dsh-sysmon-table' },
        React.createElement('thead', null,
          React.createElement('tr', null,
            React.createElement('th', { style: { width: '26px' } }, '#'),
            React.createElement('th', { style: { width: '60px' }, className: 'dsh-sysmon-num' }, 'PID'),
            React.createElement('th', { style: { width: '52px' }, className: 'dsh-sysmon-num' }, 'CPU'),
            React.createElement('th', { style: { width: '52px' }, className: 'dsh-sysmon-num' }, 'MEM'),
            React.createElement('th', null, '名称'),
          ),
        ),
        React.createElement('tbody', null, procRows),
      )

      const sortedPorts = ports.slice().sort((a, b) => String(a.address).localeCompare(String(b.address)))
      const portRows = sortedPorts.map((p, i) =>
        React.createElement('div', { key: String(p.address) + '-' + String(p.pid) + '-' + i, className: 'dsh-sysmon-port' },
          React.createElement('span', { className: 'dsh-sysmon-port-addr', title: p.address }, p.address),
          React.createElement('span', { className: 'dsh-sysmon-port-proc' },
            (p.process || '(未知)') + (p.pid ? ' (' + p.pid + ')' : ''),
          ),
        ),
      )

      const panelStyle = pos
        ? {
            left: Math.min(Math.max(pos.x + 34, 8), drag.vw - 468),
            top: Math.min(Math.max(pos.y - 24, 8), drag.vh - 80),
          }
        : { right: 16, top: 74 }

      const updatedAt = data && data.ts ? new Date(data.ts).toLocaleTimeString() : '--'
      const dataErrors = data && Array.isArray(data.errors) && data.errors.length ? data.errors.join('; ') : ''

      const panel = React.createElement('div', { className: 'dsh-sysmon-panel', style: panelStyle },
        React.createElement('div', { className: 'dsh-sysmon-head' },
          React.createElement('span', { className: 'dsh-sysmon-title' }, '系统监控'),
          React.createElement('span', { className: 'dsh-sysmon-os' }, data ? data.os : ''),
          React.createElement('button', { className: 'dsh-sysmon-close', onClick: () => setOpen(false), title: '关闭' }, '×'),
        ),
        React.createElement('div', { className: 'dsh-sysmon-body' },
          error ? React.createElement('div', { className: 'dsh-sysmon-err' }, '错误: ' + error) : null,
          dataErrors ? React.createElement('div', { className: 'dsh-sysmon-err' }, dataErrors) : null,
          React.createElement('div', { className: 'dsh-sysmon-section-title' }, 'CPU 与内存'),
          cpuGauge,
          memGauge,
          React.createElement('div', { className: 'dsh-sysmon-section-title' }, '进程 Top 10'),
          procCpuUnavailable
            ? React.createElement('div', { className: 'dsh-sysmon-note' }, 'macOS 沙箱下无法读取单进程 CPU/内存，按 PID 倒序展示')
            : null,
          procTable,
          React.createElement('div', { className: 'dsh-sysmon-section-title' }, '监听端口 (' + sortedPorts.length + ')'),
          React.createElement('div', { className: 'dsh-sysmon-ports' }, portRows),
          React.createElement('div', { className: 'dsh-sysmon-foot' },
            React.createElement('span', null, '更新于 ' + updatedAt),
            React.createElement('button', { className: 'dsh-sysmon-refresh', onClick: refresh }, '刷新'),
          ),
        ),
      )

      return React.createElement('div', { className: 'dsh-sysmon-root' }, ball, open ? panel : null)
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'sysmon-ball', order: 1000, label: '系统监控悬浮球' },
      () => React.createElement(SysmonWidget, null),
    ))
  },
}
