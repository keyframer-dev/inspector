//! Motion Vitals symbols: turns symbol files into the chunked format of
//! `inspector/protocol/vitals.ts` (`VitalsSymbolManifest` plus `VitalsSymbolChunk`,
//! `VitalsR8Chunk` or `VitalsSitesChunk`), so the ingest Worker never parses DWARF: it reads one small
//! chunk per lookup.
//!
//! - `macho`: a dSYM's DWARF file (`Contents/Resources/DWARF/<binary>`), thin or fat (one manifest
//!   per architecture, keyed by that architecture's LC_UUID). Offsets from the `__TEXT` vmaddr.
//! - `elf`: an ELF with DWARF (Flutter `--split-debug-info` output, Android `.so` files). The GNU
//!   build id is the debug id; offsets from the first PT_LOAD.
//! - `r8`: an R8 / ProGuard `mapping.txt`, sharded by obfuscated class name.
//! - `rn-sites`: the React Native Babel plugin's `.keyframer/sites-<version>+<build>.json`.
//!
//! Output is deterministic: the same input and options give the same bytes (golden tests in
//! `inspector/packages/protocol/fixtures/vitals/symbols/`).

mod chunk;
mod demangle;
mod json;
mod native;
mod r8;
mod sites;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub use demangle::{demangle, is_swift_mangled};
pub use native::{inspect, swift_names, ObjectInfo};

/// The most a chunk's JSON may weigh before it is gzipped. JSON of numbers and identifiers
/// compresses at least two to one, so a chunk stays under about 256 KB gzipped (the CLI checks).
pub const CHUNK_BUDGET: usize = 512 * 1024;

pub type Result<T> = std::result::Result<T, String>;

/// What every build takes besides the input.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Options {
    /// ISO time written into the manifest (callers pass a fixed one for golden tests).
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub cli: Cli,
    #[serde(default)]
    pub app: Option<App>,
    /// Overrides the debug id the input implies.
    #[serde(default)]
    pub debug_id: Option<String>,
    /// Overrides the name written into the manifest.
    #[serde(default)]
    pub name: Option<String>,
    /// Swift names demangled outside (by `swift-demangle`): mangled to demangled.
    #[serde(default)]
    pub swift_names: BTreeMap<String, String>,
    /// Chunk budget in bytes of JSON; 0 means CHUNK_BUDGET. Tests lower it to exercise sharding.
    #[serde(default)]
    pub chunk_budget: usize,
}

impl Options {
    fn budget(&self) -> usize {
        if self.chunk_budget == 0 {
            CHUNK_BUDGET
        } else {
            self.chunk_budget
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Cli {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
pub struct App {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub build: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChunkRef {
    pub file: String,
    pub first: String,
}

/// `VitalsSymbolManifest`, fields in the contract's order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: &'static str,
    pub version: u32,
    pub kind: &'static str,
    pub debug_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<App>,
    /// Name schemes left mangled in the chunks (`swift` when swift-demangle was not available).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub mangled: Vec<String>,
    pub chunks: Vec<ChunkRef>,
    pub created_at: String,
    pub cli: Cli,
}

/// A built symbol set: the manifest and its chunks (file name, JSON), in upload order.
#[derive(Debug, Clone)]
pub struct Built {
    pub manifest: Manifest,
    pub chunks: Vec<(String, String)>,
    /// What was skipped while reading the input (damaged or dead-stripped debug info).
    pub warnings: Vec<String>,
}

impl Built {
    pub fn manifest_json(&self) -> String {
        serde_json::to_string(&self.manifest).expect("manifest serializes")
    }
}

/// The chunk file name for chunk `i`.
pub(crate) fn chunk_file(i: usize) -> String {
    format!("{i:04}.json")
}

pub(crate) fn manifest(kind: &'static str, debug_id: String, opts: &Options, chunks: Vec<ChunkRef>) -> Manifest {
    Manifest {
        format: "keyframer-vitals-symbols",
        version: 1,
        kind,
        debug_id: opts.debug_id.clone().unwrap_or(debug_id).to_lowercase(),
        name: opts.name.clone(),
        arch: None,
        app: opts.app.clone().filter(|a| a != &App::default()),
        mangled: Vec::new(),
        chunks,
        created_at: opts.created_at.clone(),
        cli: opts.cli.clone(),
    }
}

/// A Mach-O or ELF symbol set: object `index` of `inspect(bytes)` (the architecture of a fat file).
pub fn build_native(bytes: &[u8], index: usize, opts: &Options) -> Result<Built> {
    native::build(bytes, index, opts)
}

/// An R8 / ProGuard mapping.txt. The debug id is `opts.debug_id`, else `<app version>+<build>`.
pub fn build_r8(text: &str, opts: &Options) -> Result<Built> {
    r8::build(text, opts)
}

/// A React Native sites file (`keyframer-vitals-sites`). The debug id is `<app version>+<build>`.
pub fn build_sites(text: &str, opts: &Options) -> Result<Built> {
    sites::build(text, opts)
}

/// `<version>+<build>`, or the version alone when there is no build.
pub(crate) fn version_id(app: &Option<App>) -> Option<String> {
    let app = app.as_ref()?;
    let v = app.version.as_deref().filter(|v| !v.is_empty())?;
    Some(match app.build.as_deref().filter(|b| !b.is_empty()) {
        Some(b) => format!("{v}+{b}"),
        None => v.to_string(),
    })
}

/// Options from their JSON (the CLI's camelCase object).
pub fn options_from_json(json: &str) -> Result<Options> {
    serde_json::from_str(json).map_err(|e| format!("bad options: {e}"))
}

/// Any serializable value as compact JSON.
pub fn to_json<T: Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("serializes")
}
