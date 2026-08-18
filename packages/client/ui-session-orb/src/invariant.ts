/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-session-orb`.
 * @module @deepseek-ai/dsh-client-ui-session-orb/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-session-orb'

/** Cordis companion plugin name. */
export const name = 'client-ui-session-orb-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the overlay entry and the settings row are
 * registrations whose lifecycle the slot registry owns and observes; the
 * orb reads only snapshot hooks, so there is no host-side state to assert.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
