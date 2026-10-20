//! WebAssembly bindings for `keyframer-vitals-symbols`, loaded by `@keyframerdev/vitals-cli`
//! (`src/symbolsWasm/`, built by its `scripts/build-wasm.ts`). Bytes and text in; a `Built` out that
//! hands back the manifest and each chunk as JSON.

use keyframer_vitals_symbols as symbols;
use wasm_bindgen::prelude::*;

fn opts(json: &str) -> Result<symbols::Options, JsError> {
    symbols::options_from_json(json).map_err(|e| JsError::new(&e))
}

/// The objects in a Mach-O (thin or fat) or ELF file, as JSON:
/// `[{ index, kind, debugId, arch?, hasDwarf }]`.
#[wasm_bindgen]
pub fn inspect(bytes: &[u8]) -> Result<String, JsError> {
    symbols::inspect(bytes).map(|o| symbols::to_json(&o)).map_err(|e| JsError::new(&e))
}

/// The Swift mangled names object `index` uses, as a JSON array.
#[wasm_bindgen(js_name = swiftNames)]
pub fn swift_names(bytes: &[u8], index: usize) -> Result<String, JsError> {
    symbols::swift_names(bytes, index).map(|o| symbols::to_json(&o)).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = buildNative)]
pub fn build_native(bytes: &[u8], index: usize, options: &str) -> Result<Built, JsError> {
    symbols::build_native(bytes, index, &opts(options)?).map(Built).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = buildR8)]
pub fn build_r8(text: &str, options: &str) -> Result<Built, JsError> {
    symbols::build_r8(text, &opts(options)?).map(Built).map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = buildSites)]
pub fn build_sites(text: &str, options: &str) -> Result<Built, JsError> {
    symbols::build_sites(text, &opts(options)?).map(Built).map_err(|e| JsError::new(&e))
}

/// The crate's name and version, as JSON.
#[wasm_bindgen]
pub fn about() -> String {
    format!("{{\"name\":\"{}\",\"version\":\"{}\"}}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"))
}

/// A built symbol set.
#[wasm_bindgen]
pub struct Built(symbols::Built);

#[wasm_bindgen]
impl Built {
    /// The manifest, as JSON.
    pub fn manifest(&self) -> String {
        self.0.manifest_json()
    }
    /// What was skipped while reading the input, as a JSON array of strings.
    pub fn warnings(&self) -> String {
        symbols::to_json(&self.0.warnings)
    }
    #[wasm_bindgen(js_name = chunkCount)]
    pub fn chunk_count(&self) -> usize {
        self.0.chunks.len()
    }
    #[wasm_bindgen(js_name = chunkFile)]
    pub fn chunk_file(&self, i: usize) -> String {
        self.0.chunks.get(i).map(|c| c.0.clone()).unwrap_or_default()
    }
    #[wasm_bindgen(js_name = chunkJson)]
    pub fn chunk_json(&self, i: usize) -> String {
        self.0.chunks.get(i).map(|c| c.1.clone()).unwrap_or_default()
    }
}
