/**
 * Session status orb, browser half: registers the draggable status orb into
 * the frame overlay and a beep-preference row into General settings. The orb
 * reads live session/workspace snapshots through the overlay seat's standard
 * hooks; the beep preference is one shared snapshot store wired to both
 * surfaces through the reserved `hooks` compartment, so the top icon button
 * and the settings row stay in sync.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionOrb, type SessionOrbInjected } from './SessionOrb.tsx'
import { BeepSettingRow, type BeepSettingRowInjected } from './BeepSettingRow.tsx'

/** Shared beep preference: default on, page-session lifetime. */
export interface BeepPrefState {
  on: boolean
}

const INITIAL_BEEP: BeepPrefState = { on: true }

/** Injected hooks compartment for both seats: the shared beep snapshot. */
export interface OrbHooks {
  hooks: {
    beep: HostObservable<BeepPrefState>
  }
}

/**
 * Client plugin body: register the overlay orb and the settings row over the
 * shared beep preference store.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const beep: SnapshotStore<BeepPrefState> = createSnapshotStore(INITIAL_BEEP)
  const hooks: OrbHooks['hooks'] = { beep }
  const toggleBeep = (): void => beep.set({ on: !beep.getSnapshot().on })
  const openSession = (id: SessionId): void => ctx.sessions.open(id)

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-orb',
    order: 1001,
    label: '会话状态球',
    inject: (): SessionOrbInjected & OrbHooks => ({
      hooks,
      toggleBeep,
      openSession,
    }),
  }, SessionOrb))

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'session-orb-beep',
    order: 30,
    label: '会话状态球提示音',
    inject: (): BeepSettingRowInjected & OrbHooks => ({
      hooks,
      toggleBeep,
    }),
  }, BeepSettingRow))
}
