/**
 * Session status orb: the frame-overlay draggable ball. One glance shows the
 * global session workload (top-level session count, running share as a conic
 * arc, attention badge for unread/awaiting work). Click expands a panel
 * grouped into 需要你注意 / 运行中 / 其他会话 (the last paginated 8 per
 * page); clicking a row opens that session. When beep is on, an attention
 * transition plays a Web Audio chime and a green ripple once, then repeats
 * every 10s while attention persists.
 *
 * Pure component: session/workspace facts arrive through the overlay seat's
 * standard hooks; the beep preference arrives through the injected hooks
 * compartment (shared with the General-settings row).
 */
import { useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId, SessionSummary, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { BeepPrefState, OrbHooks } from './index.ts'
import css from './SessionOrb.module.css'

/** Overlay seat's standard runtime share (root scope: global hooks only). */
type OrbRuntimeProps = PropsRuntime<'shell.overlay'>

/** Injected business face: shared beep toggle and the session opener. */
export interface SessionOrbInjected {
  toggleBeep: () => void
  openSession: (id: SessionId) => void
}

/** Composed props: runtime share + injected face with hooks compartment bound. */
export type SessionOrbProps =
  & OrbRuntimeProps
  & InjectFace<SessionOrbInjected & OrbHooks>

/** Snapshot type the shared beep hook selects over. */
export type BeepPref = BeepPrefState

/** One paginated page of the 其他会话 list. */
const OTHER_PAGE_SIZE = 8
/** Ripple animation duration plus margin, before the layer unmounts. */
const RIPPLE_LINGER_MS = 1700
/** Chime repeat interval while attention persists. */
const BEEP_REPEAT_MS = 10_000

/** Relative-time label for a timestamp. */
function rel(ts: number | undefined): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 120_000) return '刚刚'
  const m = Math.floor(d / 60_000)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return new Date(ts).toLocaleDateString()
}

/** Human label for a pending-interaction status. */
function pendingLabel(s: PendingStatus): string {
  if (s === 'approval') return '等待审批'
  if (s === 'plan-review') return '等待方案确认'
  return '等待你的输入'
}

type PendingStatus = NonNullable<SessionSummary['pendingInteraction']>

/**
 * Play one chime: an ascending three-note arpeggio via Web Audio. Fails
 * silently when the browser blocks the context or lacks audio support.
 * @param ac - lazily created AudioContext shared across chimes.
 */
function playChime(ac: AudioContext | null): AudioContext | null {
  try {
    // Modern browsers expose AudioContext globally; the prefixed legacy alias
    // is typed nowhere, so probe it through the window object when present.
    const win = typeof window !== 'undefined' ? window : undefined
    const legacy = win !== undefined
      ? (win as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined
    const Ctor = typeof AudioContext !== 'undefined'
      ? AudioContext
      : typeof legacy === 'function'
        ? legacy
        : undefined
    if (Ctor === undefined) return ac
    const context = ac ?? new Ctor()
    const schedule = (): void => {
      const now = context.currentTime
      const notes = [880, 1108.73, 1318.51]
      for (const [i, freq] of notes.entries()) {
        const osc = context.createOscillator()
        const gain = context.createGain()
        osc.type = 'sine'
        osc.frequency.value = freq
        const t0 = now + i * 0.09
        gain.gain.setValueAtTime(0.0001, t0)
        gain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22)
        osc.connect(gain)
        gain.connect(context.destination)
        osc.start(t0)
        osc.stop(t0 + 0.25)
      }
    }
    if (context.state === 'suspended') void context.resume().then(schedule).catch(() => { /* blocked: silent */ })
    else schedule()
    return context
  } catch {
    return ac
  }
}

/**
 * Resolve a session's project label: workspace account → path match → cwd
 * basename, mirroring the sidebar's ownership semantics.
 */
