/**
 * What the wizard knows about the project it sets up, what it was asked to do, and what each step
 * hands the next. Shared by every step: detection and the code changes (cli.ts, detect.ts, codemods/)
 * on one side, the account, the Vitals key, the desktop app, the agents and the checks that it works
 * (account.ts, vitalsKey.ts, desktop.ts, agents.ts, verify.ts) on the other.
 */

export type Product = 'inspector' | 'vitals'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

/** How screens are named: from expo-router's or React Navigation's container ref, or by hand. */
export type Navigation = 'expo-router' | 'react-navigation' | null

/**
 * Where the developer looks at the Inspector: Expo's dev tools (shift+m in Metro, no account), the
 * desktop app (its relay on 8790), or the Keyframer editor's Inspector panel (a room code).
 */
export type InspectorView = 'devtools' | 'desktop' | 'editor'

/** How the Vitals key is found: pasted from the dashboard, or by signing in through the browser. */
export type VitalsAuth = 'paste' | 'browser'

/** The coding agents whose project-scoped MCP config the wizard writes. */
export type AgentTool = 'claude-code' | 'cursor'

export type Project = {
  /** The app's folder (where its package.json is). */
  root: string
  /** package.json's name, or app.json's expo.name. */
  name: string
  pm: PackageManager
  /** An Expo app, and its SDK when the installed expo says. */
  expo: { sdk: number | null } | null
  /** The react-native version in package.json, as written. */
  reactNative: string | null
  navigation: Navigation
  /** dependencies and devDependencies, name to version range. */
  deps: Record<string, string>
  /** babel.config.js (or .cjs, .mjs, .json, .babelrc), absolute; null when there is none. */
  babelConfig: string | null
  /** Where the start code is imported: app/_layout.tsx, App.tsx, index.js. Null when it can't be told. */
  entry: string | null
  /** The workspace root above the app in a monorepo, else null. */
  monorepoRoot: string | null
  /** Whether git sees uncommitted changes; null outside a repository. */
  git: { clean: boolean } | null
  /** A TypeScript app (a tsconfig.json, or typescript in its dependencies): the wizard's file is .ts, else .js. */
  typescript?: boolean
}

export type WizardOptions = {
  root: string
  /** null: ask. */
  products: Product[] | null
  /** Non-interactive: defaults where there are some, and an error naming the flag where there aren't. */
  yes: boolean
  inspectorView: InspectorView | null
  /** --key kfp_live_… */
  vitalsKey: string | null
  vitalsAuth: VitalsAuth | null
  /** https://api.keyframer.dev, or KEYFRAMER_API_URL. */
  api: string
  /** https://keyframer.dev, or KEYFRAMER_APP_URL. */
  app: string
  skipInstall: boolean
  skipVerify: boolean
  /** Show every change, write nothing, install nothing. */
  dryRun: boolean
  /** Offer the agent integrations (Claude Code, Cursor); null: ask. */
  agents: boolean | null
  /**
   * Which agents to set up (--agents claude-code,cursor). Absent or null: asked, with none picked under
   * --yes unless `agents` is true (then both).
   */
  agentTools?: AgentTool[] | null
  /**
   * Download and install the desktop app when it's missing, without asking (--install-desktop).
   * Unattended runs never install it otherwise: a person says yes to that.
   */
  installDesktop?: boolean
  /** The Motion Vitals ingest origin: https://vitals.keyframer.dev, or KEYFRAMER_VITALS_URL. */
  vitalsEndpoint?: string
  /** --code ABC234: the pairing code the Keyframer editor's Inspector panel shows, for the editor view. */
  inspectorCode?: string | null
  /** --vitals-root / --no-vitals-root: wrap the app in VitalsRoot; null: ask. */
  vitalsRoot?: boolean | null
}

/** A Vitals ingest key, and where it came from when the wizard signed in for it. */
export type VitalsKey = {
  key: string
  projectId: string | null
  workspaceId: string | null
  /** The session token from the browser sign-in, for checking that the first session arrived. */
  token: string | null
}

export type VerifyResult =
  | { ok: true; detail: string }
  | { ok: false; reason: 'timeout' | 'skipped' | 'error'; detail: string }
