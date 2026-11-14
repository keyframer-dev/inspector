---
title: Pricing and sampling
description: One plan priced by your app's sessions a month, never billed over the allowance, and how much of them Motion Vitals records.
order: 11
section: Motion Vitals
---

# Pricing and sampling

One plan, with every feature on every step. Only the number of sessions a month differs: your app's sessions, all of them, not only the ones Motion Vitals records.

| Your app's sessions a month | Recorded, at most | Monthly | Yearly |
|---|---|---|---|
| 10,000 | 1,000 | Free | Free |
| 1,000,000 | 100,000 | $29 | $290 |
| 5,000,000 | 250,000 | $79 | $790 |
| 20,000,000 | 500,000 | $199 | $1,990 |
| 50,000,000 | 1,000,000 | $399 | $3,990 |
| More | | Chat with us | |

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
| A year of 500,000 extra sessions | 500,000 more of your app's sessions a month on top of your plan (and 50,000 more recorded), free or paid, for 12 months from the day you joined. After 12 months the step you are on applies again. |
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

A **session** is one foreground period of your app: it ends after 30 seconds in the background. A long session sends a report every 10 minutes and still counts once.

Steps count your app's sessions, all of them. Motion Vitals records a sample: each project records at its own rate (10% by default), and each recorded session stands for one over its rate, so at 10% one recorded session counts as 10 of your app's. Sessions that are not sampled send nothing. The Usage page shows both numbers: your app's sessions against the step, and the sessions recorded against what the step records.

Development reports count too, when a project accepts them.

## Never billed over

There is no overage and no surprise invoice. Each step records at most a set number of sessions a month (the table above), and rates are set so a month records about that many:

| State | When | What happens |
|---|---|---|
| Open | The month fits the step | Each project records at its own rate (10% by default) |
| Paced | Recording at that rate would pass what the step records | Rates go down to `base rate x recordings left / sessions it would record at the base rate` |
| Past the step | Your app's sessions are on course to pass the step | The step records fewer: what it records shrinks in proportion to how far past you are, to no less than a tenth |
| Recorded | The month has recorded what it may | Devices record nothing until the month resets or you move up a step; reports still in flight are not kept |

The numbers stay comparable at any rate: every recorded session is weighted by one over its sample rate, so a rate change never skews a chart. The dashboard says when your apps are past the step, with the reset date and the next step.

The owner gets an email at 80% and at 100% of the step's sessions, once each a month. Moving up a step takes effect at once: devices get the new rate in the answer to their next upload, or within a day.

## The allowance month

- Free resets on the 1st of each calendar month (UTC).
- A paid step resets monthly from the subscription's start, on yearly plans too: a yearly plan bought on 3 March resets on the 3rd of every month. Unused sessions do not roll over.

## Release boost

For the first 72 hours after a new app version shows up, the project's rate may be raised up to four times, within what the step records, so a regression shows up while the release is still rolling out. The boost never takes a workspace past what its step records.

## Changing steps

| Change | When it takes effect |
|---|---|
| Up a step, or monthly to yearly | At once, charged pro rata for the rest of the period |
| Down a step, or yearly to monthly | At the end of the period you paid for |
| Cancel | At the end of the period; you can undo it until then. Then the workspace is on Free, with its data kept |
| A failed renewal | 7 days of grace on the same step, then Free's allowance until it is paid |

Data is never deleted because of billing: a workspace on Free keeps its 90 days of history.

## Test runs

Unattended test runs (recordings uploaded from CI with a `kft_` key) are planned. When they ship, each test segment of up to 10 minutes counts as 10 sessions, from the same allowance, and as 10 recorded. They are never sampled: once the month has recorded what its step records, an upload is refused and `keyframer-inspect ci --runs` fails with a message naming the allowance, the reset date and the billing page.

## Billing and invoices

The workspace owner chooses the step and pays; payment methods and invoices are in Polar's customer portal, opened from the workspace's Billing page. A Motion Vitals subscription is separate from a Keyframer editor plan: you can have both on one account.
