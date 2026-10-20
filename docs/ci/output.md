---
title: Output formats
description: The text, JSON, GitHub and JUnit reports that keyframer-inspect ci writes.
order: 5
section: CI
---

# Output formats

```sh
npx keyframer-inspect ci --format github --out inspector.txt
```

`--format` picks one of four formats; `--out <file>` writes the report there instead of stdout.

| Format | For | Motion limits |
|---|---|---|
| `text` (default) | People reading a log | Lines in the report, `! Motion: ...` when one fails |
| `json` | Scripts | `motion` on each scenario, and `unchecked`: assertions without a scenario that moved in none |
| `github` | GitHub Actions | `::error` annotations at each new problem's line, at the call site or value line for a failed limit, and a job summary with a Motion column |
| `junit` | Test report viewers | Lines in the report, `! Motion: ...` when one fails |

## What every format reports

Per scenario and check:

- what was fixed, what is still there and what is new, compared with the baseline;
- how frames lost and the longest frame moved;
- the motion limits, met or missed, with what was measured;
- whether the build was a debug build (its frame numbers are inflated) and the display rate when it is not 60 Hz.

With [targets](devices.md), each target is reported under its own name, then a side-by-side table: in the text report and the GitHub summary, as `sideBySide` in JSON, and as one JUnit test suite per target.

## Use the exit code

The exit code is the verdict: 0 no regression, 1 a regression or a failed scenario, 2 a setup error. Keep the report as an artifact even when the job fails:

```yaml
- name: Check the scenarios
  run: npx keyframer-inspect ci --format junit --out inspector.xml
- if: always()
  uses: actions/upload-artifact@v4
  with: { name: inspector, path: inspector.xml }
```
