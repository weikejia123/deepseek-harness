// 会话状态球 · Client 半区（纯客户端实现，无需 Host 半区）
// 数据来源：shell.overlay 标准 props 的 useSessions / useWorkspaces 快照选择器 hook（实时推送，无需轮询）；
// 跳转动作：ctx.sessions.open(id)。会话状态语义直接复用侧边栏：
//   running             → 运行中
//   completed           → 完成但未选择未打开（侧边栏绿色"完成"提醒）
//   pendingInteraction  → 等待用户交互（approval 审批 / plan-review 方案确认 / question 提问）
//
// 交互设计（一瞥即知，平静优先，仅在有变化时升级提示）：
//   中心数字 = 顶层会话总数；外圈 conic 弧 = 运行中占比（工作量）；右上徽标 = 需要你注意的数量。
//   常态蓝（空闲）→ 暖橙呼吸（有运行中）→ 红色徽标脉冲（完成待查看 / 等待交互，仅计数变化时重播一次）。
//   悬停提示一行摘要；点击展开面板（需注意 → 运行中 → 其他，各段内保持时间倒序），点击行跳转会话；拖拽可移动。
//   会话行两行布局：第一行 状态点+标题+状态标签，第二行 归属项目（蓝）+相对时间（灰）。
//   归属项目三级来源：① 工作区 sessionIds 权威账目 → 工作区 title（支持重命名）；
//   ② 会话 cwd 与工作区 path 精确/最长前缀匹配；③ cwd 目录名兜底。
//   标题本身已是项目名（未命名会话）时不重复显示项目行。
//   完成未查看可"全部标为已读"（页面会话期内本地记认；当前正在查看的会话不计数）。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const sessionsSvc = ctx.get('sessions')
    const timer = ctx.get('timer')

    ctx.effect(() => styles.insert(`
.dsh-orb-ring {
  position: fixed;
  width: 62px;
  height: 62px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2147483000;
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
}
.dsh-orb-ring:active { cursor: grabbing; }
.dsh-orb-ball {
  position: relative;
  width: 54px;
  height: 54px;
  border-radius: 50%;
  background: radial-gradient(circle at 32% 30%, #7aa2ff, #4c6ef5 55%, #2f3fa8);
  box-shadow: 0 6px 18px rgba(30, 40, 90, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
  -webkit-user-select: none;
  color: #fff;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.5px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35);
}
.dsh-orb-ball.working {
  background: radial-gradient(circle at 32% 30%, #ffd43b, #f59f00 55%, #b25e09);
  animation: dshOrbBreathe 2.4s ease-in-out infinite;
}
.dsh-orb-ball.attention { box-shadow: 0 6px 18px rgba(30, 40, 90, 0.45), 0 0 0 3px rgba(255, 77, 79, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.28); }
@keyframes dshOrbBreathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.07); }
}
.dsh-orb-badge {
  position: absolute;
  top: -7px;
  right: -7px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: #f59f00;
  border: 1.5px solid rgba(255, 255, 255, 0.85);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 15px;
  text-align: center;
  font-family: ui-monospace, Menlo, monospace;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
}
.dsh-orb-badge.attention { background: #fa5252; animation: dshOrbPulse 1.5s ease-in-out 3; }
@keyframes dshOrbPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.22); }
}
.dsh-orb-panel {
  position: fixed;
  width: 400px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  background: rgba(17, 20, 32, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  color: #e6e9f2;
  font-size: 12px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  z-index: 2147483001;
  pointer-events: auto;
}
.dsh-orb-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  position: sticky;
  top: 0;
  background: rgba(17, 20, 32, 0.97);
  border-radius: 14px 14px 0 0;
}
.dsh-orb-title { font-weight: 700; font-size: 13px; }
.dsh-orb-chip { font-size: 10px; color: #9aa3c0; background: rgba(255, 255, 255, 0.07); border-radius: 8px; padding: 1px 7px; }
.dsh-orb-chip.hot { color: #ffa8a8; background: rgba(250, 82, 82, 0.16); }
.dsh-orb-chip.warm { color: #ffd43b; background: rgba(245, 159, 0, 0.16); }
.dsh-orb-close {
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
.dsh-orb-close:hover { background: rgba(255, 255, 255, 0.18); color: #fff; }
.dsh-orb-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 12px; }
.dsh-orb-section-title {
  font-size: 11px;
  font-weight: 700;
  color: #8f98bd;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  margin: 0 0 6px;
}
.dsh-orb-rows { display: flex; flex-direction: column; gap: 2px; }
.dsh-orb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  flex-wrap: wrap;
}
.dsh-orb-row:hover { background: rgba(255, 255, 255, 0.08); }
.dsh-orb-row-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: #5c6b8a; }
.dsh-orb-row-dot.running { background: #f59f00; animation: dshOrbBlink 1.2s ease-in-out infinite; }
.dsh-orb-row-dot.done { background: #40c057; }
.dsh-orb-row-dot.pending { background: #fa5252; }
@keyframes dshOrbBlink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.dsh-orb-row-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #e6e9f2;
}
.dsh-orb-row-meta { color: #8f98bd; font-size: 10px; flex: none; }
.dsh-orb-row-sub {
  flex-basis: 100%;
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding-left: 16px;
  font-size: 10px;
  color: #8f98bd;
}
.dsh-orb-row-project {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #7aa2ff;
}
.dsh-orb-row-label { font-size: 10px; flex: none; border-radius: 5px; padding: 0 5px; }
.dsh-orb-row-label.done { color: #69db7c; background: rgba(64, 192, 87, 0.14); }
.dsh-orb-row-label.pending { color: #ffa8a8; background: rgba(250, 82, 82, 0.16); }
.dsh-orb-empty { color: #6f7899; font-size: 11px; padding: 2px 8px; }
.dsh-orb-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8f98bd;
  font-size: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 8px;
}
.dsh-orb-markread {
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.06);
  color: #c6cbe0;
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 11px;
  margin-left: auto;
}
.dsh-orb-markread:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
`))

    const rel = (ts) => {
      if (!ts) return ''
      const d = Date.now() - ts
      if (d < 120000) return '刚刚'
      const m = Math.floor(d / 60000)
      if (m < 60) return m + ' 分钟前'
      const h = Math.floor(m / 60)
      if (h < 24) return h + ' 小时前'
      return new Date(ts).toLocaleDateString()
    }

    const pendingLabel = (s) => {
      if (s === 'approval') return '等待审批'
      if (s === 'plan-review') return '等待方案确认'
      return '等待你的输入'
    }

    function SessionOrb(props) {
      const useSessions = props.useSessions
      const useWorkspaces = props.useWorkspaces
      const list = useSessions((s) => s)
      const wsList = useWorkspaces((s) => s)
      const [open, setOpen] = React.useState(false)
      const [pos, setPos] = React.useState(null)
      const [, setTick] = React.useState(0)
      const ack = React.useState(() => new Set())[0]
      const drag = React.useState(() => ({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, moved: 0, vw: 1200, vh: 800 }))[0]

      // 30 秒一次轻量重渲染，刷新"刚刚/N 分钟前"等相对时间
      React.useEffect(() => {
        if (!timer) return undefined
        return timer.interval(() => setTick((t) => t + 1), 30000)
      }, [])

      const current = list.current
      React.useEffect(() => {
        if (current) ack.add(current)
      }, [current])

      const byId = list.byId || {}
      const rows = (list.ids || []).map((id) => byId[id]).filter((s) => s && !s.blank)
      const top = rows.filter((s) => !s.parentId && s.origin !== 'subagent')
      const running = top.filter((s) => s.running)
      const completed = top.filter((s) => s.completed && s.id !== current && !ack.has(s.id))
      const pending = top.filter((s) => s.pendingInteraction && s.id !== current)
      const attention = pending.concat(completed)
      const others = top.filter((s) => !s.running && !s.completed && !s.pendingInteraction)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

      const total = top.length
      const frac = total > 0 ? running.length / total : 0

      // 归属项目解析：① 工作区 sessionIds 权威账目 → 工作区 title；② cwd 与工作区 path 精确/最长前缀匹配；③ cwd 目录名兜底
      const wsItems = (wsList && wsList.items) || []
      const wsBySession = {}
      const wsByPath = {}
      for (const ws of wsItems) {
        for (const sid of ws.sessionIds || []) wsBySession[sid] = ws.title
        if (ws.path) wsByPath[ws.path] = ws.title
      }
      const projectOf = (s) => {
        if (wsBySession[s.id]) return wsBySession[s.id]
        if (s.cwd) {
          if (wsByPath[s.cwd]) return wsByPath[s.cwd]
          const cwd = s.cwd.endsWith('/') ? s.cwd : s.cwd + '/'
          let best = ''
          for (const p of Object.keys(wsByPath)) {
            const prefix = p.endsWith('/') ? p : p + '/'
            if (cwd.startsWith(prefix) && p.length > best.length) best = p
          }
          if (best) return wsByPath[best]
          const base = s.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
          if (base) return base
        }
        return ''
      }

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
        const R = 32
        setPos({
          x: Math.min(Math.max(drag.baseX + dx, R), drag.vw - R),
          y: Math.min(Math.max(drag.baseY + dy, R), drag.vh - R),
        })
      }
      const handleUp = (e) => {
        if (!drag.active) return
        drag.active = false
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (_err) { /* 忽略 */ }
        if (drag.moved < 6) setOpen((o) => !o)
      }

      const openSession = (id) => {
        ack.add(id)
        if (sessionsSvc !== undefined) sessionsSvc.open(id)
        setOpen(false)
      }

      const ringStyle = pos
        ? { left: pos.x, top: pos.y, transform: 'translate(-50%, -50%)' }
        : { right: 16, top: 16 }
      if (frac > 0) {
        ringStyle.background = 'conic-gradient(#ffd43b 0deg ' + (frac * 360) + 'deg, rgba(255, 255, 255, 0.14) ' + (frac * 360) + 'deg 360deg)'
      }

      const ballClass = 'dsh-orb-ball'
        + (running.length > 0 ? ' working' : '')
        + (attention.length > 0 ? ' attention' : '')
      const centerText = list.phase === 'pending' ? '…' : String(total)

      const tipParts = []
      if (attention.length > 0) tipParts.push(attention.length + ' 个会话需要查看')
      if (running.length > 0) tipParts.push(running.length + ' 个会话运行中')
      if (tipParts.length === 0) tipParts.push('全部会话空闲')
      tipParts.push('点击查看详情，拖拽可移动')

      const badge = attention.length > 0
        ? React.createElement('div', { key: 'b' + attention.length, className: 'dsh-orb-badge attention' }, String(attention.length))
        : running.length > 0
          ? React.createElement('div', { key: 'b' + running.length, className: 'dsh-orb-badge' }, String(running.length))
          : null

      const ring = React.createElement('div', {
        className: 'dsh-orb-ring',
        style: ringStyle,
        role: 'button',
        'aria-label': tipParts.join('，'),
        title: tipParts.join('，'),
        onPointerDown: handleDown,
        onPointerMove: handleMove,
        onPointerUp: handleUp,
        onPointerCancel: handleUp,
      },
        React.createElement('div', { className: ballClass },
          centerText,
          badge,
        ),
      )

      if (!open) return ring

      const row = (s, dot, label, labelCls) => {
        const project = projectOf(s)
        const showProject = project !== '' && project !== s.displayTitle
        return React.createElement('div', {
          key: s.id,
          className: 'dsh-orb-row',
          onClick: () => openSession(s.id),
          title: (project ? '项目：' + project + ' · ' : '') + '打开会话：' + s.displayTitle,
        },
          React.createElement('span', { className: 'dsh-orb-row-dot ' + dot }),
          React.createElement('span', { className: 'dsh-orb-row-title' }, s.displayTitle),
          label ? React.createElement('span', { className: 'dsh-orb-row-label ' + labelCls }, label) : null,
          React.createElement('span', { className: 'dsh-orb-row-sub' },
            showProject ? React.createElement('span', { className: 'dsh-orb-row-project' }, project) : null,
            React.createElement('span', { className: 'dsh-orb-row-meta' }, rel(s.updatedAt)),
          ),
        )
      }

      const pendingRows = pending.map((s) => row(s, 'pending', pendingLabel(s.pendingInteraction), 'pending'))
      const doneRows = completed.map((s) => row(s, 'done', '完成待查看', 'done'))
      const runRows = running.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map((s) => row(s, 'running', null, ''))
      const otherRows = others.slice(0, 12).map((s) => row(s, '', null, ''))

      const panelStyle = pos
        ? {
            left: Math.min(Math.max(pos.x + 38, 8), drag.vw - 408),
            top: Math.min(Math.max(pos.y - 24, 8), drag.vh - 80),
          }
        : { right: 16, top: 74 }

      const panel = React.createElement('div', { className: 'dsh-orb-panel', style: panelStyle },
        React.createElement('div', { className: 'dsh-orb-head' },
          React.createElement('span', { className: 'dsh-orb-title' }, '会话状态'),
          React.createElement('span', { className: 'dsh-orb-chip' }, '总 ' + total),
          running.length > 0
            ? React.createElement('span', { className: 'dsh-orb-chip warm' }, '运行 ' + running.length)
            : null,
          attention.length > 0
            ? React.createElement('span', { className: 'dsh-orb-chip hot' }, '需查看 ' + attention.length)
            : null,
          React.createElement('button', { className: 'dsh-orb-close', onClick: () => setOpen(false), title: '关闭' }, '×'),
        ),
        React.createElement('div', { className: 'dsh-orb-body' },
          React.createElement('div', { className: 'dsh-orb-section-title' }, '需要你注意'),
          pendingRows.length + doneRows.length > 0
            ? React.createElement('div', { className: 'dsh-orb-rows' }, pendingRows.concat(doneRows))
            : React.createElement('div', { className: 'dsh-orb-empty' }, '没有需要处理的事项'),
          React.createElement('div', { className: 'dsh-orb-section-title' }, '运行中'),
          runRows.length > 0
            ? React.createElement('div', { className: 'dsh-orb-rows' }, runRows)
            : React.createElement('div', { className: 'dsh-orb-empty' }, '当前没有运行中的会话'),
          React.createElement('div', { className: 'dsh-orb-section-title' }, '其他会话'),
          otherRows.length > 0
            ? React.createElement('div', { className: 'dsh-orb-rows' }, otherRows)
            : React.createElement('div', { className: 'dsh-orb-empty' }, '没有其他会话'),
          React.createElement('div', { className: 'dsh-orb-foot' },
            React.createElement('span', null, '数据实时同步自会话列表'),
            completed.length > 0
              ? React.createElement('button', {
                  className: 'dsh-orb-markread',
                  onClick: () => completed.forEach((s) => ack.add(s.id)),
                }, '全部标为已读')
              : null,
          ),
        ),
      )

      return React.createElement('div', { className: 'dsh-orb-root' }, ring, open ? panel : null)
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'session-orb', order: 1001, label: '会话状态球' },
      (props) => React.createElement(SessionOrb, props),
    ))
  },
}