function projectOf(session: SessionSummary, wsList: readonly WorkspaceView[]): string {
  const bySession = new Map<string, string>()
  const byPath = new Map<string, string>()
  for (const ws of wsList) {
    for (const sid of ws.sessionIds) bySession.set(sid, ws.title)
    if (ws.path) byPath.set(ws.path, ws.title)
  }
  if (session.id !== undefined) {
    const fromAccount = bySession.get(session.id)
    if (fromAccount !== undefined) return fromAccount
  }
  if (session.cwd) {
    const exact = byPath.get(session.cwd)
    if (exact !== undefined) return exact
    const cwd = session.cwd.endsWith('/') ? session.cwd : `${session.cwd}/`
    let best = ''
    for (const p of byPath.keys()) {
      const prefix = p.endsWith('/') ? p : `${p}/`
      if (cwd.startsWith(prefix) && p.length > best.length) best = p
    }
    if (best !== '') return byPath.get(best) ?? ''
    const base = session.cwd.replace(/[/\\]+$/, '').split(/[/\\]/).pop()
    if (base !== undefined && base !== '') return base
  }
  return ''
}

/**
 * The orb entry: the floating ball plus its detail panel.
 * @param props - runtime share, injected beep toggle, bound `useBeep` hook.
 */
export function SessionOrb(props: SessionOrbProps): React.ReactElement {
  const { useSessions, useWorkspaces, useBeep, toggleBeep, openSession: openSessionAction } = props
  const list = useSessions(s => s)
  const wsList = useWorkspaces(s => s)
  const beepOn = useBeep(s => s).on

  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [, setTick] = useState(0)
  const ackRef = useRef(new Set<SessionId>())
  const dragRef = useRef({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0, moved: 0, vw: 1200, vh: 800 })
  const beepRef = useRef({ last: 0, had: false, ac: null as AudioContext | null })
  const [rippleKey, setRippleKey] = useState(0)
  const [rippleVisible, setRippleVisible] = useState(false)
  const [otherPage, setOtherPage] = useState(0)
  const [copiedId, setCopiedId] = useState<SessionId | null>(null)

  // One-second heartbeat: refreshes relative times and drives the beep check.
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  const current = list.current
  const byId = list.byId
  const rows = list.ids
    .map(id => byId[id])
    .filter((s): s is SessionSummary => s !== undefined && !s.blank)
  const top = rows.filter(s => !s.parentId && s.origin !== 'subagent')
  const running = top.filter(s => s.running)
  const completed = top.filter(s => s.completed && s.id !== current && !ackRef.current.has(s.id))
  const pending = top.filter(s => s.pendingInteraction !== undefined && s.id !== current)
  const attention = pending.concat(completed)
  const others = top
    .filter(s => !s.running && s.pendingInteraction === undefined
      && !(s.completed && s.id !== current && !ackRef.current.has(s.id)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  const otherPages = Math.max(1, Math.ceil(others.length / OTHER_PAGE_SIZE))
  const otherPageClamped = Math.min(otherPage, otherPages - 1)

  // Beep: immediate on attention appearing, then every 10s while it persists.
  useEffect(() => {
    if (!beepOn || attention.length === 0) {
      beepRef.current.had = false
      beepRef.current.last = 0
      return
    }
    const now = Date.now()
    if (!beepRef.current.had || now - beepRef.current.last >= BEEP_REPEAT_MS) {
      beepRef.current.ac = playChime(beepRef.current.ac)
      setRippleKey(k => k + 1)
      setRippleVisible(true)
      beepRef.current.last = now
    }
    beepRef.current.had = true
  }, [attention.length, beepOn, open])

  // Ripple lifecycle: unmount once the animation finished.
  useEffect(() => {
    if (!rippleVisible) return undefined
    const id = setTimeout(() => setRippleVisible(false), RIPPLE_LINGER_MS)
    return () => clearTimeout(id)
  }, [rippleVisible, rippleKey])

  const total = top.length
  const frac = total > 0 ? running.length / total : 0

  const handleDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const view = el.ownerDocument.defaultView ?? { innerWidth: 1200, innerHeight: 800 }
    const drag = dragRef.current
    drag.active = true
    drag.startX = e.clientX
    drag.startY = e.clientY
    drag.baseX = pos ? pos.x : rect.left + rect.width / 2
    drag.baseY = pos ? pos.y : rect.top + rect.height / 2
    drag.moved = 0
    drag.vw = view.innerWidth
    drag.vh = view.innerHeight
    try { el.setPointerCapture(e.pointerId) } catch { /* capture 非关键路径 */ }
  }
  const handleMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
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
  const handleUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    if (!drag.active) return
    drag.active = false
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 忽略 */ }
    if (drag.moved < 6) setOpen(o => !o)
  }

  const openSession = (id: SessionId): void => {
    ackRef.current.add(id)
    openSessionAction(id)
    setOpen(false)
  }

  const copyPath = (e: React.MouseEvent, path: string, id: SessionId): void => {
    e.stopPropagation()
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    if (nav === undefined || typeof nav.clipboard !== 'object' || nav.clipboard === null) return
    void nav.clipboard.writeText(path).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(cur => (cur === id ? null : cur)), 1500)
    }).catch(() => { /* 剪贴板被拒：静默 */ })
  }

  const ringStyle: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, transform: 'translate(-50%, -50%)' }
    : { right: 16, top: 16 }
  if (frac > 0) {
    ringStyle.background = `conic-gradient(#ffd43b 0deg ${frac * 360}deg, rgba(255, 255, 255, 0.14) ${frac * 360}deg 360deg)`
  }

  const ballClass = [css.ball]
    .concat(running.length > 0 ? [css.working] : [])
    .concat(attention.length > 0 ? [css.attention] : [])
    .join(' ')
  const centerText = list.phase === 'pending' ? '…' : String(total)

  const tipParts: string[] = []
  if (attention.length > 0) tipParts.push(`${attention.length} 个会话需要查看`)
  if (running.length > 0) tipParts.push(`${running.length} 个会话运行中`)
  if (tipParts.length === 0) tipParts.push('全部会话空闲')
  tipParts.push('点击查看详情，拖拽可移动')
  const tip = tipParts.join('，')

  const badge = attention.length > 0
    ? <div key={`b${attention.length}`} className={`${css.badge} ${css.badgeAttention}`}>{attention.length}</div>
    : running.length > 0
      ? <div key={`b${running.length}`} className={css.badge}>{running.length}</div>
      : null

  const ring = (
    <div
      className={css.ring}
      style={ringStyle}
      role="button"
      aria-label={tip}
      title={tip}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
    >
      {rippleVisible
        ? (
          <div key={`ripple${rippleKey}`} className={css.ripple}>
            <span className={css.rippleRing} />
            <span className={`${css.rippleRing} ${css.rippleRing2}`} />
            <span className={`${css.rippleRing} ${css.rippleRing3}`} />
          </div>
        )
        : null}
      <div className={ballClass}>
        {centerText}
        {badge}
      </div>
    </div>
  )

  if (!open) return ring

  const row = (s: SessionSummary, dot: string, label?: string, labelCls?: string): React.ReactElement => {
    const project = projectOf(s, wsList.items)
    const showProject = project !== '' && project !== s.displayTitle
    const hasCwd = typeof s.cwd === 'string' && s.cwd.length > 0
    const dotCls = [css.rowDot].concat(dot ? [css[`rowDot${dot.charAt(0).toUpperCase()}${dot.slice(1)}`]] : []).join(' ')
    return (
      <div
        key={s.id}
        className={css.row}
        onClick={() => openSession(s.id)}
        title={(project ? `项目：${project} · ` : '') + `打开会话：${s.displayTitle}`}
      >
        <span className={dotCls} />
        <span className={css.rowTitle}>{s.displayTitle}</span>
        {label ? <span className={`${css.rowLabel} ${css[`rowLabel${labelCls}`]}`}>{label}</span> : null}
        <span className={css.rowSub}>
          {showProject ? <span className={css.rowProject}>{project}</span> : null}
          <span className={css.rowMeta}>{rel(s.updatedAt)}</span>
          {hasCwd
            ? (
              <button
                type="button"
                className={copiedId === s.id ? `${css.copy} ${css.copyDone}` : css.copy}
                onClick={e => copyPath(e, s.cwd as string, s.id)}
                title={`复制项目完整路径：${s.cwd}`}
                aria-label="复制项目完整路径"
              >
                {copiedId === s.id ? '✓' : '⧉'}
              </button>
            )
            : null}
        </span>
      </div>
    )
  }

  const pendingRows = pending.map(s => row(s, 'pending', pendingLabel(s.pendingInteraction as PendingStatus), 'pending'))
  const doneRows = completed.map(s => row(s, 'done', '完成待查看', 'done'))
  const runRows = running
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(s => row(s, 'running'))
  const otherRows = others
    .slice(otherPageClamped * OTHER_PAGE_SIZE, (otherPageClamped + 1) * OTHER_PAGE_SIZE)
    .map(s => row(s, ''))

  const panelStyle: React.CSSProperties = pos
    ? {
      left: Math.min(Math.max(pos.x + 38, 8), dragRef.current.vw - 408),
      top: Math.min(Math.max(pos.y - 24, 8), dragRef.current.vh - 80),
    }
    : { right: 16, top: 74 }

  return (
    <div className={css.root}>
      {ring}
      <div className={css.panel} style={panelStyle}>
        <div className={css.head}>
          <span className={css.title}>会话状态</span>
          <span className={css.chip}>总 {total}</span>
          {running.length > 0 ? <span className={`${css.chip} ${css.chipWarm}`}>运行 {running.length}</span> : null}
          {attention.length > 0 ? <span className={`${css.chip} ${css.chipHot}`}>需查看 {attention.length}</span> : null}
          <button
            type="button"
            className={beepOn ? css.beep : `${css.beep} ${css.beepOff}`}
            onClick={toggleBeep}
            title={beepOn ? '提示音已开启：有待处理事项时播放提示音（点击关闭）' : '提示音已关闭（点击开启）'}
            aria-label={beepOn ? '关闭提示音' : '开启提示音'}
          >
            {beepOn ? '🔔' : '🔕'}
          </button>
          <button type="button" className={css.close} onClick={() => setOpen(false)} title="关闭">×</button>
        </div>
        <div className={css.body}>
          <div className={css.sectionTitle}>需要你注意</div>
          {pendingRows.length + doneRows.length > 0
            ? <div className={css.rows}>{pendingRows.concat(doneRows)}</div>
            : <div className={css.empty}>没有需要处理的事项</div>}
          <div className={css.sectionTitle}>运行中</div>
          {runRows.length > 0
            ? <div className={css.rows}>{runRows}</div>
            : <div className={css.empty}>当前没有运行中的会话</div>}
          <div className={css.sectionTitle}>其他会话</div>
          {otherRows.length > 0
            ? <div className={css.rows}>{otherRows}</div>
            : <div className={css.empty}>没有其他会话</div>}
          {otherPages > 1
            ? (
              <div className={css.pager}>
                <button
                  type="button"
                  disabled={otherPageClamped <= 0}
                  onClick={() => setOtherPage(otherPageClamped - 1)}
                  title="上一页"
                >
                  ‹
                </button>
                <span>{otherPageClamped + 1} / {otherPages}</span>
                <button
                  type="button"
                  disabled={otherPageClamped >= otherPages - 1}
                  onClick={() => setOtherPage(otherPageClamped + 1)}
                  title="下一页"
                >
                  ›
                </button>
              </div>
            )
            : null}
          <div className={css.foot}>
            <span>数据实时同步自会话列表</span>
            {completed.length > 0
              ? (
                <button
                  type="button"
                  className={css.markRead}
                  onClick={() => { for (const s of completed) ackRef.current.add(s.id) }}
                >
                  全部标为已读
                </button>
              )
              : null}
          </div>
        </div>
      </div>
    </div>
  )
}
