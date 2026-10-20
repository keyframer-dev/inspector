---
title: Android (Compose and Views)
description: Add dev.keyframer:vitals and the Gradle plugin, start it in Application.onCreate, and name animations.
order: 4
section: Motion Vitals
---

# Motion Vitals for Android

`dev.keyframer:vitals` is the production reporter for Android. It goes in every variant (the inspector's release builds link a no-op artifact, so the reporter cannot live there). It reads frames passively from JankStats, so it adds no frame callback of its own, and it measures the RenderThread too.

You need Android 7 (API 24) or later. The only permission it adds is `INTERNET`.

## 1. Add the dependency and the Gradle plugin

The Gradle plugin is published on Maven Central, not the Gradle Plugin Portal, so `settings.gradle.kts` needs `mavenCentral()` in `pluginManagement { repositories { … } }`. Projects made by Android Studio already list it there.

```kotlin
// app/build.gradle.kts
plugins {
  id("com.android.application")
  id("dev.keyframer.vitals") version "0.1.0"    // build ids and R8 mapping uploads
}

dependencies {
  implementation("dev.keyframer:vitals:0.1.0")
  implementation("dev.keyframer:vitals-compose:0.1.0")   // Compose apps

  // The inspector stays development only, as before
  debugImplementation("dev.keyframer:keyframer-inspector:0.1.0")
  releaseImplementation("dev.keyframer:keyframer-inspector-noop:0.1.0")
}
```

The Gradle plugin is optional but recommended: it stamps each minified build with a build id and uploads its R8 mapping, so call sites have names. See [Symbols](symbols.md#android).

## 2. Start it

```kotlin
// Application.onCreate
KeyframerVitals.start(this, key = "kfp_live_7Hq2xR…")
```

Reporting starts at `start`. If your app asks for consent first, call it after: see [Consent and privacy](consent.md).

| Parameter | Default | What it does |
|---|---|---|
| `key` | required | The project's field key, `kfp_live_…`. Any other key is refused |
| `appVersion`, `build` | the package's `versionName` and `versionCode` | The version the dashboard groups by |
| `environment` | `"production"` in release builds | Debuggable builds report nothing unless you pass `"development"`; their reports land in an environment the dashboard hides by default |
| `sampleRate` | `0.1` | The share of sessions that report, until the project's settings say otherwise |
| `endpoint` | `https://vitals.keyframer.dev` | The ingest server |

`start` returns `false` when the key is not a field key or it was already called. It can be called from any thread; it runs on the main thread.

## 3. Name animations

R8 renames classes in release builds, so name the animations you care about; a named site shows up by name in every build, with or without a mapping.

Views:

```kotlin
import dev.keyframer.vitals.kfTrack

ObjectAnimator.ofFloat(title, View.ALPHA, 0f, 1f).kfTrack("title-fade").start()
```

`kfTrack()` without a name uses where it was called (named from the R8 mapping). `KeyframerVitals.track(animator, name)` does the same from Java.

Compose: use the tracked versions from `dev.keyframer.vitals.compose`, with a `label` to name them:

```kotlin
import dev.keyframer.vitals.compose.kfAnimateFloatAsState

val scale by kfAnimateFloatAsState(if (pressed) 0.96f else 1f, label = "card-press")
```

| Compose API | Tracked version |
|---|---|
| `animateFloatAsState`, `animateDpAsState`, `animateIntAsState`, `animateOffsetAsState`, `animateColorAsState`, `animateValueAsState` | `kfAnimateFloatAsState` and the rest, same parameters |
| `Animatable.animateTo` | `Animatable.kfAnimateTo` |
| `updateTransition` | `kfUpdateTransition` |
| `rememberInfiniteTransition` | `rememberKfInfiniteTransition` |

These share their names with the inspector's Compose helpers. A file imports one or the other: the inspector's in development-only code, these in code that ships.

Each janky frame is handed back by JankStats with the screen and the tracked animations that were running, so attribution is exact per frame.

## 4. Screens

Activities are screens by default, by class name. Apps with one activity and many destinations name them:

```kotlin
KeyframerVitals.setScreen("checkout")             // reported as MainActivity/checkout
```

Compose:

```kotlin
KfVitalsNavigation(navController)                 // every Navigation destination's route
KfVitalsScreen("checkout")                        // or one screen, while it is composed
```

Pass route patterns (`users/{id}`), not values. Names are masked (ids, emails, long numbers, tokens) and cut to 64 characters before they leave the device.

## 5. Stop or pause reporting

```kotlin
KeyframerVitals.setEnabled(false)   // stops now, and drops the open window, the checkpoint and unsent reports
KeyframerVitals.setEnabled(true)    // starts again, as a new session
```

The choice is not remembered: call it on every launch your app needs it. `KeyframerVitals.isEnabled` says whether it is reporting.

## How it measures

- Frames from JankStats on each activity's window, only while a sampled session measures, with the deadline Android 12 and later gives as the budget. The RenderThread's share is the `ui` thread on the dashboard.
- Device details: `Build.MODEL`, total memory, the media performance class (Android 12 and later), battery saver, thermal status (Android 10 and later), and Remove animations as Reduce Motion (only if the project collects it).
- Uploads use `HttpURLConnection` when the process goes to the background. No WorkManager, no background jobs. With Data Saver on, they wait for the next launch. Unsent reports wait in the app's files directory.

## Check that it works

1. Build and install a release build (`./gradlew installRelease`), or a debug build with `environment = "development"` if the project accepts development builds.
2. Pass `sampleRate = 1.0` in that build (or raise the project's rate) so the session is sampled.
3. Animate something, then press Home.
4. The project's setup page shows the first report within a few minutes.
