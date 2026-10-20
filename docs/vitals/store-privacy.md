---
title: App Store and Google Play answers
description: What to declare for Motion Vitals in App Store Connect's privacy details, the privacy manifest, and Google Play's data safety form.
order: 7
section: Motion Vitals
---

# App Store and Google Play answers

What Motion Vitals collects, in the words of each store's form. Your answers cover your whole app, so combine these with what the rest of your app and its other SDKs collect. This is guidance, not legal advice.

## App Store: App Privacy details

In App Store Connect, App Privacy, add one data type for Motion Vitals:

| Question | Answer |
|---|---|
| Data type | **Diagnostics > Performance Data** |
| Is it collected? | Yes, from sampled sessions, once your app calls `start` |
| Linked to the user's identity? | **No**. Reports carry no account, device or install identifier |
| Used for tracking? | **No**. Nothing is combined with other companies' data or used for advertising |
| Purposes | **App Functionality** and **Analytics** (as the SDK's privacy manifest declares) |

Do not declare Device ID, Usage Data, Location or Crash Data for Motion Vitals: it sends none of them. No App Tracking Transparency prompt is needed, and the SDK never reads the IDFA.

## The privacy manifest

`KeyframerVitals` ships its own `PrivacyInfo.xcprivacy`. Xcode merges it into the privacy report of your archive (Product > Archive, then Generate Privacy Report). It declares:

| Key | Value | Why |
|---|---|---|
| `NSPrivacyTracking` | `false` | No tracking |
| `NSPrivacyTrackingDomains` | none | |
| `NSPrivacyCollectedDataTypes` | `NSPrivacyCollectedDataTypePerformanceData`, not linked, not used for tracking, purposes `NSPrivacyCollectedDataTypePurposeAnalytics` and `NSPrivacyCollectedDataTypePurposeAppFunctionality` | The reports |
| `NSPrivacyAccessedAPITypes` | `NSPrivacyAccessedAPICategorySystemBootTime`, reason `35F9.1` | Frame times from `CACurrentMediaTime` and `mach_absolute_time`, measured within the app |
| | `NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1` | The daily session count, the cached config and pending reports, read by the app only |

React Native and Flutter apps on iOS: their reporters are Dart and JavaScript inside your app and ship no manifest of their own, so declare the same Performance Data answer in App Store Connect yourself. Their storage goes through the adapter you pass (AsyncStorage, shared_preferences), whose own manifest covers it.

## Google Play: Data safety

In Play Console, App content, Data safety:

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | Yes (if Motion Vitals is your only collection, it is this one) |
| Data type | **App info and performance > Diagnostics** ("framerate" is in Google's own description of it) |
| Collected? | **Yes** |
| Shared? | **No**. Keyframer processes the data on your behalf as a service provider, which Play does not count as sharing |
| Processed ephemerally? | No: reports are stored (see [Retention and limits](limits.md)) |
| Required or optional? | Your choice: optional if your app lets people turn it off (you call `setEnabled(false)`), required otherwise |
| Purposes | **App functionality** and **Analytics** |
| Encrypted in transit? | **Yes**, HTTPS only |
| Can users ask for their data to be deleted? | Reports are not linked to a person, so there is nothing to find per person. Answer as your app's deletion process does for the rest of its data |

Do not declare Device or other IDs, Location, Personal info or App activity for Motion Vitals.

## Your privacy policy

Both stores ask for a privacy policy link. A sentence you can adapt is in [Consent and privacy](consent.md#a-sentence-for-your-privacy-policy).

## If you change the switches

- Device models off, or Kids mode on: the answers stay the same (fewer details, same data type).
- Reduce Motion on: still Performance Data and Diagnostics. It is a flag on an anonymous session, shown in aggregate only. Mention it in your privacy policy if you collect it.
