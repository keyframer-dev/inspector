/**
 * What differs between the frameworks an app can be written with, for reading its recordings: what its
 * two threads are called (see InspectorThread), and how a fix is worded. React Native is the default:
 * an app that says nothing about itself (older React Native runtimes) reads as before.
 */

import type { InspectorAppInfo, InspectorThread, InspectorThreads } from '../../protocol/inspector'

export type AppLike = Pick<InspectorAppInfo, 'framework' | 'threads'> | null | undefined

export const REACT_NATIVE_THREADS: InspectorThreads = { js: { label: 'JS' }, ui: { label: 'UI', animates: true } }

export function isReactNative(app: AppLike): boolean {
  return !app?.framework || app.framework === 'react-native'
}

/** The app's threads; without a description, React Native's, or a main thread for other frameworks. */
export function threadsOf(app: AppLike): InspectorThreads {
  return app?.threads ?? (isReactNative(app) ? REACT_NATIVE_THREADS : { js: { label: 'Main', animates: true } })
}

/** Short, for timeline rows and frame labels: "JS", "Main", "UI isolate", "Raster". */
export function threadLabel(app: AppLike, thread: InspectorThread): string {
  return threadsOf(app)[thread]?.label ?? (thread === 'js' ? 'App' : 'Frame')
}

/** In a sentence: "JS thread", "Main thread", "UI isolate", "Raster thread". */
export function threadName(app: AppLike, thread: InspectorThread): string {
  const label = threadLabel(app, thread)
  return /thread|isolate/i.test(label) ? label : `${label} thread`
}

/** "React Native", "Flutter", "UIKit", … for headings. */
export function frameworkName(app: AppLike): string {
  const names: Record<string, string> = {
    'react-native': 'React Native',
    flutter: 'Flutter',
    uikit: 'UIKit',
    swiftui: 'SwiftUI',
    'android-views': 'Android Views',
    compose: 'Jetpack Compose',
  }
  const f = app?.framework ?? 'react-native'
  return names[f] ?? f
}

/** How each kind of problem is fixed, in the framework's own terms. */
export type Advice = {
  /** App code (a handler, a callback) that blocked the app thread. */
  callback: string
  /** Work on the app thread the inspector does not time. */
  untimed: string
  /** An animation set up while the app thread was busy. */
  startedWhileBlocked: string
  /** A new screen's first build/render dropped frames. */
  screenMount: string
  /** The frame thread took too long with nothing the inspector timed. */
  frameUnknown: string
  /** Many animations started in one frame. */
  burst: string
}

const REACT_NATIVE: Advice = {
  callback:
    'Move the heavy work out of this callback: defer it until the animation ends, split it into chunks, or memoize the result. Animations it starts should be driven by shared values so the UI thread keeps them running.',
  untimed:
    "This is work outside the app's handlers, effects and timers: a library, a native module callback, or a timer scheduled before recording started. Record again with React Native DevTools' Performance panel to see the function, or start recording earlier.",
  startedWhileBlocked:
    'It started from JS and its first frames waited for the blocked JS thread. Start it from a worklet (a gesture callback or useAnimatedReaction), or move the blocking work after it.',
  screenMount:
    "The new screen's first render and native mount ran in these frames, during the transition. Keep the first render light: render heavy parts after the transition (InteractionManager.runAfterInteractions, or a short delay), virtualize lists, and avoid starting many animations on mount.",
  frameUnknown:
    'This is native work, not a worklet: layout (an animated width, height, margin or padding), shadows or blur on moving views, large images decoding, or views mounting. Animate transforms and opacity instead of layout properties, and keep shadows off views that move.',
  burst: 'Stagger them with withDelay, or drive them from one shared progress value with interpolate, so the UI thread does not set up every animation in one frame.',
}

const FLUTTER: Advice = {
  callback:
    'Move the heavy work out of this callback: run it in an isolate (compute, Isolate.run) or after the animation, split it, or cache the result. The UI isolate also ticks the animations, so they stop while it runs.',
  untimed:
    "This is work on the UI isolate outside the code the inspector times: a build or layout, a platform channel callback, or a timer started before recording. Open Flutter DevTools' Performance view on a profile build to see the function.",
  startedWhileBlocked:
    'It started while the UI isolate was busy, so its first frames waited. Move the blocking work to an isolate (compute, Isolate.run) or after the animation.',
  screenMount:
    "The new route's first build and layout ran in these frames, during the transition. Keep the first build light: build heavy parts after the transition (a post-frame callback), use ListView.builder for long lists, and precache images.",
  frameUnknown:
    'The raster thread took too long: saveLayer (Opacity, ShaderMask, clips with anti-aliasing), shadows and blurs, or large images. Use FadeTransition instead of Opacity, keep BackdropFilter off moving content, and wrap what moves in a RepaintBoundary.',
  burst: 'Stagger them with Interval curves on one AnimationController, so the UI isolate does not start every animation in one frame.',
}

const IOS: Advice = {
  callback:
    'Move the heavy work off the main thread (a background queue or a Task, then update the UI on the main actor), or after the animation. Animations set up while it runs start late.',
  untimed:
    "This is main-thread work outside what the inspector sees: layout, view setup, or a synchronous call (disk, keychain, a lock). Profile it with Instruments' Time Profiler or the Hangs instrument.",
  startedWhileBlocked: 'It was set up while the main thread was busy, so it started late. Move the blocking work off the main thread, or start the animation before it.',
  screenMount:
    "The new screen's setup and first layout ran in these frames, during the transition. Defer heavy work until it has appeared, load data off the main thread, and keep cell setup light.",
  frameUnknown:
    'Rendering took too long: offscreen passes (shadows without a shadowPath, masks, corner clipping with blur), large images decoding on the main thread, or layout every frame. Set shadowPath, decode images ahead of time, and animate transforms instead of frames.',
  burst: 'Stagger them with a delay, or group them in one UIViewPropertyAnimator, so the main thread does not set up every animation in one frame.',
}

