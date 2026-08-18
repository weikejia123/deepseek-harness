/**
 * Beep preference row for the General settings section: one compact toggle
 * over the shared orb beep snapshot store.
 */
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { OrbHooks } from './index.ts'
import css from './SessionOrb.module.css'

/** Injected business face: shared beep snapshot + toggle action. */
export interface BeepSettingRowInjected {
  toggleBeep: () => void
}

/** Composed props: injected face with the hooks compartment bound. */
export type BeepSettingRowProps = InjectFace<BeepSettingRowInjected & OrbHooks>

/**
 * One General-settings row switching the orb beep on and off.
 * @param props - injected face; `useBeep` arrives from the hooks compartment.
 */
export function BeepSettingRow(props: BeepSettingRowProps): React.ReactElement {
  const { useBeep, toggleBeep } = props
  const on = useBeep(s => s).on
  return (
    <div className={css.settingRow}>
      <span>会话状态球提示音</span>
      <button
        type="button"
        className={on ? css.settingOn : css.settingOff}
        onClick={toggleBeep}
        title={on ? '有待处理事项时播放提示音' : '关闭后不再播放提示音'}
      >
        {on ? '开' : '关'}
      </button>
    </div>
  )
}
