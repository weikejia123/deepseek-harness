/**
 * Session status orb, node half.
 *
 * Deliberately empty: the orb is a pure browser surface over the session and
 * workspace snapshot hooks the shell overlay seat already receives. It
 * registers no Host tool or service; composing it out of cordis.yml removes
 * the overlay entry entirely at zero cost.
 */

/** Host plugin body — nothing to contribute process-side. */
export function apply(): void {}
