# React Native: the app side

The source of what `@keyframerdev/inspector` puts into your app, under MIT:

| File | What |
| --- | --- |
| `src/babel.ts` | The Babel plugin: tags every Reanimated call, shared value, gesture callback and handler with where it is written. Development builds only. |
| `src/runtime.ts` | What the tags call at runtime: records animation starts, values and their stacks, on the JS and UI threads. |
| `src/native.ts` | `connectInspector`: the connection to the panel, the desktop app or the pairing room. |
| `src/scan.ts` | Motion Scan, the on-device overlay and record button. |
| `src/record.ts`, `src/recorder.ts` | Recording on the device, for testers. |
| `src/capture.ts` | Screenshots, through react-native-view-shot or Skia when the app has one. |
| `src/redact.ts`, `src/share.ts`, `src/expoShare.ts` | Redaction and share links for recordings. |

Install it from npm (`npm i -D @keyframerdev/inspector`); the
[npm README](https://www.npmjs.com/package/@keyframerdev/inspector) is the guide. The package is built
from Keyframer's monorepo, with the tools (the `keyframer-inspect` CLI, its MCP server and the panel),
which are not in this repository. Types it shares with the other SDKs come from
[`../protocol/inspector.ts`](../protocol/inspector.ts).
