/**
 * Expo dev tools entry: the inspector without a pairing room, for Expo Go and dev builds alike.
 *
 *   if (__DEV__) {
 *     const { connectDevTools } = require('@keyframerdev/inspector/devtools')
 *     // GIF / MP4 export captures the screen with react-native-view-shot or Skia, when installed.
 *     connectDevTools({ app: 'MyApp' })
 *   }
 *
 * Then press shift+m in the terminal running Metro and open "@keyframerdev/inspector": the panel lists
 * the app's shared values, records them while you interact, scrubs the recording back into the app
 * and shows where the UI and JS threads dropped frames.
 */

import { getDevToolsPluginClientAsync } from 'expo/devtools'
import type { ConnectInspectorOptions } from './client'
import { DEVTOOLS_PLUGIN, devToolsSocket, type DevToolsClientLike } from './devtoolsSocket'
import { connectInspector } from './native'

export { registerReplay, type CaptureScreen } from './client'
export { fire, press, registerScenario, waitForTestId } from './scenarios'
export { DEVTOOLS_METHOD, DEVTOOLS_PLUGIN } from './devtoolsSocket'

export type ConnectDevToolsOptions = Omit<ConnectInspectorOptions, 'apiUrl' | 'code' | 'WebSocket'>

/** Connects the inspector to the Expo dev tools panel. Returns a function that disconnects it. */
export function connectDevTools(opts: ConnectDevToolsOptions = {}): () => void {
  return connectInspector({
    ...opts,
    // Unused by the dev tools channel; connectInspector builds a room URL from them.
    apiUrl: 'http://devtools',
    code: 'DEVTOOLS',
    WebSocket: devToolsSocket(() => getDevToolsPluginClientAsync(DEVTOOLS_PLUGIN) as Promise<DevToolsClientLike>),
  })
}
