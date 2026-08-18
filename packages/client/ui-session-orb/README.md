# @deepseek-ai/dsh-client-ui-session-orb

Session status orb: a draggable frame-overlay ball showing the global session workload at a glance — top-level session count, running share, and an attention badge for unread or awaiting-interaction sessions. Clicking the ball opens a panel grouped into 需要你注意 / 运行中 / 其他会话 (the last paginated, 8 per page); clicking a row opens that session.

## What it does

- **Overlay orb** (`shell.overlay`, additive cell `session-orb`): a 54px ball whose center number is the top-level session count, whose conic arc is the running share, and whose badge is the attention count. Colors encode state: blue idle → amber breathing while running → red pulsing badge + 3-ring green ripple on attention.
- **Attention beep**: default on, toggleable from the orb panel header (🔔/🔕) or the General-settings row (`settings.general.item`, cell `session-orb-beep`) — both share one snapshot store through the reserved `hooks` compartment. An attention transition (approval / plan-review / question / completed-unread) plays a Web Audio chime and a green ripple once, then repeats every 10s while attention persists. Ripple and chime trigger only on attention transitions — clicking or dragging never fires them.
- **Panel**: session rows with status dot, title, project label (workspace account → cwd-path match → basename), relative time, and a per-row copy-path button (⧉ copies the session `cwd`).
- Pure browser surface: session/workspace facts arrive through the overlay seat's standard hooks (`useSessions` / `useWorkspaces`); it registers no Host service or tool.

## Known limitations

- Beep preference, read-mark acknowledgements, drag position, and pagination are page-session memory state; a refresh resets them (the `completed` fact itself is host-maintained and clears on open).
- The chime uses the Web Audio API; a browser autoplay policy that keeps `AudioContext` suspended degrades silently — the orb itself is unaffected.
- Beep preference is not persisted across page reloads (no settings write); a durable preference would need a settings namespace.
