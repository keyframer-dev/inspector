---
title: Agent skills
description: Install the five Keyframer skills in Claude Code, Cursor or Codex.
order: 4
section: Coding agents
---

# Agent skills

The npm package ships five agent skills: folders with a `SKILL.md` file in the Agent Skills format. An agent loads one when its description matches the task, and follows its steps.

| Skill | Use it to |
|---|---|
| `keyframer-inspector-setup` | Install and connect the inspector on any platform, and check that it works |
| `keyframer-inspector-motion` | Debug an animation: reproduce with a simulator agent, record, read, fix, compare |
| `keyframer-inspector-fix` | Fix a reported problem: find the call site, apply the fix for the framework, verify with compare |
| `keyframer-inspector-ci` | Write check files and baselines, and run them in GitHub Actions |
| `keyframer-vitals` | Set up [Motion Vitals](../vitals/index.md) in an app, upload symbols, and fix problems found in production |

They live in the package at `node_modules/@keyframerdev/inspector/skills/`. They need the [MCP server](mcp-server.md) connected to do anything beyond setup.

## Claude Code

Copy them into the project's `.claude/skills/` (or `~/.claude/skills/` for every project):

```sh
npm i -D @keyframerdev/inspector
mkdir -p .claude/skills
cp -R node_modules/@keyframerdev/inspector/skills/* .claude/skills/
```

Claude Code picks them up in the next session. Ask "why does the sheet stutter?" and it loads `keyframer-inspector-motion`.

## Cursor

Cursor loads skills from `.cursor/skills/` or `.agents/skills/` in the project, and `~/.cursor/skills/` or `~/.agents/skills/` for every project:

```sh
mkdir -p .cursor/skills
cp -R node_modules/@keyframerdev/inspector/skills/* .cursor/skills/
```

Type `/` in Agent chat to run one by name.

## Codex

Codex loads skills from `.agents/skills/` in any folder from the current one up to the repository root, and `~/.agents/skills/` for every project:

```sh
mkdir -p .agents/skills
cp -R node_modules/@keyframerdev/inspector/skills/* .agents/skills/
```

Restart Codex if a skill does not appear.

## Keep them current

The skills change with the package. Copy them again after you update `@keyframerdev/inspector`, so the tool names and flags they cite match the version you run.

```sh
npm i -D @keyframerdev/inspector@latest
cp -R node_modules/@keyframerdev/inspector/skills/* .claude/skills/
```

## Commit them or not

Committing the copied folders gives everyone on the team, and agents in CI, the same skills. Not committing them keeps the repository smaller; each person copies them once.
