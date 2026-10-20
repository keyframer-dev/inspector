//! React Native sites files (`.keyframer/sites-<version>+<build>.json`, written by the Babel plugin
//! with `hashSites`) into rn-sites chunks keyed by hash.

use crate::{chunk, json, App, Built, ChunkRef, Options, Result};
use serde_json::Value;

pub fn build(text: &str, opts: &Options) -> Result<Built> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("the sites file is not JSON: {e}"))?;
    if v.get("format").and_then(Value::as_str) != Some("keyframer-vitals-sites") {
        return Err("not a sites file: format is not keyframer-vitals-sites".into());
    }
    if v.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("unsupported sites file version (expected 1)".into());
    }
    let s = |k: &str| v.get("app").and_then(|a| a.get(k)).and_then(Value::as_str).map(str::to_string);
    let file_app = App { id: None, version: s("version"), build: s("build") };
    let mut opts = opts.clone();
    let mut app = opts.app.clone().unwrap_or_default();
    app.version = app.version.or(file_app.version);
    app.build = app.build.or(file_app.build);
    opts.app = Some(app);
    let debug_id = opts.debug_id.clone().or_else(|| crate::version_id(&opts.app)).ok_or("the sites file has no app version")?;
    let sites = v.get("sites").and_then(Value::as_object).ok_or("the sites file has no sites")?;
    let mut entries: Vec<(String, String)> = Vec::with_capacity(sites.len());
    for (hash, site) in sites {
        entries.push((hash.clone(), site_json(hash, site)?));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let chunks = chunk::keyed("sites", &entries, opts.budget());
    let refs = chunks.iter().enumerate().map(|(i, c)| ChunkRef { file: crate::chunk_file(i), first: c.0.clone() }).collect();
    let m = crate::manifest("rn-sites", debug_id, &opts, refs);
    Ok(Built { manifest: m, chunks: chunks.into_iter().enumerate().map(|(i, c)| (crate::chunk_file(i), c.1)).collect(), warnings: Vec::new() })
}

/// One site with the contract's keys in order: file, line, column?, fn, component?, prop?, key.
fn site_json(hash: &str, site: &Value) -> Result<String> {
    let bad = |what: &str| format!("site {hash}: {what}");
    let str_of = |k: &str| site.get(k).and_then(Value::as_str);
    let file = str_of("file").ok_or_else(|| bad("no file"))?;
    let line = site.get("line").and_then(Value::as_u64).ok_or_else(|| bad("no line"))?;
    let func = str_of("fn").ok_or_else(|| bad("no fn"))?;
    let key = str_of("key").ok_or_else(|| bad("no key"))?;
    let mut out = format!("{{\"file\":{},\"line\":{}", json::string(file), line);
    if let Some(c) = site.get("column").and_then(Value::as_u64) {
        out.push_str(&format!(",\"column\":{c}"));
    }
    out.push_str(&format!(",\"fn\":{}", json::string(func)));
    for k in ["component", "prop"] {
        match site.get(k) {
            Some(Value::String(s)) => out.push_str(&format!(",\"{k}\":{}", json::string(s))),
            Some(Value::Null) => out.push_str(&format!(",\"{k}\":null")),
            _ => {}
        }
    }
    out.push_str(&format!(",\"key\":{}}}", json::string(key)));
    Ok(out)
}
