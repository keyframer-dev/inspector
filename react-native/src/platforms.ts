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

const SWIFTUI: Advice = {
  callback:
    "Move the heavy work off the main actor (a detached Task or a background actor, then set state on the main actor), or after the animation. SwiftUI evaluates body and starts animations on the main thread, so they start late while it runs.",
  untimed:
    "This is main-thread work outside what the inspector sees: body evaluation, layout, or a synchronous call (disk, keychain, a lock). Profile it with Instruments' SwiftUI and Time Profiler instruments.",
  startedWhileBlocked: 'It was set up while the main thread was busy, so it started late. Move the blocking work off the main actor, or start the animation before it.',
  screenMount:
    "The new view's body and first layout ran in these frames, during the transition. Keep body cheap: load data in .task off the main actor, use List or a Lazy stack for long content, and defer heavy subviews until it has appeared.",
  frameUnknown:
    'Rendering took too long: offscreen passes (shadows, masks, blurs and materials over moving views), large images decoding on the main thread, or layout every frame. Give shadows a shape, flatten still content with .drawingGroup(), and animate offset and scaleEffect instead of frame.',
  burst: 'Start them in one withAnimation (one transaction), or stagger them with .delay, so the main thread does not set up every animation in one frame.',
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
  if (f === 'uikit') return IOS
  if (f === 'swiftui') return SWIFTUI
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

// ─── Motion and drawing ───────────────────────────────────────────────────────────
// Fixes for how an app moves rather than what blocks it: worded for each UI framework, SwiftUI and
// Compose apart from UIKit and Views (their APIs differ here).

type FixGroup = 'react-native' | 'flutter' | 'uikit' | 'swiftui' | 'android-views' | 'compose' | 'generic'

function fixGroup(app: AppLike): FixGroup {
  const f = app?.framework
  if (!f || f === 'react-native') return 'react-native'
  if (f === 'flutter' || f === 'uikit' || f === 'swiftui' || f === 'android-views' || f === 'compose') return f as FixGroup
  return 'generic'
}

/** What the person's motion setting is called on the app's platform. */
export function reduceMotionSetting(app: (Pick<InspectorAppInfo, 'framework'> & { platform?: string }) | null | undefined): string {
  const p = app?.platform
  if (p === 'android') return 'Remove animations'
  if (p === 'web') return 'reduced motion'
  return 'Reduce Motion'
}

/** How the motion problems are fixed, in the framework's own terms. */
export type MotionAdvice = {
  /** An animation that moved while the person asked for less motion. */
  reduceMotion: string
  /** A value that kept moving where nobody could see it. */
  unseen: string
  /** Two animations writing one value at once. */
  twoWriters: string
  /** An interrupted animation that jumped instead of continuing. */
  jump: string
}

const MOTION: Record<FixGroup, MotionAdvice> = {
  'react-native': {
    reduceMotion:
      "Respect the setting: leave Reanimated's reduceMotion at ReduceMotion.System (the default; ReduceMotion.Never ignores the setting), or read useReducedMotion() and set the end value directly, or fade instead of moving. Motion driven by setState or a JS loop does not follow the setting at all.",
    unseen:
      'Stop it while nobody can see it: cancelAnimation when the screen loses focus (useIsFocused, useFocusEffect) or the app goes to the background (AppState), and start it again on return. For items scrolled away, pause on viewability (onViewableItemsChanged).',
    twoWriters:
      'Assigning to a shared value cancels the animation running on it, so the last writer wins and the motion restarts from wherever it was. Give the value one owner: drive both from one place (one handler, or a useAnimatedReaction), or cancelAnimation and hand over on purpose.',
    jump: 'The new animation started from another value than the one on screen. Start from the current value: do not set .value before animating, and pass the gesture\'s velocity to withSpring (or use withDecay) so the motion continues.',
  },
  flutter: {
    reduceMotion:
      "Check MediaQuery.disableAnimationsOf(context) and skip the animation when it is true: set the controller's value to the end, use a zero duration, or fade instead of moving.",
    unseen:
      "Stop the controller while it cannot be seen: TickerMode mutes the tickers of covered routes (use the State's vsync), RouteAware's didPushNext and AppLifecycleListener say when, and VisibilityDetector covers items scrolled away.",
    twoWriters: 'Two controllers or tweens drive the same property: give it one AnimationController and animateTo from its current value, or stop the other one first.',
    jump: 'Do not reset the controller when interrupting it (setting controller.value, or forward(from: 0)): animateTo from its current value, or animateWith a SpringSimulation that starts at its current velocity.',
  },
  uikit: {
    reduceMotion:
      'Check UIAccessibility.isReduceMotionEnabled before animating (and observe reduceMotionStatusDidChangeNotification): set the final state directly, or cross-fade instead of moving.',
    unseen:
      'Pause or remove it when the view leaves the window or the app goes to the background (didMoveToWindow, viewDidDisappear, sceneDidEnterBackground); a Core Animation loop pauses with layer.speed = 0.',
    twoWriters:
      'Two animations target the same layer property: the newer one replaces the older (or adds to it, when additive), so the motion jumps or fights. Use one UIViewPropertyAnimator for the property and continue it, or remove the older animation first.',
    jump: "Start from what is on screen, not from the model value: the presentation layer's value (UIView.animate with .beginFromCurrentState), or a UIViewPropertyAnimator, which can be continued or reversed.",
  },
  swiftui: {
    reduceMotion:
      'Read @Environment(\\.accessibilityReduceMotion) and animate with nil (or a short fade) when it is true: withAnimation(reduceMotion ? nil : .spring()).',
    unseen: 'Stop it in onDisappear and when scenePhase leaves .active, and drive loops from state that is only set while the view is on screen.',
    twoWriters: "Two transactions animate the same state at once: let one of them change it, or chain them with withAnimation's completion.",
    jump: 'SwiftUI continues from the value on screen when the same state animates again: a jump means the state was reset first, or the view got a new identity (an id, or a changed if branch). Animate the change itself, with a spring that keeps the velocity.',
  },
  'android-views': {
    reduceMotion:
      'Check ValueAnimator.areAnimatorsEnabled() (false when animations are removed) and set the end state directly. Animators already follow the animator duration scale, so this one is driven some other way (a Handler, a Choreographer callback, a custom loop).',
    unseen: 'Pause the animator when the view is detached or hidden (onDetachedFromWindow, onPause, View.isShown) and resume it on return.',
    twoWriters:
      "Two animators set the same property every frame, so it flickers between them. Cancel the running one first, or use the view's ViewPropertyAnimator, which replaces its own animation of a property.",
    jump: "Cancel the running animator and start the next from the view's current value (ObjectAnimator.ofFloat with only an end value starts there), or use a SpringAnimation, which keeps its velocity.",
  },
  compose: {
    reduceMotion:
      "Use Compose's animation APIs (animate*AsState, Animatable, updateTransition), which follow the animator duration scale, or check ValueAnimator.areAnimatorsEnabled() and snapTo the target. Loops in withFrameNanos ignore the setting.",
    unseen:
      'Tie it to the composition and the lifecycle: rememberInfiniteTransition stops when it leaves composition; run loops in LaunchedEffect under repeatOnLifecycle(Lifecycle.State.STARTED), or key them to visibility.',
    twoWriters: 'Two animations drive the same value: keep one Animatable and call animateTo, which cancels the running animation and continues from the current value and velocity.',
    jump: 'Keep one remembered Animatable and call animateTo: it continues from the current value and velocity. Avoid snapTo before animating, and remember the Animatable so recomposition does not create a new one.',
  },
  generic: {
    reduceMotion: "Check the platform's reduce motion setting before animating: set the end state directly, or fade instead of moving.",
    unseen: 'Stop the animation while its view cannot be seen (off screen, hidden, covered, or the app in the background), and start it again when it is visible.',
    twoWriters: 'Two animations write the same value at once: give it one owner, or stop the running one before starting the other.',
    jump: 'Start the interrupting animation from the value on screen, and with its velocity, not from a reset value.',
  },
}

/**
 * The framework a call site is written with, where an app mixes two (UIKit views in a SwiftUI app, Views
 * in a Compose one): read from the animation's function (UIView.animate, CABasicAnimation and
 * UIViewPropertyAnimator are UIKit, withAnimation SwiftUI; ObjectAnimator and the other animators
 * Views, animateTo and animate*AsState Compose), else the app's. The app with that framework, for
 * wording the site's fix.
 */
export function siteFramework<T extends Pick<InspectorAppInfo, 'framework' | 'threads'>>(app: T | null | undefined, fn: string | null | undefined): T | null | undefined {
  const f = app?.framework
  if (!app || !fn) return app
  let site: string | null = null
  if (f === 'uikit' || f === 'swiftui') {
    if (/^(UIView|UIViewPropertyAnimator|CA[A-Z]|CALayer)/.test(fn)) site = 'uikit'
    else if (/^(withAnimation|withTransaction|\.|Animation\b|phaseAnimator|keyframeAnimator)/.test(fn)) site = 'swiftui'
  } else if (f === 'android-views' || f === 'compose') {
    if (/(Animator|SpringAnimation|FlingAnimation|TransitionManager)/.test(fn)) site = 'android-views'
    else if (/^(animate\w*AsState|animateTo|animateDecay|snapTo|Animatable|updateTransition|rememberInfiniteTransition|AnimatedVisibility|AnimatedContent|Crossfade|animateContentSize)/.test(fn)) site = 'compose'
  }
  return site && site !== f ? { ...app, framework: site } : app
}

/** The motion fixes for the app's framework. */
export function motionAdviceFor(app: AppLike): MotionAdvice {
  return MOTION[fixGroup(app)]
}

/**
 * Render hint keys the SDKs send (InspectorRenderHint), each fixed per framework, with a generic fix
 * for the others. React Native: shadow-path, animated-shadow, animated-layout, animated-blur.
 * Android: layer-alpha, elevation, mask (a path outline clip), blur (the window's). iOS: shadow-path,
 * mask, blur (a blur view that moves), group-opacity, rasterize. Flutter: mask (ClipPath,
 * ShaderMask), blur (ImageFiltered, BackdropFilter), save-layer, opacity-widget.
 */
const HINTS: Record<string, Partial<Record<FixGroup, string>> & { generic: string }> = {
  'shadow-path': {
    'react-native':
      'A shadow on a view without a solid background is computed from its pixels every frame on iOS. Give the view a backgroundColor so iOS can use its bounds, or draw the shadow once (an image, or a Skia shadow) under the moving view.',
    flutter: 'A BoxShadow on a moving box repaints its blur every frame: wrap the moving part in a RepaintBoundary, or use a PhysicalModel or a pre-rendered shadow image.',
    uikit: "Set layer.shadowPath (UIBezierPath(roundedRect:cornerRadius:).cgPath) so Core Animation does not compute the shadow from the layer's pixels every frame.",
    swiftui: 'Put the .shadow on a shape with a known outline (a RoundedRectangle background) rather than on the whole moving view, or flatten still content with .drawingGroup().',
    'android-views': "Elevation shadows come from the view's outline: set an outlineProvider (ViewOutlineProvider.BOUNDS, or one with the shape) so RenderThread does not fall back to a slower path.",
    compose: "Use Modifier.shadow with the view's shape (it renders from the outline) instead of drawing a blurred shadow in drawBehind on moving content.",
    generic: "Give the shadow a known shape (a path or an outline) so it is not computed from the view's pixels every frame.",
  },
  mask: {
    'react-native': "A mask (MaskedView) over moving content is rendered offscreen every frame. Move the content inside a mask that stays still, or clip with borderRadius and overflow: 'hidden'.",
    flutter: 'ClipPath and ShaderMask over moving content rasterize the clip or the mask again every frame: clip with ClipRRect or ClipRect (Clip.hardEdge), or mask a child that stays still.',
    uikit: 'A layer.mask over moving content renders offscreen every frame: use cornerRadius with masksToBounds for rounded corners, or keep the mask on a layer that does not change.',
    swiftui: 'A .mask over moving content renders offscreen every frame: clip with .clipShape, or move the content inside a mask that stays still.',
    'android-views': 'Clipping to a path outline (clipToOutline with Outline.setPath, API 33+) rasterizes the clip again as the content moves: clip to a rect or round rect outline (Outline.setRoundRect), which is cheap, or keep the clipped content still.',
    compose: 'Clip with Modifier.clip and a shape; avoid BlendMode masks and RenderEffects on content that moves.',
    generic: 'A mask over moving content is drawn offscreen every frame: clip with a simple shape, or keep the mask on content that does not change.',
  },
  blur: {
    'react-native': 'A BlurView over moving content blurs again every frame. Blur a still snapshot, lower the radius, or keep moving content out from under it.',
    flutter: 'BackdropFilter and ImageFiltered on moving content blur again every frame: keep the blur over still content, or blur the image once ahead of time and show the result.',
    uikit: 'A UIVisualEffectView that moves, or has content moving under it, blurs again every frame: keep it still over still content while it shows, or fade in a pre-blurred snapshot.',
    swiftui: '.blur and materials over moving content blur again every frame: apply them to still content, or use a pre-blurred image.',
    'android-views': "The window blurs what is behind it (FLAG_BLUR_BEHIND, API 31+), so content moving under it is blurred again every frame: keep it still while the blur shows, or blur a snapshot of it instead.",
    compose: 'Modifier.blur over moving content blurs again every frame: blur still content, or a captured bitmap.',
    generic: 'A blur over moving content is computed again every frame: blur still content or a snapshot, or lower the radius.',
  },
  'group-opacity': {
    'react-native': 'Opacity on a view with overlapping children renders it offscreen while it is below 1. Animate the opacity of the children instead, or on Android set renderToHardwareTextureAndroid while it animates.',
    uikit: "With allowsGroupOpacity, alpha below 1 renders the layer and its sublayers offscreen: turn it off when the sublayers do not overlap, or animate the sublayers' alpha.",
    swiftui: '.opacity on a container composites it offscreen: apply it to the views inside, or to a .compositingGroup() of content that does not change.',
    'android-views': 'Alpha on a view with overlapping children draws it offscreen: return false from hasOverlappingRendering() when they do not overlap, or give it a hardware layer while it animates.',
    compose: 'graphicsLayer alpha on overlapping content uses an offscreen buffer: set compositingStrategy = CompositingStrategy.ModulateAlpha when the children do not overlap.',
    generic: 'Opacity on a group of overlapping views renders the group offscreen: animate the views inside, or flatten the group first.',
  },
  'opacity-widget': {
    flutter: "Opacity repaints its child through saveLayer on every frame it animates: use FadeTransition (or AnimatedOpacity), which only changes the layer's alpha.",
    generic: "Opacity is animated through something that repaints its content every frame: use the framework's layer-level fade instead.",
  },
  'layer-alpha': {
    'react-native': 'On Android, set renderToHardwareTextureAndroid on the view while its opacity animates, so its children are not drawn again every frame.',
    'android-views': "Alpha animates on a view with overlapping rendering and no hardware layer, so every frame draws it offscreen first. Give it a hardware layer for the animation (setLayerType(LAYER_TYPE_HARDWARE), then LAYER_TYPE_NONE, as ViewPropertyAnimator.withLayer() does), or return false from hasOverlappingRendering() when its children do not overlap.",
    compose: 'Animate alpha inside graphicsLayer { alpha = value } rather than with Modifier.alpha on content that redraws: it changes the layer, not the drawing.',
    generic: 'Alpha animated without a layer redraws the view and its children every frame: give it a hardware layer while it animates.',
  },
  elevation: {
    'android-views': 'Elevation, translationZ or z animating draws the shadow again every frame: keep the elevation fixed and animate translation or scale for the lift, or keep the outline a simple shape (a rect or round rect), whose shadow is cheap.',
    compose: 'Animating the shadow elevation (Modifier.shadow, graphicsLayer shadowElevation) draws the shadow again every frame: keep the elevation fixed and animate translation or scale instead.',
    'react-native': 'Animating elevation draws the shadow again every frame on Android: keep it fixed and animate a transform (scale, translateY) for the lift.',
    generic: 'Animating elevation draws the shadow again every frame: keep it fixed and animate a transform for the lift.',
  },
  'animated-shadow': {
    'react-native':
      'Animating shadow properties (shadowOpacity, shadowRadius, shadowOffset, elevation, boxShadow) draws the shadow again every frame. Keep the shadow fixed and fade in a shadowed view behind it, or move it with a transform; on iOS, an opaque backgroundColor gives the shadow a path.',
    generic: 'Animating the shadow draws it again every frame: keep it fixed and fade or move a shadowed layer behind the view instead.',
  },
  'animated-layout': {
    'react-native':
      'Animating width, height, margins or padding runs layout every frame (Yoga, then the native views). Animate a transform (scale, translateX/Y) instead, or let a Reanimated layout animation (LinearTransition, entering and exiting) animate the size change.',
    generic: 'Animating layout properties runs layout every frame: animate a transform (translation, scale) instead.',
  },
  'animated-blur': {
    'react-native': "Animating a blur (the filter's blur, or a BlurView's intensity) blurs again every frame. Keep the radius fixed and fade between a sharp and a blurred view, or blur a still snapshot.",
    generic: "Animating a blur's radius blurs again every frame: keep it fixed and fade between a sharp and a blurred copy.",
  },
  'save-layer': {
    flutter: 'Clip.antiAliasWithSaveLayer renders the clipped content into a saved layer every frame it moves: use Clip.antiAlias or Clip.hardEdge, which clip without one, unless the clip really needs the save layer.',
    generic: 'The clip renders its content into an offscreen layer every frame it moves: use a clip that does not save a layer.',
  },
  rasterize: {
    'react-native': 'shouldRasterizeIOS caches a bitmap that changing content renders again every frame: turn it off on views whose content changes while they move.',
    flutter: 'A RepaintBoundary around content that repaints every frame only adds a layer: put it around the part that stays still.',
    uikit: 'shouldRasterize caches the layer as a bitmap, and content that changes every frame renders that cache again each time: turn it off while it animates.',
    swiftui: '.drawingGroup() on content that changes every frame renders it offscreen each time: use it only on content that stays still while it moves.',
    'android-views': 'A hardware layer on content that redraws every frame is rebuilt every frame: use layers only while transform and alpha animate.',
    compose: 'A graphicsLayer cache over content that changes every frame is redrawn every frame: keep changing content out of the cached layer.',
    generic: 'A cached layer over content that changes every frame is rendered again every frame: cache only what stays still.',
  },
}

/** The fix for one render hint (InspectorRenderHint.hint) on the app's framework; a key it does not know gets the SDK's own detail. */
export function renderHintFix(app: AppLike, hint: string, detail?: string | null): string {
  const fixes = Object.prototype.hasOwnProperty.call(HINTS, hint) ? HINTS[hint]! : null
  if (!fixes) return `The SDK flagged how this view is drawn (${hint}${detail ? `: ${detail}` : ''}): check what it draws while it moves.`
  return fixes[fixGroup(app)] ?? fixes.generic
}
