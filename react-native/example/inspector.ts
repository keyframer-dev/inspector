import { Platform } from 'react-native'
import { connectInspector, registerReplay } from '@keyframerdev/inspector/native'
import { connectDevTools } from '@keyframerdev/inspector/devtools'

// Two ways to inspect, set in .env.local:
//   Expo dev tools (no account): leave EXPO_PUBLIC_INSPECTOR_CODE unset, or set
//     EXPO_PUBLIC_INSPECTOR_TRANSPORT=devtools, then press shift+m in Metro.
//   The Keyframer editor's Inspector panel (a room code it shows):
//     EXPO_PUBLIC_INSPECTOR_CODE=ABC234
//   The desktop app, Keyframer Inspector: EXPO_PUBLIC_INSPECTOR_RELAY=http://127.0.0.1:8790
//     (on a device, the Mac's LAN address the app shows in its status bar)
export function startInspector(replay: () => void): (() => void) | undefined {
  if (!__DEV__) return
  const code = process.env.EXPO_PUBLIC_INSPECTOR_CODE
  const relay = process.env.EXPO_PUBLIC_INSPECTOR_RELAY
  const devtools = !relay && (!code || process.env.EXPO_PUBLIC_INSPECTOR_TRANSPORT === 'devtools')
  const stop = relay
    ? connectInspector({ apiUrl: relay, code: 'DESKTOP', app: 'Inspector playground', platform: Platform.OS })
    : devtools
    ? // GIF / MP4 export captures the screen with react-native-view-shot, found on its own.
      connectDevTools({ app: 'Inspector playground', platform: Platform.OS })
    : connectInspector({
        apiUrl: process.env.EXPO_PUBLIC_INSPECTOR_API ?? 'https://api.keyframer.dev',
        code: code!,
        app: 'Inspector playground',
        platform: Platform.OS,
      })
  const unregister = registerReplay(replay)
  return () => {
    unregister()
    stop()
  }
}
