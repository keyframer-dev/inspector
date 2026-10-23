---
title: Pricing and sampling
description: One plan priced by sessions a month, never billed over the allowance, and how sampling keeps you inside it.
order: 11
section: Motion Vitals
---

# Pricing and sampling

One plan, with every feature on every step. Only the number of sessions a month differs.

| Reported sessions a month | Monthly | Yearly |
|---|---|---|
| 1,000 | Free | Free |
| 50,000 | $5 | $50 |
| 200,000 | $15 | $150 |
| 500,000 | $29 | $290 |
| 1,000,000 | $49 | $490 |
| 3,000,000 | $119 | $1,190 |
| More | Chat with us | |

- Yearly is ten times monthly: two months free.
- Prices exclude VAT and sales tax. Polar, the merchant of record, adds them at checkout where they apply and sends the invoices.
- No trials: the free step is the trial, with every feature.
- Every step, Free included: a personal or team workspace, up to 100 members with roles, unlimited projects, 90 days of detailed history, every alert and channel, symbol uploads, and the CI and MCP tools.
- The debugger, Keyframer Inspector, stays free, and every SDK is MIT.

## Founding 100

The first 100 workspaces to send a real session become founding members, numbered 1 to 100 in the order their first session arrived. A number is given once and is never reused.

Who qualifies:

- A field session from your app counts: the same sessions the Usage page counts. Test runs uploaded from CI with a `kft_` key do not.
- The first session has to arrive within 30 days of creating the workspace.
- One founding workspace per person: if you already own one, another workspace of yours does not qualify.
- The workspace gets its number within about 5 minutes of the first session, when usage is counted, and its owner gets an email.

What founding members get:

| Perk | What it is |
|---|---|
| A year of 50,000 extra sessions | 50,000 more sessions a month on top of your plan, free or paid, for 12 months from the day you joined. After 12 months the step you are on applies again. |
| The price lock | Your price stays at today's launch price while you stay subscribed. |
| The badge | Founding member #N next to the workspace in the dashboard, for everyone in it. |
| The founders wall | A place at [keyframer.dev/vitals/founders](https://keyframer.dev/vitals/founders). Off until an owner or admin turns it on in Settings, then it shows a display name, a link and a logo. Off, the wall shows only your number. |
| The founders Discord | Private channels with the other founding teams and the people building Motion Vitals. Join with the invite in the workspace's Settings (under Founding), then type `/claim`. |

The public pages show how many places are left.

### Getting into the founders channels

1. Join the Keyframer.dev Discord with the invite in Settings, under Founding.
2. Type `/claim` in the server. Discord shows you, and only you, a link that works for 15 minutes.
3. Open it, sign in to Keyframer if you need to, check that the Discord account it names is yours, and press Link and unlock.

You get the Founding member role at once, and the founders channels open. The founders channels are for the whole team: anyone who is a member of a founding workspace can claim the role, whatever their role in the workspace. Each Keyframer account links one Discord account, and each Discord account one Keyframer account. To move a link, ask us in #welcome.

## What counts

A **reported session** is one session that sent at least one report. A session is one foreground period of the app, up to 10 minutes a window; a longer session sends several windows and still counts once.

Sessions that are not sampled send nothing and cost nothing. With the default sample rate of 10%, 1,000,000 sessions of your app are about 100,000 reported sessions.

Development reports count too, when a project accepts them.

## Never billed over

There is no overage and no surprise invoice. When the workspace is on course to pass its allowance, Motion Vitals samples less instead:

| State | When | What happens |
|---|---|---|
| Open | Projected use fits the allowance | Each project reports at its own rate (10% by default) |
| Sampling | Projected use is over the allowance | Rates go down to `base rate x allowance left / sessions projected`, never below a floor of a tenth of the base rate (and at least 0.5%) |
| Allowance used | The allowance is reached | Projects report at the floor rate until the month resets |

The numbers stay comparable while sampling is on: every report is weighted by one over its sample rate, so a rate change never skews a chart. The dashboard says when sampling is on, with the rate, the reset date and the next step.

The owner gets an email at 80% and at 100% of the allowance, once each a month. Moving up a step lifts sampling at once: devices get the new rate in the answer to their next upload.

## The allowance month

- Free resets on the 1st of each calendar month (UTC).
- A paid step resets monthly from the subscription's start, on yearly plans too: a yearly plan bought on 3 March resets on the 3rd of every month. Unused sessions do not roll over.

## Release boost

For the first 72 hours after a new app version shows up, the project's rate may be tripled, within the allowance, so a regression shows up while the release is still rolling out. The boost never takes a workspace over its allowance.

## Changing steps

| Change | When it takes effect |
|---|---|
| Up a step, or monthly to yearly | At once, charged pro rata for the rest of the period |
| Down a step, or yearly to monthly | At the end of the period you paid for |
| Cancel | At the end of the period; you can undo it until then. Then the workspace is on Free, with its data kept |
| A failed renewal | 7 days of grace on the same step, then Free's allowance until it is paid |

Data is never deleted because of billing: a workspace on Free keeps its 90 days of history.

## Test runs

Unattended test runs (recordings uploaded from CI with a `kft_` key) are planned. When they ship, each test segment of up to 10 minutes counts as 10 sessions, from the same allowance. They are never sampled: over the allowance, an upload is refused and `keyframer-inspect ci --runs` fails with a message naming the allowance, the reset date and the billing page.

## Billing and invoices

The workspace owner chooses the step and pays; payment methods and invoices are in Polar's customer portal, opened from the workspace's Billing page. A Motion Vitals subscription is separate from a Keyframer editor plan: you can have both on one account.
