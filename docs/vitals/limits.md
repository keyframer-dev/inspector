---
title: Retention and limits
description: How long Motion Vitals keeps data, how deletion works, and the limits on reports, keys and devices.
order: 12
section: Motion Vitals
---

# Retention and limits

## Retention

| Data | Kept |
|---|---|
| Daily aggregates (what every dashboard page reads) | 90 days, on every step |
| Monthly rollups (long trends) | 13 months |
| Raw reports, as received | 30 days, to recompute aggregates and for worst-frame details |
| Analytics data points (production only, kept for future heavy queries) | 3 months, fixed by Cloudflare |
| Problems, their status and history | While the project exists |
| Symbols | While the project exists |
| Hourly session counts | Kept for usage history and support |
| Alert deliveries (the last result per integration, sends for the noise limits) | Rolling, for the noise limits |

Nothing in this data identifies a person using your app, so there is nothing to delete per person.

## Deleting data

- **Purge a project** (owners and admins): keeps the project and its keys, deletes its data. Aggregates, problems and symbols go at once, raw reports within a day. Analytics data points cannot be deleted one by one and age out within 3 months; they hold nothing personal.
- **Delete a project**: revokes its keys, tells devices to stop, and purges it.
- **Delete a workspace** (the owner): purges every project and cancels the subscription at the end of the period.
- **Delete your Keyframer account**: refused while you own a team workspace with other members (transfer it first); otherwise your personal workspace is purged with it.

## On the device

| Limit | Value |
|---|---|
| Sampling | Decided once per session, at its start |
| Reported sessions per device | At most 3 a day, counted on the device, never sent (React Native development builds have no cap) |
| Session window | Up to 10 minutes of foreground time; a session ends after 30 s in the background |
| Checkpoint | The open window is saved every 60 s, so a session that ends in a freeze is sent on the next launch |
| Retry store | At most 5 reports, 100 KB and 7 days; retried on the next launch, only in the foreground |
| Config | Fetched at most once a day, and from every upload's answer |
| Turned off | A revoked key, a deleted project or a stop from the server turns the SDK off on that device for 7 days |

## Per report

Ingest refuses a report over any of these (413 for size, 400 otherwise):

| Field | Limit |
|---|---|
| Size | 32 KB uncompressed |
| Screens | 40 |
| Animation sites | 200 |
| Worst frames | 10 (SDKs send 5) |
| Binary images | 64 |
| Screen name | 64 characters |

Ingest is rate limited per key; a device that is told to wait (429) keeps the report and retries later.

## Per project and workspace

| Limit | Value |
|---|---|
| Members and pending invitations | 100 per workspace |
| Projects | Unlimited |
| Field keys (`kfp_`) | 5 live per project, so a new key can roll out while the old one is in shipped apps |
| Upload keys (`kft_`) | 10 live per project |
| Workspace read keys (`kfw_`) | 10 per workspace |
| Screens and sites shown per day | The top 500 screens and 2,000 sites; the rest fold into "(other)" |
| Device models | Shown only above 50 sessions |

## Who can do what

| | Owner | Admin | Member | Viewer |
|---|---|---|---|---|
| See every project's data and usage | yes | yes | yes | yes |
| Create projects, create upload keys, edit problems and rules | yes | yes | yes | |
| Field and workspace keys, project switches, purge or delete a project, integrations | yes | yes | | |
| Invite and remove people, change roles | yes | yes | | |
| Make or remove admins | yes | | | |
| Step, billing, invoices, the Data Processing Agreement, delete or transfer the workspace | yes | | | |

Members cannot create field keys because those ship in production apps and use the allowance.
