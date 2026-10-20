---
title: Consent and privacy
description: When reporting starts, how to stop it, what a report never contains, and the project switches for Reduce Motion and device models.
order: 6
section: Motion Vitals
---

# Consent and privacy

Motion Vitals works the way crash and performance tools such as Sentry do: **reporting starts when your app calls `start`**, and stops when it calls `setEnabled(false)`. There is no consent screen built in. The SDK never sends personal data, so most apps start it at launch; an app that needs consent first starts it after.

This page explains what that means in practice. It is not legal advice: what your app needs depends on where it ships and what your counsel says.

## When reporting starts and stops

| Call | React Native | iOS, Android, Flutter |
|---|---|---|
| Start: measuring and sending begin, for sampled sessions | `startVitals(...)` | `KeyframerVitals.start(...)` |
| Stop: measuring and sending stop at once, and the open window, its checkpoint and every unsent report are dropped | `setVitalsEnabled(false)` | `KeyframerVitals.setEnabled(false)` |
| Start again, as a new session | `setVitalsEnabled(true)` | `KeyframerVitals.setEnabled(true)` |

Before the start call, nothing is measured, stored or sent.

The SDK does not remember a consent choice for you: the enabled state lives in memory only. Keep it where your app keeps its other consent choices, and call `setEnabled(false)` (or skip `start`) on each launch when it is off.

## When to wait for consent

Start at launch when your counsel agrees that anonymous performance counters, measured for your own app only, need no consent where you ship. Many teams treat it like crash reporting.

Start after consent when:

- your app ships in the EU or UK and your counsel reads the ePrivacy rules on reading information from a device broadly (the EDPB's 2023 guidelines do), and you do not rely on an exemption for audience or performance measurement;
- your app already gates analytics and diagnostics behind a consent tool, and you want Motion Vitals to follow the same switch;
- your app is for children (see below).

```ts
// React Native: start only after consent
import { setVitalsEnabled, startVitals } from '@keyframerdev/vitals'

const options = { key: 'kfp_live_…', appVersion }
if (await consent.hasAnalytics()) startVitals(options)
consent.onChange((granted) => (granted ? startVitals(options) : setVitalsEnabled(false)))
```

## What a report never contains

- **No pixels**: no screenshots, no video, no captured frames.
- **No text**: no log or error messages, no text input, no navigation params, no accessibility labels.
- **No values**: no animated values and no animation arguments. A count-up of an account balance is reported as a call site and frame counts, never the balance.
- **No touches**: no coordinates, no gesture paths.
- **No identifiers**: no user id, no device id (IDFV, ANDROID_ID, advertising ids), no install id, no persistent session id. A session's random nonce lives in memory only and is never written to disk or reused.
- **No time or place**: no timestamps from the device, no locale, time zone or location. The server stamps the time a report arrives, truncated to the hour.

The IP address is seen by Cloudflare's network to deliver the request and to rate limit it, and is never written to storage.

Screen names are masked on the device (ids, emails, long numbers and tokens become `[id]`, `[email]`, `[number]`, `[token]`) and cut to 64 characters. Call sites are your source code's locations, not data about the person using the app; you can [hash them](react-native.md#hide-file-paths) on React Native.

On the device, the SDK stores only a count of reported sessions today (at most 3 per day), the cached project config, a checkpoint of the open window, and up to 5 reports waiting to be retried. None of it identifies anyone.

## Project switches

Each project has switches the ingest server enforces, whatever an SDK sends. Owners and admins change them in the project's settings, and every change is in the workspace's audit log.

| Switch | Default | What it does |
|---|---|---|
| Reduce Motion | Off | Collect whether Reduce Motion (Remove animations on Android, Disable animations in Flutter) was on during a session. An accessibility setting can hint at a health condition, so it is opt-in. Off: the SDK does not read it, the server drops it, and the Accessibility page says it is not collected rather than showing zeros |
| Device models | On | Send the raw model identifier (`iPhone15,3`, `SM-A146B`) so the dashboard can show models and tiers. Models are shown only above 50 sessions, so a rare device in a small app cannot be singled out. Off: tiers only |
| Development builds | Off | Accept reports with `environment: development` |
| Kids mode | Off | Drop the model (tier only) for apps in Apple's Kids category or Google's Families program |

Reduce Motion, when collected, is a flag on the session and is only ever shown in aggregate.

## Apps for children

Apple's Kids category allows third-party analytics only when nothing identifiable about the child or the device is collected; Google's Families policy is similar. Turn on Kids mode, and review your setup with counsel before you start Motion Vitals in a children's app. If in doubt, start it only after a parent's consent.

## A sentence for your privacy policy

> We measure how smoothly our app's screens and animations draw, using Keyframer Motion Vitals. A sample of sessions sends frame timing counts, the app version, the operating system and the device model to Keyframer, which processes them on our behalf. These reports contain no identifiers, no content you see or type, and no location, and cannot be linked to you.

Adapt it to your app, and drop "the device model" if you turn device models off.

## Keyframer's role

For Motion Vitals, Keyframer processes data on your behalf: you are the controller (or a processor for your own client), Keyframer is your processor. The Data Processing Agreement is accepted in the workspace's settings, and the subprocessors are listed at [keyframer.dev/legal/subprocessors](https://keyframer.dev/legal/subprocessors). See [keyframer.dev/legal/dpa](https://keyframer.dev/legal/dpa).
