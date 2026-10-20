# Motion Vitals golden fixtures

Wire messages of `../../src/vitals.ts`, accepted (or refused) by `../../src/vitals-validate.ts`. Every SDK's
tests check its encoder against these shapes; the ingest Worker's tests post them. `symbols/` belongs to
the symbols CLI. Regenerate nothing by hand without running the validator over the result.

Valid, and consistent beyond what the validator checks: histograms of 8 buckets that add up to `frames`,
each worst frame's `missed = round(ms / (1000 / targetHz)) - 1` and counted in its screen's histogram
bucket, frames of 700 ms or more counted as `frozen`, worst frames sorted longest first, every site's
`worstMs` at least the worst frames that list it, `missed <= frames` per site, screens' `ms` within
`foregroundMs`, indexes in range, every limit of `VITALS_LIMITS` respected.

| File | What |
| --- | --- |
| `report-react-native.json` | React Native on a low-tier Android phone: `source` refs from the Babel plugin, one `hashed` ref (`hashSites`), `ui` and `js` threads, all five causes the light mode computes on React Native |
| `report-ios.json` | iOS (SwiftUI), second window of a session (`seq: 1`, `ended: 'window'`): `name` and `native` refs into two Mach-O `images`, one thread (`js`, the main thread), a frozen frame, `runsReduceMotion` |
| `report-android.json` | Android (Compose): `name` and `jvm` refs (one renamed by R8, one kept), `app.debugId` from the Gradle plugin |
| `report-flutter.json` | Flutter on a 120 Hz screen running at 60: `name`, `source` and `native` refs into one ELF image (`libapp.so`), sent on the next launch (`ended: 'unknown'`) |
| `config.json` | `VitalsConfig` during a release boost. Its `minSdk` values are `0.0.1`, below every SDK's first version, so a test that applies it never switches its SDK off |
| `ingest-response.json` | 200 from `POST /v1/reports`, carrying `config.json` |
| `ingest-response-stop.json` | 200 with `stop: true`: the SDK turns off for 7 days |

Invalid reports (each is `report-react-native.json`, or `report-ios.json` where it says so, with one thing wrong):

| File | What is wrong |
| --- | --- |
| `invalid-format.json` | `format` is `keyframer-field`, the old proposal's name |
| `invalid-hist-buckets.json` | a histogram with 7 buckets |
| `invalid-hist-sum.json` | a histogram that does not add up to `frames` |
| `invalid-site-screen.json` | a site's `screen` points past `screens` |
| `invalid-worst-site.json` | a worst frame lists a site index past `sites` |
| `invalid-too-many-worst.json` | 11 worst frames (the limit is 10) |
| `invalid-native-image.json` | `report-ios.json` without `images`: its `native` refs point at nothing |
| `invalid-screen-name.json` | a screen name longer than 64 characters |
| `invalid-sample-rate.json` | `sampleRate` 0 |
| `invalid-measured.json` | `measuredMs` more than `foregroundMs` |
| `invalid-cause.json` | a worst frame's `cause` is not one of `VitalsCause` |
| `invalid-missing-nonce.json` | `session.nonce` is missing |
