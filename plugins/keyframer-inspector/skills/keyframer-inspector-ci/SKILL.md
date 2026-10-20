---
name: keyframer-inspector-ci
description: Write Keyframer Inspector check files (.keyframer/checks/*.yml) and baselines, and run keyframer-inspect ci in GitHub Actions (or on an EAS-built app) so a pull request fails when an animation regresses - settle time, overshoot, duration, dropped frames, or problem kinds such as reduce-motion, unseen, two-writers and jump. Use when asked to add motion or animation tests, guard an animation in CI, write a check file, record or update a motion baseline, run checks on several simulators, or read a failing keyframer-inspect ci report.
---

# Motion checks in CI

`keyframer-inspect ci` runs the app's registered scenarios and every check file, compares them with `.keyframer/baseline.json`, and exits 1 on a regression. Docs: https://keyframer.dev/inspector/docs/ci/check-files

The inspector must already be set up (use `keyframer-inspector-setup`), and the app must be running where `ci` can reach it: Metro (React Native) or the desktop relay (`--relay ws://127.0.0.1:8790`).

## 1. Pick what drives the app

- The app registered a scenario for it (`inspector_status` lists them): `flow: { scenario: "<name>" }`.
- Otherwise steps through agent-device (`npm i -D agent-device`, Node 22.12+): `flow: { steps: [...] }`.
- An existing Maestro flow: `flow: { maestro: .maestro/x.yaml }` (Maestro on the PATH, Java 17).
- A saved agent-device run: `flow: { agent-device: flows/x.ad }`, ending without `close`.
- An Argent flow: `flow: { argent: .argent/flows/x.yaml }` (unit tested, not yet run end to end).

Exactly one source per check.

## 2. Find the names to check

Measure once before writing limits. Record the interaction (`run_scenario`, or `start_recording`, drive, `stop_recording`) and read:

- the value names (`inspector_status`, or the report): a shared value's variable name such as `sheetY`, `Component.name`, or an id;
- or a call site, `file:line`;
- the current settle time, overshoot and dropped frames, so limits have headroom.

## 3. Write the check

```yaml
# .keyframer/checks/sheet-opens.yml
# yaml-language-server: $schema=../../node_modules/@keyframerdev/inspector/schema/check.schema.json
name: sheet opens
flow:
  steps:
    - open: "Expo Go"
      url: exp://127.0.0.1:8081/--/sheet
    - wait: { id: sheet-open-full }
      timeout: 15s
    - tap: sheet-open-full
    - wait: 900ms
    - tap: sheet-close            # end where it began
    - wait: 900ms
record:
  speed: 1                        # 0.5, 0.25 or 0.1 records slowed; motion is read on the app's clock
  settle: 800ms
expect:
  - value: sheetY                 # or site: app/sheet.tsx:41
    settle: < 600ms
    overshoot: < 5%
  - frames: { dropped: 0, longest: < 50ms }
  - none: [reduce-motion, unseen, two-writers]
```

Reference, from `schema/check.schema.json`:

- Top level: `name`, `flow` (required), `record` (`speed`, `settle`, `signals`), `expect`, `targets`. No other keys.
- Steps: `open` (with optional `url`), `tap`, `longpress` (with `ms`), `type: { into, text }`, `scroll` (a direction, or `{ direction, until }`), `wait` (a time, or a target with `timeout`), `back`.
- Targets: a testID string, `{ id }`, `{ text }` (a label, else a value: an empty field's placeholder), or `{ x, y }`.
- Value or site expectations: `settle`, `overshoot`, `duration`, `velocity`, `tolerance`.
- `frames`: `dropped` (both threads), `ui`, `js`, `longest`. iOS and Android do not measure `ui`.
- `none`: `js-task`, `render-storm`, `slow-render`, `ui-work`, `busy-start`, `burst`, `layout-anim`, `js-unknown`, `screen-mount`, `ui-unknown`, `error`, `warning`, `reduce-motion`, `unseen`, `two-writers`, `jump`, `render-hint`.
- Limits: `< X`, `> X` (ends included), `X..Y`, or a bare `X` (at most). Times `400ms` or `0.4s`; percents `5%` or `0.05`; velocity `3000/s`; frames whole numbers.

Rules that make checks reliable:

- Leave the app as you found it. A flow that leaves a sheet open finds it open next run, and the check fails with "did not move".
- Leading `open` steps (and the waits for an element right after them) run before the recording, because opening may reload the app.
- Write a slowed check (`speed: 0.25`) with its 1x waits, holds and settle: ci runs them on the app's clock, 1 / speed as long.
- When two components have a value of the same name, write `Component.name` (ci warns about a bare name it measured in both).
- Give limits headroom over a debug simulator's numbers; CI machines are noisier than laptops.
- Never loosen a limit to make a real regression pass. Say so instead.

## 4. Validate, then record the baseline

```sh
npx keyframer-inspect ci --scenarios "sheet opens" --update-baseline
```

A file error stops `ci` with exit 2 and the line (`sheet.yml:6: "overshot" is not a key of an expectation (did you mean overshoot?)`). Fix it and run again. A value that did not move fails the check even here.

Then compare once locally, and commit both:

```sh
npx keyframer-inspect ci
git add .keyframer/checks .keyframer/baseline.json
```

Record the baseline on the same kind of machine CI uses. `--update-baseline` keeps entries of scenarios it did not run and hand-written `assertions`.

## 5. GitHub Actions

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
          xcrun simctl spawn "$UDID" defaults write com.apple.launchservices.schemeapproval \
            "com.apple.CoreSimulator.CoreSimulatorBridge-->exp" -string host.exp.Exponent
      - name: Start the app
        run: CI=1 npx expo start --ios --port 8081 > metro.log 2>&1 &
      - name: Check motion
        run: npx keyframer-inspect ci --metro http://localhost:8081 --format github --out inspector.txt
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: inspector
          path: |
            inspector.txt
            metro.log
```

`--format github` adds `::error` annotations at each new problem's line and a job summary. Other formats: `text`, `json`, `junit`.

## 6. EAS

What is documented: build the instrumented app with EAS Build from a profile that sets `KEYFRAMER_INSPECTOR=1` (with a `babel.config.js` that keeps the plugin when it is `1`), install it on the CI simulator (`xcrun simctl install booted <App.app>`, then `xcrun simctl openurl`), and run `ci` against it as above. Running `ci` inside EAS Workflows or against cloud simulators is not part of this release: do not invent a workflow for it.

## Several devices

`targets:` in a check runs it on several simulators and emulators side by side, one driver each:

```yaml
targets:
  - { driver: agent-device, device: "iPhone 16 Pro", app: host.exp.Exponent }
  - { driver: agent-device, device: Pixel_9_API_35, app: "exp://127.0.0.1:8081/--/sheet" }
```

```sh
npx keyframer-inspect ci --relay ws://127.0.0.1:8790 --launch exp://127.0.0.1:8081/--/sheet --update-baseline
```

Drivers: `agent-device` (steps, `.ad`, Maestro YAML), `maestro` (Maestro flows), `argent` (steps, Argent flows). React Native apps must connect to the relay for this.

## Read a failing run

- Exit 1: a regression. The report says, per scenario or check, what is new, what moved, and each missed limit: `sheetY settle time 410 ms (at most 400 ms, baseline 380 ms)`. Fix the code (use `keyframer-inspector-fix`), or, when the change was intended, record the baseline again and say so in the pull request.
- Exit 2: setup. No app connected (start it before `ci`; `--timeout` waits 120 s), no baseline, an unknown scenario, or a bad check file.
- `failed` with "the flow failed": the driver could not run a step. Motion was not measured. Fix the flow.
- Debug builds: the report says the frame numbers are inflated; the frame slack is doubled.
- `KEYFRAMER_DEBUG=1` prints what each run did and when.
