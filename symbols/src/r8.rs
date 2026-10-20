//! R8 / ProGuard `mapping.txt` into r8 chunks keyed by obfuscated class name.
//!
//! Each method row is `[obfuscated, original, obfStart, obfEnd, origStart, origEnd]`:
//! - `a:b:type name(args):c:d -> x`: obfuscated lines a..b map to c..d, line by line;
//! - `a:b:type name(args):c -> x`: every line a..b maps to c (R8's rule: inlined frames, outlines);
//! - `a:b:type name(args) -> x`: the original lines are a..b;
//! - `type name(args) -> x`: no line information, all four numbers 0.
//!
//! A line L in a..b resolves to `origStart` when `origEnd == origStart`, else to
//! `origStart + (L - obfStart)`. Several rows with the same obfuscated name and range are an inline
//! stack, innermost first, as in the file. `original` is the method name; a method inlined from
//! another class keeps that class in front (`com.acme.SpringsKt.cardScale`).

use crate::{chunk, json, Built, ChunkRef, Options, Result};
use std::collections::BTreeMap;

struct Class {
    name: String,
    file: Option<String>,
    methods: Vec<(String, String, u32, u32, u32, u32)>,
}

pub fn build(text: &str, opts: &Options) -> Result<Built> {
    let debug_id = opts.debug_id.clone().or_else(|| crate::version_id(&opts.app)).ok_or("an r8 mapping needs --debug-id, or --app-version and --build")?;
    let classes = parse(text)?;
    if classes.is_empty() {
        return Err("no classes in the mapping file".into());
    }
    let entries: Vec<(String, String)> = classes.iter().map(|(obf, c)| (obf.clone(), class_json(c))).collect();
    let chunks = chunk::keyed("classes", &entries, opts.budget());
    let refs = chunks.iter().enumerate().map(|(i, c)| ChunkRef { file: crate::chunk_file(i), first: c.0.clone() }).collect();
    let m = crate::manifest("r8", debug_id, opts, refs);
    Ok(Built { manifest: m, chunks: chunks.into_iter().enumerate().map(|(i, c)| (crate::chunk_file(i), c.1)).collect(), warnings: Vec::new() })
}

fn class_json(c: &Class) -> String {
    let mut out = format!("{{\"name\":{}", json::string(&c.name));
    if let Some(f) = &c.file {
        out.push_str(&format!(",\"file\":{}", json::string(f)));
    }
    out.push_str(",\"methods\":[");
    for (i, m) in c.methods.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("[{},{},{},{},{},{}]", json::string(&m.0), json::string(&m.1), m.2, m.3, m.4, m.5));
    }
    out.push_str("]}");
    out
}

fn parse(text: &str) -> Result<BTreeMap<String, Class>> {
    let mut classes: BTreeMap<String, Class> = BTreeMap::new();
    let mut current: Option<String> = None;
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            // `# {"id":"sourceFile","fileName":"Foo.kt"}` right after a class line.
            if let (Some(obf), Some(file)) = (&current, source_file(trimmed)) {
                if let Some(c) = classes.get_mut(obf) {
                    c.file = Some(file);
                }
            }
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if !indented {
            let body = trimmed.strip_suffix(':').ok_or_else(|| format!("mapping.txt line {}: expected `original -> obfuscated:`", n + 1))?;
            let (orig, obf) = body.split_once(" -> ").ok_or_else(|| format!("mapping.txt line {}: expected `original -> obfuscated:`", n + 1))?;
            let obf = obf.trim().to_string();
            classes.insert(obf.clone(), Class { name: orig.trim().to_string(), file: None, methods: Vec::new() });
            current = Some(obf);
            continue;
        }
        let Some(obf_class) = &current else { continue };
        let Some((left, obf_name)) = trimmed.rsplit_once(" -> ") else { continue };
        // Fields have no parameter list.
        let Some(open) = left.find('(') else { continue };
        let Some(close) = left.rfind(')') else { continue };
        // Leading `a:b:` minified range.
        let mut head = &left[..open];
        let mut obf_range: Option<(u32, u32)> = None;
        let parts: Vec<&str> = head.splitn(3, ':').collect();
        if parts.len() == 3 {
            if let (Ok(a), Ok(b)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
                obf_range = Some((a, b));
                head = parts[2];
            }
        }
        let name = head.rsplit(' ').next().unwrap_or(head).to_string();
        // Trailing `:c` or `:c:d` original range.
        let tail: Vec<u32> = left[close + 1..].split(':').filter(|s| !s.is_empty()).filter_map(|s| s.parse().ok()).collect();
        let (os, oe, cs, ce) = match (obf_range, tail.as_slice()) {
            (Some((a, b)), [c, d, ..]) => (a, b, *c, *d),
            (Some((a, b)), [c]) => (a, b, *c, *c),
            (Some((a, b)), []) => (a, b, a, b),
            (None, [c, d, ..]) => (0, 0, *c, *d),
            (None, [c]) => (0, 0, *c, *c),
            (None, []) => (0, 0, 0, 0),
        };
        if let Some(c) = classes.get_mut(obf_class) {
            c.methods.push((obf_name.trim().to_string(), name, os, oe, cs, ce));
        }
    }
    Ok(classes)
}

fn source_file(comment: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(comment.trim_start_matches('#').trim()).ok()?;
    if v.get("id")?.as_str()? != "sourceFile" {
        return None;
    }
    Some(v.get("fileName")?.as_str()?.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges() {
        let c = parse("a.B -> x:\n# {\"id\":\"sourceFile\",\"fileName\":\"B.kt\"}\n    int f -> a\n    1:3:void m(int):10:12 -> a\n    4:4:void com.o.C.n():7 -> a\n    5:6:void k() -> b\n    void z() -> c\n").unwrap();
        let x = &c["x"];
        assert_eq!(x.name, "a.B");
        assert_eq!(x.file.as_deref(), Some("B.kt"));
        assert_eq!(
            x.methods,
            vec![
                ("a".into(), "m".into(), 1, 3, 10, 12),
                ("a".into(), "com.o.C.n".into(), 4, 4, 7, 7),
                ("b".into(), "k".into(), 5, 6, 5, 6),
                ("c".into(), "z".into(), 0, 0, 0, 0)
            ]
        );
    }
}
