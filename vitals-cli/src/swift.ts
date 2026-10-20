/**
 * Swift names are demangled by Apple's `swift-demangle` (through xcrun) when it is there, on macOS;
 * elsewhere they stay mangled and the manifest says so (`mangled: ["swift"]`).
 */
import { spawnSync } from 'node:child_process'

export type SwiftDemangler = (names: string[]) => Record<string, string> | null

/** `xcrun swift-demangle --compact --simplified`, one name per line. Null when it cannot run. */
export const xcrunSwiftDemangle: SwiftDemangler = (names) => {
  if (process.platform !== 'darwin' || names.length === 0) return null
  const r = spawnSync('xcrun', ['swift-demangle', '--compact', '--simplified'], { input: `${names.join('\n')}\n`, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
  if (r.status !== 0 || typeof r.stdout !== 'string') return null
  const out = r.stdout.split('\n')
  if (out.length < names.length) return null
  const map: Record<string, string> = {}
  names.forEach((n, i) => {
    const d = out[i].trim()
    if (d && d !== n) map[n] = d
  })
  return map
}
