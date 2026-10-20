---
title: Alerts, Slack and webhooks
description: The weekly digest, alert rules, email, Slack and signed webhooks, with a signature check in Node.
order: 9
section: Motion Vitals
---

# Alerts, Slack and webhooks

Everything that sends a message is a rule in one list per workspace, under Alerts in the dashboard. Each email says which rule sent it and how to stop it.

## The rules

A new workspace starts with the defaults below; members can change them and add their own.

| Rule | Fires when | Default |
|---|---|---|
| Weekly digest | Mondays at 09:00 in each person's time zone: every project's hitch time and its change, problems that need attention, problems fixed, usage | On for owners and admins; others opt in |
| New problem in a release | A problem first seen in a new version passes 50 sessions | On, all members |
| A fixed problem came back | A problem marked Fixed is a problem again in a later version | On, all members |
| A release is slower | 72 hours after a release, its hitch time is 20% or more worse than the previous version's | On, owners and admins |
| Custom threshold | Hitch time, slow frames, frozen frames, janky sessions, or one animation's drop rate stays above a limit for 1 hour, 24 hours or 7 days, on a project, screen, platform or device tier | Made by members |
| Usage at 80% and 100% | The workspace reaches 80% and 100% of its monthly sessions | Always on for the owner |

Your time zone is taken from your browser when you open the dashboard, and can be changed in your email settings. Without one, the digest goes at 09:00 UTC.

## Noise limits

- A rule needs at least 50 sessions in its window before it fires.
- It fires at most once an hour, day or week (the rule's setting) for the same problem or screen.
- Every alert email has a link to mute that rule for 7 days.
- Ignored problems never alert and are left out of the digest.
- Every email has one-click unsubscribe, and the digest can be turned off in your email settings.

## Channels

Email always goes to the rule's recipients (all members, owners and admins, or chosen people), from Keyframer Motion Vitals <vitals@keyframer.dev>. Slack channels and webhooks are extra channels a rule can also send to. Owners and admins add them under Alerts, Integrations, and each has a Send test button.

### Slack

- **Add to Slack**: sign in to Slack, pick a channel, and the Keyframer app posts there, with Motion Vitals in each message's header.
- **Incoming webhook**: paste a Slack incoming webhook URL instead, when your Slack workspace does not allow new apps.

A Slack message names the project, the problem or number, the version and the devices it hurts most, with a link to the dashboard.

### Webhooks

A webhook receives a `POST` with a JSON body for every alert of the rules it is attached to:

```http
POST /hooks/keyframer HTTP/1.1
Content-Type: application/json
User-Agent: Keyframer-Vitals
Keyframer-Signature: t=1760774400,v1=5f0c…e9

{
  "id": "evt_01JAB…",
  "type": "problem.new",
  "sentAt": "2026-10-18T09:00:00.000Z",
  "workspace": { "id": "ws_…", "name": "Acme" },
  "project": { "id": "prj_…", "name": "Shop", "code": "SHOP" },
  "rule": { "id": "rule_…", "name": "New problem in a release" },
  "problem": {
    "id": "SHOP-12",
    "title": "withSpring on Feed",
    "status": "new",
    "since": "2.4.1",
    "dropPct": 9.1,
    "basePct": 2.3,
    "hurtsMost": { "os": "android", "tier": "low", "dropPct": 14.2 },
    "site": { "label": "app/feed.tsx:42:9", "fn": "withSpring", "component": "FeedCard", "screen": "Feed" }
  },
  "text": "New in 2.4.1: SHOP-12 withSpring on Feed drops 9.1% of frames while it runs (2.3% without it), most on low-tier Android.",
  "url": "https://keyframer.dev/app/vitals/…/problems/12"
}
```

| `type` | Sent by |
|---|---|
| `problem.new` | New problem in a release |
| `problem.came_back` | A fixed problem came back |
| `release.slower` | A release is slower |
| `threshold.crossed` | A custom threshold |
| `usage.threshold` | Usage at 80% and 100% |
| `test` | The Send test button |

`problem` is `null` for alerts that are not about one problem; `project` is `null` for usage alerts. `id` stays the same when a delivery is retried: if you see an `id` twice (a retry after a timeout), handle it once.

**Delivery.** Answer with any 2xx within 10 seconds. A timeout, a network error, a 408, a 429 or a 5xx is retried after 30 seconds, 2 minutes, 8 minutes, 32 minutes and then an hour (six attempts in all), or later if your `Retry-After` asks for it, up to an hour. Other answers, redirects included, are not retried. Each attempt is signed again, so a retry carries a fresh `t` and passes your replay window. The last delivery's result is shown on the integration.

### Check the signature

Each webhook has a signing secret, shown once when you create it. Every request carries:

```
Keyframer-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
```

Check it on the raw body, before parsing the JSON, and refuse old timestamps so a captured request cannot be replayed. In Node:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'
import express from 'express'

const TOLERANCE_S = 5 * 60

export function verify(secret, rawBody, header, nowSeconds = Math.floor(Date.now() / 1000)) {
  const parts = Object.fromEntries(
    String(header ?? '').split(',').map((p) => p.trim().split('=', 2)),
  )
  const t = Number(parts.t)
  if (!Number.isInteger(t) || !parts.v1) return false
  if (Math.abs(nowSeconds - t) > TOLERANCE_S) return false
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest()
  const given = Buffer.from(parts.v1, 'hex')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const app = express()
app.post('/hooks/keyframer', express.raw({ type: 'application/json' }), (req, res) => {
  const raw = req.body.toString('utf8')
  if (!verify(process.env.KEYFRAMER_WEBHOOK_SECRET, raw, req.get('Keyframer-Signature'))) return res.status(401).end()
  const event = JSON.parse(raw)
  // handle event.type, once per event.id
  res.status(204).end()
})
app.listen(3000)
```

Test your check with this vector before going live:

| | Value |
|---|---|
| Secret | `whsec_test_secret` |
| Raw body | `{"id":"evt_1","type":"test"}` |
| Header | `Keyframer-Signature: t=1792281600,v1=15fa7f377703dc17da1eea916fd57867c3cb829cf30364d2174f33c30b570574` |

```js
const header = 't=1792281600,v1=15fa7f377703dc17da1eea916fd57867c3cb829cf30364d2174f33c30b570574'
verify('whsec_test_secret', '{"id":"evt_1","type":"test"}', header, 1792281600)  // true
verify('whsec_test_secret', '{"id":"evt_1","type":"test"}', header, 1792281600 + 301)  // false: older than 5 minutes
```

The same check in any language: split the header on commas, HMAC-SHA256 the string `<t>.<raw body>` with the secret, compare the hex digest with `v1` in constant time, and refuse a `t` more than five minutes away from now.

To change a secret, add a second webhook to the same URL, move your check to the new secret, then delete the old webhook.

## What leaves Keyframer

Slack messages and webhooks carry what an alert says: project and problem names, versions, call site labels (file and line), screen names and numbers. Never anything about the people using your app, because Keyframer has nothing of that kind. Once delivered, they are under your Slack workspace's or your server's terms.
