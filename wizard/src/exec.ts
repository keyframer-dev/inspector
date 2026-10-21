/**
 * Running a command (hdiutil, codesign, spctl, ditto, open), injectable so tests fake every one and
 * nothing real runs. A command that cannot start answers code 127 with the reason in stderr, never
 * throws.
 */
import { spawn } from 'node:child_process'

export type RunResult = { code: number; stdout: string; stderr: string }

export type Run = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<RunResult>

export const run: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: (e as Error).message })
      return
    }
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr || e.message }))
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
