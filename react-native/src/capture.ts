/**
 * Screen capture without asking the app for it: GIF / MP4 export, captured frames and the device
 * recorder's screenshots use whatever is installed.
 *
 *   1. react-native-view-shot: its native module (RNViewShot) is there whenever the package is
 *      installed (it ships in Expo Go). Called directly, so the inspector never imports the package
 *      (a static import of a missing package breaks the bundle; an optional require is off in Metro by
 *      default outside Expo).
 *   2. @shopify/react-native-skia: when the app uses Skia, its view API is a global
 *      (SkiaViewApi.makeImageFromView), and the root view comes from Motion Scan.
 *
 * A captureScreen the app passes still wins.
 */

import { Dimensions, findNodeHandle, NativeModules, TurboModuleRegistry } from 'react-native'
import type { CaptureScreen } from './client'

type CaptureOptions = Parameters<CaptureScreen>[0]

type ViewShotModule = { captureScreen(options: object): Promise<string> }

function viewShot(): ViewShotModule | null {
  try {
    const turbo = (globalThis as { __turboModuleProxy?: unknown }).__turboModuleProxy != null ? TurboModuleRegistry.get<never>('RNViewShot') : null
    const m = (turbo ?? (NativeModules as Record<string, unknown>).RNViewShot) as Partial<ViewShotModule> | null | undefined
    return m && typeof m.captureScreen === 'function' ? (m as ViewShotModule) : null
  } catch {
    return null
  }
}

type SkImage = { width(): number; height(): number; encodeToBase64(format?: number, quality?: number): string; dispose?(): void }
type SkiaGlobals = {
  SkiaViewApi?: { makeImageFromView?(viewTag: number): Promise<SkImage | null> }
  SkiaApi?: {
    Surface?: { MakeOffscreen?(w: number, h: number): SkSurface | null; Make?(w: number, h: number): SkSurface | null }
    XYWHRect?(x: number, y: number, w: number, h: number): unknown
    Paint?(): unknown
  }
}
type SkSurface = { getCanvas(): { drawImageRect(img: SkImage, src: unknown, dst: unknown, paint: unknown): void }; makeImageSnapshot(): SkImage; flush?(): void; dispose?(): void }

/** Skia's encoded image formats (EncodedImageFormat): JPEG 3, PNG 4. */
const SKIA_FORMAT = { jpg: 3, png: 4 } as const

let root: unknown = null

/** The view a Skia capture draws: Motion Scan registers the app's root. */
export function setCaptureRoot(view: unknown): void {
  root = view
}

function skiaApi(): SkiaGlobals | null {
  const g = globalThis as SkiaGlobals
  return typeof g.SkiaViewApi?.makeImageFromView === 'function' ? g : null
}

async function skiaCapture(options: CaptureOptions): Promise<string> {
  const g = skiaApi()
  const tag = root ? findNodeHandle(root as never) : null
  if (!g || tag == null) throw new Error('Skia capture needs the app wrapped in <MotionScan>.')
  const image = await g.SkiaViewApi!.makeImageFromView!(tag)
  if (!image) throw new Error('Skia returned no image.')
  let out = image
  // Scale down to the width asked for when Skia's drawing API is there; else send it as it is.
  const w = options.width && options.width < image.width() ? Math.round(options.width) : 0
  const make = g.SkiaApi?.Surface?.MakeOffscreen ?? g.SkiaApi?.Surface?.Make
  if (w && make && g.SkiaApi?.XYWHRect && g.SkiaApi.Paint) {
    const h = Math.round((image.height() * w) / image.width())
    const surface = make.call(g.SkiaApi.Surface, w, h)
    if (surface) {
      surface.getCanvas().drawImageRect(image, g.SkiaApi.XYWHRect(0, 0, image.width(), image.height()), g.SkiaApi.XYWHRect(0, 0, w, h), g.SkiaApi.Paint())
      surface.flush?.()
      out = surface.makeImageSnapshot()
    }
  }
  const data = out.encodeToBase64(SKIA_FORMAT[options.format], Math.round(options.quality * 100))
  if (out !== image) out.dispose?.()
  image.dispose?.()
  return data
}

const screenWidth = () => Dimensions.get('window').width || 1
const screenHeight = () => Dimensions.get('window').height || 1

/** Which capture the app can use without being told, or null. Checked when a capture runs: Skia's root mounts later. */
export function detectCapture(): 'view-shot' | 'skia' | null {
  if (viewShot()) return 'view-shot'
  if (skiaApi()) return 'skia'
  return null
}

/**
 * A captureScreen built from what is installed (view-shot, else Skia), or undefined when neither is:
 * the app then does not offer capture.
 */
export function autoCaptureScreen(): CaptureScreen | undefined {
  if (!detectCapture()) return undefined
  return async (options) => {
    const vs = viewShot()
    if (vs) {
      return vs.captureScreen({
        format: options.format,
        quality: options.quality,
        result: 'base64',
        snapshotContentContainer: false,
        handleGLSurfaceViewOnAndroid: false,
        // view-shot resizes only with both sides: the height keeps the screen's aspect.
        ...(options.width ? { width: options.width, height: Math.round((options.width * screenHeight()) / screenWidth()) } : {}),
      })
    }
    return skiaCapture(options)
  }
}
