/**
 * Which device a React Native app runs on (`hello.device`, InspectorDevice), from what JavaScript can
 * read, so the package stays JavaScript only (over-the-air updates, no native code of its own):
 * React Native's platform constants (Android's Build values; iOS has none about the hardware), and
 * expo-device's native module when the app has it (Expo Go always does). That module is read where
 * Expo puts it, `globalThis.expo.modules.ExpoDevice`, never imported, like react-native-view-shot in
 * capture.ts: a static import of a package the app does not have breaks its bundle.
 *
 * Privacy: `name` and `id` only for simulators and emulators. A physical device says its `model` and
 * `simulator: false`, never the name its owner gave it ("Catalin's iPhone", which is what expo-device's
 * `deviceName` is on a real phone), since recordings get shared.
 *
 * An iOS simulator's id is its UDID, which is in the app's own paths (a simulator keeps its apps under
 * `CoreSimulator/Devices/<UDID>/`; Expo's file system module and React Native's script URL say where).
 * A physical device's paths hold no id, so only a simulator gets one.
 *
 * Out of JavaScript's reach, so left out (the native SDKs send them): an iOS simulator's model
 * identifier (SIMULATOR_MODEL_IDENTIFIER is in the process environment, which no JavaScript API exposes;
 * expo-device's `modelId` there is the Mac's CPU, `arm64`), and an Android emulator's AVD name (a
 * system property).
 */

import type { InspectorDevice } from '../../protocol/inspector'

/** The constants of expo-device's native module this reads (the same names on iOS and Android). */
export type ExpoDeviceModule = {
  isDevice?: boolean
  modelId?: string | null
  modelName?: string | null
  deviceName?: string | null
  manufacturer?: string | null
}

export type DeviceSources = {
  /** Platform.OS. */
  os: string
  /** Platform.constants: Model, Manufacturer, Brand and Fingerprint on Android. */
  constants?: Record<string, unknown> | null
  expoDevice?: ExpoDeviceModule | null
  /** Paths and URLs of the app's own files (documents, caches, its bundle): where a simulator keeps it. */
  paths?: Array<string | null | undefined>
}

const SIMULATOR_PATH = /\/CoreSimulator\/Devices\/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\//i

/** The UDID of the iOS simulator these paths are on, or undefined (a physical device's never hold one). */
export function simulatorUdid(paths: DeviceSources['paths']): string | undefined {
  for (const p of paths ?? []) {
    const m = typeof p === 'string' ? SIMULATOR_PATH.exec(p) : null
    if (m) return m[1]!.toUpperCase()
  }
  return undefined
}

const text = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  return s && s.toLowerCase() !== 'unknown' ? s : undefined
}

/** An Android emulator, told from its Build values when expo-device is not there to say. */
export function looksLikeEmulator(c: Record<string, unknown>): boolean {
  const fingerprint = (text(c.Fingerprint) ?? '').toLowerCase()
  const model = (text(c.Model) ?? '').toLowerCase()
  const brand = (text(c.Brand) ?? '').toLowerCase()
  const manufacturer = (text(c.Manufacturer) ?? '').toLowerCase()
  return (
    fingerprint.startsWith('generic') ||
    fingerprint.includes('emulator') ||
    fingerprint.includes('/sdk_gphone') ||
    model.includes('sdk_gphone') ||
    model.includes('google_sdk') ||
    model.includes('emulator') ||
    model.includes('android sdk built for') ||
    brand.startsWith('generic') ||
    manufacturer.includes('genymotion')
  )
}

function compact(d: InspectorDevice): InspectorDevice {
  const out: InspectorDevice = {}
  if (d.name) out.name = d.name
  if (d.model) out.model = d.model
  if (d.id) out.id = d.id
  if (typeof d.simulator === 'boolean') out.simulator = d.simulator
  return out
}

/** What may be said about the device, or null when nothing can be told. */
export function describeDevice(s: DeviceSources): InspectorDevice | null {
  const x = s.expoDevice ?? null
  if (s.os === 'ios') {
    // A simulator's own paths say which one it is; its name (as it was given in Xcode) from expo-device.
    const udid = simulatorUdid(s.paths)
    if (udid) return compact({ id: udid, name: x?.isDevice === false ? text(x.deviceName) : undefined, simulator: true })
    // Without expo-device, nothing else JavaScript can read tells a simulator from an iPhone.
    if (!x || typeof x.isDevice !== 'boolean') return null
    // A simulator: the name it was given in Xcode ("iPhone 16 Pro"). An iPhone: its model (iPhone17,1).
    return x.isDevice ? compact({ model: text(x.modelId), simulator: false }) : compact({ name: text(x.deviceName), simulator: true })
  }
  if (s.os === 'android') {
    const c = s.constants ?? {}
    const model = text(c.Model) ?? text(x?.modelName)
    const emulator = typeof x?.isDevice === 'boolean' ? !x.isDevice : looksLikeEmulator(c)
    // An emulator's device name setting (the AVD name itself is a system property).
    if (emulator) return compact({ name: text(x?.deviceName), model, simulator: true })
    // A phone: its model, with the maker in front when the model leaves it out (Google Pixel 8).
    const maker = text(c.Manufacturer) ?? text(x?.manufacturer)
    const named = model && maker && !model.toLowerCase().includes(maker.toLowerCase()) ? `${maker} ${model}` : model
    return named ? { model: named, simulator: false } : null
  }
  return null
}
