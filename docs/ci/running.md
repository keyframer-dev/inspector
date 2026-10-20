---
title: Running in CI
description: Run scenarios and check files with keyframer-inspect ci, and fail a pull request on a motion regression.
order: 1
section: CI
---

# Running in CI

`keyframer-inspect ci` runs the app's scenarios and [check files](check-files.md) with nobody watching, compares them with a [baseline](baselines.md) committed next to the code, and fails a pull request that adds a problem, loses more frames, or misses a motion limit.

## Record a baseline, then compare

```sh
npx keyframer-inspect ci --update-baseline     # records .keyframer/baseline.json: commit it
npx keyframer-inspect ci                       # compares; exit 1 on a regression
```

## What it does

1. Waits for the app to connect through Metro or the relay (`--timeout`, 120 s).
2. Reloads the app before each scenario, so every scenario starts clean. An app that cannot reload runs its replay instead. `--no-reload` turns this off.
3. Throws away one warm-up run (`--warmup 1`), then runs each scenario and check `--runs` times (3) and keeps the median of each number.
4. Compares with the baseline and prints what was fixed, what is still there, what is new, and how each number moved.

## Where the app is

| App | Flag |
|---|---|
| React Native on Metro | `--metro http://localhost:8081` (default: looks on 8081 to 8090) |
| Flutter, iOS, Android, or React Native on the relay | `--relay ws://127.0.0.1:8790` |

`ci` connects to Metro or the relay on the machine it runs on. Start the desktop app, or Metro, before it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | No regression |
| 1 | A regression, a failed motion limit, or a scenario or check that failed |
| 2 | A setup error: no app, no baseline, an unknown scenario, or a check file that is not valid |

## GitHub Actions

A job on a macOS runner, with Expo Go on a simulator:

```yaml
name: Animations
on: pull_request
jobs:
  inspector:
    runs-on: macos-15
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - name: Boot a simulator
        run: |
          UDID=$(xcrun simctl create ci "iPhone 16 Pro")
          xcrun simctl boot "$UDID"
          # exp:// links open Expo Go without asking.
          xcrun simctl spawn "$UDID" defaults write com.apple.launchservices.schemeapproval \
            "com.apple.CoreSimulator.CoreSimulatorBridge-->exp" -string host.exp.Exponent
      - name: Start the app
        # --ios installs Expo Go on the booted simulator and opens the app. With a development
        # build: xcrun simctl install booted <App.app>, then open its URL with xcrun simctl openurl.
        run: CI=1 npx expo start --ios --port 8081 > metro.log 2>&1 &
      - name: Check the scenarios
        run: npx keyframer-inspect ci --metro http://localhost:8081 --format github --out inspector.txt
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: inspector
          path: |
            inspector.txt
            metro.log
```

`--format github` adds `::error` annotations at each new problem's line and a job summary. See [Output formats](output.md).

## EAS

EAS Build makes the instrumented build: keep the Babel plugin in a preview profile with `KEYFRAMER_INSPECTOR=1` (see [Preview builds](../panel/library.md#preview-builds-for-testers)), install that build on the CI simulator, and open it before `ci` runs. Running `ci` inside EAS Workflows, and unattended runs on cloud simulators, are designed but not part of this release.

## Keep scenarios repeatable

- Screens a stack keeps mounted under the one on top keep running. Run loops only while their screen is focused (`useIsFocused` or `useFocusEffect`), or they show up in every later scenario.
- Record the baseline on the same kind of machine CI runs on: a laptop and a CI runner do not lose the same frames.
- A debug build's frame slack is doubled, and the report says the numbers are inflated.

## Thresholds

| Flag | Default | |
|---|---|---|
| `--max-new-problems N` | 0 | New problems allowed |
| `--min-severity low, medium or high` | low | Only new problems this severe count |
| `--frames-lost-tolerance 25%`, `--frames-lost-slack 3` | 3 frames | Frames lost may grow by the percentage or the slack, whichever is more |
| `--longest-frame-tolerance 25%`, `--longest-frame-slack 50` | 50 ms | The longest frame may grow by the percentage or the slack, whichever is more |

The defaults come from running unchanged code, where frames lost moved by up to 20% between runs. On a display above 60 Hz, the frames lost slack scales with the rate (6 frames at 120 Hz).

All flags are in the [CLI reference](../reference/cli.md#keyframer-inspect-ci).
