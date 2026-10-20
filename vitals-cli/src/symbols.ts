/**
 * The symbols crate (inspector/symbols) as WebAssembly: turns symbol files into a manifest and chunks
 * (`VitalsSymbolManifest` and its chunks in @keyframerdev/inspector-protocol/vitals). Loaded
 * synchronously from the bytes bundled in symbolsWasm/bytes.ts, so the CLI needs no native module.
 */
import type { VitalsSymbolKind, VitalsSymbolManifest } from '../../protocol/vitals'
import WASM_BASE64 from './symbolsWasm/bytes'
import { buildNative as wasmBuildNative, buildR8 as wasmBuildR8, buildSites as wasmBuildSites, inspect as wasmInspect, initSync, swiftNames as wasmSwiftNames, type Built as WasmBuilt } from './symbolsWasm/glue.js'

let ready = false
function load() {
  if (ready) return
  initSync({ module: Buffer.from(WASM_BASE64, 'base64') })
  ready = true
}

/** One object in a symbol file: a fat Mach-O has one per architecture. */
export type SymbolObject = { index: number; kind: 'macho' | 'elf'; debugId: string; arch?: string; hasDwarf: boolean }

export type BuildOptions = {
  createdAt: string
  cli: { name: string; version: string }
  app?: { id?: string; version?: string; build?: string }
  debugId?: string
  name?: string
  /** Swift names demangled by swift-demangle: mangled to demangled. */
  swiftNames?: Record<string, string>
  /** Bytes of JSON per chunk; 0 or absent: the crate's default (512 KiB). */
  chunkBudget?: number
}

/** A built symbol set: what is uploaded, chunks first and the manifest last. */
export type SymbolSet = {
  kind: VitalsSymbolKind
  debugId: string
  manifest: VitalsSymbolManifest
  manifestJson: string
  chunks: Array<{ file: string; json: string }>
  /** What was skipped while reading the input (damaged or dead-stripped debug info). */
  warnings: string[]
}

function take(b: WasmBuilt): SymbolSet {
  try {
    const manifestJson = b.manifest()
    const manifest = JSON.parse(manifestJson) as VitalsSymbolManifest
    const chunks = []
    for (let i = 0; i < b.chunkCount(); i++) chunks.push({ file: b.chunkFile(i), json: b.chunkJson(i) })
    const warnings = JSON.parse(b.warnings()) as string[]
    return { kind: manifest.kind, debugId: manifest.debugId, manifest, manifestJson, chunks, warnings }
  } finally {
    b.free()
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function inspectObjects(bytes: Uint8Array): SymbolObject[] {
  load()
  try {
    return JSON.parse(wasmInspect(bytes)) as SymbolObject[]
  } catch (e) {
    throw new Error(errorText(e))
  }
}

export function swiftNames(bytes: Uint8Array, index: number): string[] {
  load()
  return JSON.parse(wasmSwiftNames(bytes, index)) as string[]
}

export function buildNative(bytes: Uint8Array, index: number, opts: BuildOptions): SymbolSet {
  load()
  try {
    return take(wasmBuildNative(bytes, index, JSON.stringify(opts)))
  } catch (e) {
    throw new Error(errorText(e))
  }
}

export function buildR8(text: string, opts: BuildOptions): SymbolSet {
  load()
  try {
    return take(wasmBuildR8(text, JSON.stringify(opts)))
  } catch (e) {
    throw new Error(errorText(e))
  }
}

export function buildSites(text: string, opts: BuildOptions): SymbolSet {
  load()
  try {
    return take(wasmBuildSites(text, JSON.stringify(opts)))
  } catch (e) {
    throw new Error(errorText(e))
  }
}
