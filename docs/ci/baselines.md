---
title: Baselines
description: What the baseline file keeps, how problems are matched, and how to add motion assertions by hand.
order: 2
section: CI
---

# Baselines

The baseline is `.keyframer/baseline.json`, committed next to the code. `--baseline <file>` uses another one.

## Record it

```sh
npx keyframer-inspect ci --update-baseline
git add .keyframer/baseline.json
```

`--update-baseline` records instead of comparing. Scenarios and checks not run keep their entries. It measures motion limits but does not fail on them.

## What it keeps

Per scenario or check:

- the frames lost on each of the app's threads;
- the longest frame;
- the problems, by id and severity;
- the measured motion for each assertion.

## How a comparison reads it

- Problems are matched by id, then by id without line numbers, so code moving above a problem does not make it new.
- A new problem that lost no more frames than the slack (a screen opening that drops a frame one run and not the next) is listed but not counted, unless it is high severity.
- A scenario with no baseline entry is still checked against its motion limits.

## Motion assertions in the baseline

Hold how things move to fixed limits by writing `assertions` into the baseline by hand, next to `scenarios`. Recording the baseline again keeps them. [Check files](check-files.md) are the easier way to write the same limits.

```json
{
  "version": 1,
  "assertions": [
    { "value": "sheetY", "scenario": "sheet: open", "settleMs": { "max": 400 }, "overshoot": { "max": 0.05 } },
    { "site": "app/sheet.tsx:33", "durationMs": { "min": 200, "max": 600 } }
  ],
  "scenarios": {}
}
```

| Field | |
|---|---|
| `value` | A value's name (the `useSharedValue` variable, the name an SDK gives it) or its id: every motion it makes |
| `site` | An animation's call site, `file:line` or its whole id: what the value it animates does, each time it runs |
| `scenario` | A scenario's name, or a list: only there, and it must move there. Without it: every scenario where it moves |
| `settleMs`, `overshoot`, `durationMs`, `peakVelocity` | `{ "min": ..., "max": ... }`, either or both. Overshoot is a fraction of the travel (0.05 is 5% past the end), peak velocity in units per second |
| `settleTolerance` | How close to its end value counts as settled, a fraction of the travel (default 0.02) |
| `frames` | Limits on the run itself, with no value or site: `{ "dropped", "ui", "js", "longestMs" }`, each `{ min, max }` |
| `none` | Problem kinds the run must not have, with no value or site: `["reduce-motion", "unseen", "two-writers"]` |

## How motion is measured

- The metrics are the curve view's: settle time runs from the start of a motion until the value stays within the tolerance of its end value.
- Each run keeps the worst of the motions (the highest of a metric, or the lowest when an assertion only sets a minimum).
- Runs combine as their median, like the other numbers.
- Motion is measured on the app's clock, so a run slowed by the editor measures the same.
- The report names what was measured: `sheetY settle time 410 ms (at most 400 ms, baseline 380 ms)`.

## When to record it again

- After an intended change to motion or performance.
- When moving CI to another kind of machine.
- A baseline recorded before reload and warm-up became the default (with `--no-reload --warmup 0`) should be recorded again.