const ANDROID: Advice = {
  callback:
    'Move the heavy work off the main thread (a coroutine on Dispatchers.Default, then post the result back), or after the animation. Animators tick on the main thread, so they stop while it runs.',
  untimed:
    "This is main-thread work outside what the inspector times: inflation, layout, a binder call, or disk I/O (StrictMode finds those). Record a trace with Android Studio's profiler to see the function.",
  startedWhileBlocked: 'It started while the main thread was busy, so its first frames waited. Move the blocking work off the main thread, or start the animation before it.',
  screenMount:
    "The new screen's creation, inflation and first layout ran in these frames, during the transition. Inflate less up front (ViewStub), load data off the main thread, and use RecyclerView for long lists.",
  frameUnknown:
    'RenderThread took too long: overdraw, large bitmaps, elevation shadows on moving views, or a layer redrawn every frame. Animate translation, scale and alpha (with withLayer() for complex views), and keep bitmaps at the size they are drawn.',
  burst: 'Stagger them with startDelay, or play them together in one AnimatorSet, so the main thread does not start every animation in one frame.',
}

const GENERIC: Advice = {
  callback: 'Move the heavy work off the app thread, or after the animation, split it, or cache the result.',
  untimed: 'This is work on the app thread outside what the inspector times. Profile the app with its platform profiler to see the function.',
  startedWhileBlocked: 'It started while the app thread was busy, so its first frames waited. Move the blocking work, or start the animation before it.',
  screenMount: "The new screen's first build and layout ran in these frames. Keep it light, and defer heavy parts until after the transition.",
  frameUnknown: 'Rendering took too long for these frames: look at what is drawn while it moves (shadows, blur, large images, layout every frame).',
  burst: 'Stagger them, or drive them from one progress value, so they do not all start in one frame.',
}

/** The fixes for the app's framework. */
export function adviceFor(app: AppLike): Advice {
  const f = app?.framework
  if (!f || f === 'react-native') return REACT_NATIVE
  if (f === 'flutter') return FLUTTER
  if (f === 'uikit' || f === 'swiftui') return IOS
  if (f === 'android-views' || f === 'compose') return ANDROID
  return GENERIC
}

/** What the app's animated values are called: "shared values" on React Native. */
export function valuesNoun(app: AppLike): string {
  const f = app?.framework
  if (!f || f === 'react-native') return 'shared values'
  if (f === 'uikit' || f === 'swiftui') return 'animated layers'
  return 'animated values'
}

/** What to say while an app has reported no values yet: how values reach the inspector on its framework. */
export function noValuesHint(app: AppLike): { lead: string; body: string; code?: string } {
  const f = app?.framework
  if (!f || f === 'react-native') {
    return { lead: 'No shared values yet', body: 'The Babel plugin reports every useSharedValue once its component renders.', code: "plugins: ['@keyframerdev/inspector/babel']" }
  }
  if (f === 'flutter') {
    return {
      lead: 'No animated values yet',
      body: 'Values appear as their controllers are created. Use KfAnimationController, or call kfTrack on a controller you already have.',
      code: "final scale = KfAnimationController(vsync: this, duration: const Duration(milliseconds: 300))\n// or: controller.kfTrack('scale')",
    }
  }
  if (f === 'uikit' || f === 'swiftui') {
    return {
      lead: 'Nothing has animated yet',
      body: 'Core Animation is watched without code changes: layers show up here once something on screen animates. Name a view, or wrap code in trace for exact lines.',
      code: 'KeyframerInspector.track(card, as: "card")\nKeyframerInspector.trace("bounce") { UIView.animate(...) }',
    }
  }
  if (f === 'android-views' || f === 'compose') {
    return {
      lead: 'No animated values yet',
      body: 'Register the animators you want to see, and any other value with a reader.',
      code: 'ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title").start()\nKeyframer.signal("progress", read = { view.alpha })',
    }
  }
  return { lead: 'No animated values yet', body: 'Values appear once the app reports them.' }
}

/** How to let the app snapshot its screen (for GIF / MP4 export and capture), in its framework's terms. */
export function captureHint(app: AppLike): { text: string; code?: string } {
  const f = app?.framework
  if (!f || f === 'react-native') {
    return {
      text: 'Install react-native-view-shot (it ships in Expo Go) or use Skia in a development build, and reload: the inspector finds either. Skia captures the view inside <MotionScan>. Or pass your own captureScreen when connecting.',
      code: 'npx expo install react-native-view-shot',
    }
  }
  if (f === 'flutter') {
    return { text: 'Wrap the app in the KeyframerInspector widget: it captures what it wraps.', code: 'runApp(KeyframerInspector(child: MyApp()))' }
  }
  if (f === 'uikit' || f === 'swiftui') {
    return { text: 'Capture is built in: check that it is not turned off where the inspector starts.', code: 'KeyframerInspector.start(.init(captureScreen: true))' }
  }
  if (f === 'android-views' || f === 'compose') {
    return { text: 'Capture is built in (PixelCopy): it needs an activity on screen, on Android 8 or later.' }
  }
  return { text: 'This app did not say it can capture its screen.' }
}
