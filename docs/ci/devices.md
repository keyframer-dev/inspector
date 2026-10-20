---
title: Several devices
description: Run one check on several simulators and emulators side by side with targets.
order: 4
section: CI
---

# Several devices

`targets:` runs one check on several simulators and emulators in parallel, one driver per device, and reports each expectation per device.

## Add targets to a check

```yaml
name: sheet opens
flow:
  steps:
    - wait: { id: sheet-open-full }
      timeout: 15s
    - tap: sheet-open-full
    - wait: 900ms
    - tap: sheet-close
    - wait: 900ms
expect:
  - value: sheetY
    settle: < 600ms
targets:
  - { driver: agent-device, device: "iPhone 16 Pro", app: host.exp.Exponent }
  - { driver: argent, device: "iPhone 17" }
  - { driver: agent-device, device: Pixel_9_API_35, app: "exp://127.0.0.1:8081/--/sheet" }
```

## Run it

Targets need the desktop app's relay and `--launch`:

```sh
npx keyframer-inspect ci --relay ws://127.0.0.1:8790 --launch exp://127.0.0.1:8081/--/sheet --update-baseline
```

`--launch` takes an app URL, a bundle id or package, or `app` (each target's own `app`). Without `--launch`, a check with targets runs on the one device `ci` is pointed at.

## Target keys

| Key | Required | |
|---|---|---|
| `driver` | Yes | `agent-device`, `maestro` or `argent` |
| `device` | Yes | A simulator's name or UDID, an AVD's name (or the name Android Studio shows), or a running emulator's serial |
| `platform` | No | `ios` or `android`, when the name does not say |
| `app` | No | A bundle id, a package, or a URL, opened before steps that do not open anything themselves |

## Drivers

| Driver | Runs |
|---|---|
| `agent-device` | `steps`, `.ad` scripts and Maestro YAML |
| `maestro` | Maestro flows |
| `argent` | `steps` and Argent flows, through Argent's MCP server, with no model |

A target whose driver cannot run the check's flow is an error in the file.

> Argent as a CI driver is unit tested but has not been run end to end yet.

## Devices

- A device that is not running is booted.
- A simulator another target has is cloned.
- Only what was started is shut down after, and a clone deleted.

## Which app is which

Every target's app joins the one relay. React Native apps point `connectInspector` at it, and on an emulator `adb reverse` maps Metro's and the relay's ports. `ci` opens `--launch` on one device at a time, and the app that joins the relay next is that device's.

An app already open joins nothing new. It is then matched by its platform and OS version, which must tell the targets apart (an iPhone 16 Pro and an iPhone 17 on one runtime do not), or by `device` in its hello (the simulator's UDID, the emulator's AVD). Close the app on each device before the run for the reliable way.

## Reports

Each target is reported as `ci` reports one device, in every format, under names with the target: `sheet opens (iPhone 16 Pro, agent-device)`. Those are also its baseline keys, since devices do not lose the same frames. Each is measured on its own app's clock and display rate.

Then a side-by-side table: each expectation's value per target, and the targets that miss it. It is in the text report and the GitHub summary, as `sideBySide` in JSON, and as one JUnit test suite per target.
