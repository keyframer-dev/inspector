/**
 * Motion Vitals for React Native: slow frames and janky animations from production, by screen and
 * animation call site. MIT.
 *
 *   import { startVitals } from '@keyframerdev/vitals'
 *   startVitals({ key: 'kfp_live_…', appVersion: '3.4.0', build: '412', navigationRef })
 *
 * Nothing runs before startVitals (an app that needs consent calls it after); setVitalsEnabled(false)
 * stops and drops what is pending. Add `@keyframerdev/vitals/babel` to babel.config.js for call sites;
 * without it, frames are still counted per screen. Never sent: screenshots, text, values, touches,
 * identifiers, absolute times.
 */

import { createElement, type ReactNode } from 'react'
import { View, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native'
import { vitalsTouch } from './native'

export { setVitalsEnabled, setVitalsScreen, startVitals, type NavigationRefLike, type VitalsOptions } from './native'
export type { VitalsDevice, VitalsStorage } from './controller'
export { SDK_VERSION } from './version'

const touches = (e: GestureResponderEvent) => e.nativeEvent?.touches?.length ?? 0

/**
 * Optional, around the app: touches open motion windows (a touch keeps the meters running until 1.5 s
 * after the finger lifts), so a list without scroll handlers is measured while it scrolls. It only
 * listens: it never becomes the responder and reads no coordinates.
 */
export function VitalsRoot({ children, style }: { children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  return createElement(
    View,
    {
      style: style ?? { flex: 1 },
      onTouchStart: () => vitalsTouch(true, 1),
      onTouchEnd: (e: GestureResponderEvent) => vitalsTouch(false, touches(e)),
      onTouchCancel: (e: GestureResponderEvent) => vitalsTouch(false, touches(e)),
    },
    children,
  )
}
