//! Golden tests: every fixture input in `inspector/packages/protocol/fixtures/vitals/symbols/inputs`
//! against the manifests and chunks in `.../expected/<case>/<kind>/<debugId>/`. The CLI's tests
//! (`inspector/packages/vitals-cli`) check its dry-run output against the same files.
//!
//! `UPDATE_GOLDEN=1 cargo test --test golden` rewrites them.

use keyframer_vitals_symbols::{build_native, build_r8, build_sites, inspect, swift_names, App, Built, Cli, Options};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../protocol/fixtures/vitals/symbols")
}

fn opts() -> Options {
    Options {
        created_at: "1970-01-01T00:00:00.000Z".into(),
        cli: Cli { name: "keyframer-vitals".into(), version: "0.0.0-fixture".into() },
        ..Default::default()
    }
}

fn app(version: &str, build: &str) -> Option<App> {
    Some(App { id: None, version: Some(version.into()), build: Some(build.into()) })
}

/// Every symbol set a case produces.
fn case(name: &str) -> Vec<Built> {
    let input = fixtures().join("inputs");
    match name {
        "dsym-tiny" | "dsym-card" => {
            let bin = if name == "dsym-tiny" { "Tiny" } else { "Card" };
            let bytes = fs::read(input.join(format!("{bin}.dSYM/Contents/Resources/DWARF/{bin}"))).unwrap();
            let o = Options { name: Some(bin.into()), ..opts() };
            inspect(&bytes).unwrap().iter().map(|obj| build_native(&bytes, obj.index, &o).unwrap()).collect()
        }
        "elf" => {
            let bytes = fs::read(input.join("app.android-arm64.symbols")).unwrap();
            let o = Options { name: Some("app.android-arm64.symbols".into()), ..opts() };
            vec![build_native(&bytes, 0, &o).unwrap()]
        }
        "r8" | "r8-sharded" => {
            let text = fs::read_to_string(input.join("mapping.txt")).unwrap();
            let o = Options { app: app("1.4.0", "212"), chunk_budget: if name == "r8" { 0 } else { 600 }, ..opts() };
            vec![build_r8(&text, &o).unwrap()]
        }
        "rn-sites" => {
            let text = fs::read_to_string(input.join("sites-1.4.0+212.json")).unwrap();
            vec![build_sites(&text, &opts()).unwrap()]
        }
        _ => unreachable!(),
    }
}

const CASES: [&str; 6] = ["dsym-tiny", "dsym-card", "elf", "r8", "r8-sharded", "rn-sites"];

fn write_or_compare(dir: &Path, file: &str, got: &str, update: bool, failures: &mut Vec<String>) {
    let path = dir.join(file);
    if update {
        fs::create_dir_all(dir).unwrap();
        fs::write(&path, got).unwrap();
        return;
    }
    match fs::read_to_string(&path) {
        Ok(want) if want == got => {}
        Ok(_) => failures.push(format!("{} differs", path.display())),
        Err(_) => failures.push(format!("{} is missing", path.display())),
    }
}

#[test]
fn golden() {
    let update = std::env::var("UPDATE_GOLDEN").is_ok();
    let mut failures = Vec::new();
    for name in CASES {
        let root = fixtures().join("expected").join(name);
        if update {
            let _ = fs::remove_dir_all(&root);
        }
        let mut seen = 0;
        for built in case(name) {
            let dir = root.join(built.manifest.kind).join(&built.manifest.debug_id);
            write_or_compare(&dir, "manifest.json", &built.manifest_json(), update, &mut failures);
            for (file, json) in &built.chunks {
                write_or_compare(&dir, file, json, update, &mut failures);
                seen += 1;
            }
            // No stray chunk files from an older run.
            if !update {
                let count = fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
                if count != built.chunks.len() + 1 {
                    failures.push(format!("{} has {count} files, expected {}", dir.display(), built.chunks.len() + 1));
                }
            }
        }
        assert!(seen > 0, "{name} produced no chunks");
    }
    assert!(failures.is_empty(), "golden mismatches (UPDATE_GOLDEN=1 to rewrite):\n{}", failures.join("\n"));
}

#[test]
fn deterministic() {
    for name in CASES {
        let a: Vec<String> = case(name).iter().flat_map(|b| std::iter::once(b.manifest_json()).chain(b.chunks.iter().map(|c| c.1.clone()))).collect();
        let b: Vec<String> = case(name).iter().flat_map(|b| std::iter::once(b.manifest_json()).chain(b.chunks.iter().map(|c| c.1.clone()))).collect();
        assert_eq!(a, b, "{name}");
    }
}

#[test]
fn fat_dsym_has_one_object_per_arch() {
    let bytes = fs::read(fixtures().join("inputs/Tiny.dSYM/Contents/Resources/DWARF/Tiny")).unwrap();
    let objects = inspect(&bytes).unwrap();
    let archs: Vec<_> = objects.iter().map(|o| o.arch.clone().unwrap()).collect();
    assert_eq!(archs, vec!["x86_64", "arm64"]);
    assert_eq!(objects[1].debug_id, "3c612e63ac043ff49a44204bed4b5465");
    assert!(objects.iter().all(|o| o.has_dwarf && o.kind == "macho"));
}

/// Finds the function and line of an offset the way the Worker does: the last chunk whose `first`
/// is at most the offset, then a binary search in it.
fn lookup(built: &Built, offset: u64) -> (String, String, u32) {
    let i = built.manifest.chunks.partition_point(|c| u64::from_str_radix(&c.first, 16).unwrap() <= offset) - 1;
    let v: serde_json::Value = serde_json::from_str(&built.chunks[i].1).unwrap();
    let fns = v["fns"].as_array().unwrap();
    let f = fns.iter().rev().find(|f| f[0].as_u64().unwrap() <= offset && offset < f[1].as_u64().unwrap()).expect("a function");
    let lines = v["lines"].as_array().unwrap();
    let l = lines.iter().rev().find(|l| l[0].as_u64().unwrap() <= offset).expect("a row");
    (v["names"][f[2].as_u64().unwrap() as usize].as_str().unwrap().to_string(), v["files"][l[1].as_u64().unwrap() as usize].as_str().unwrap().to_string(), l[2].as_u64().unwrap() as u32)
}

#[test]
fn resolves_known_addresses() {
    // arm64 Tiny: __TEXT at 0x100000000; dwarfdump shows line 13 of tiny.c at 0x100000428 (inside
    // card_expand, with spring_step inlined) and line 21 at 0x10000046c (main).
    let tiny = case("dsym-tiny").into_iter().find(|b| b.manifest.arch.as_deref() == Some("arm64")).unwrap();
    assert_eq!(lookup(&tiny, 0x428), ("card_expand".into(), "tiny.c".into(), 13));
    assert_eq!(lookup(&tiny, 0x46c), ("main".into(), "tiny.c".into(), 21));
    // Inlined code takes the line of the outermost call, as atos shows it: spring_step inlined into
    // card_expand at line 13, card_expand inlined into main at line 21.
    assert_eq!(lookup(&tiny, 0x420), ("card_expand".into(), "tiny.c".into(), 13));
    assert_eq!(lookup(&tiny, 0x454), ("main".into(), "tiny.c".into(), 21));
    assert_eq!(lookup(&tiny, 0x464), ("main".into(), "tiny.c".into(), 12));
    let names: Vec<String> = tiny.chunks.iter().flat_map(|c| serde_json::from_str::<serde_json::Value>(&c.1).unwrap()["names"].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect::<Vec<_>>()).collect();
    assert!(names.iter().any(|n| n == "motion::interpolate(int, int, int)"), "{names:?}");

    // ELF: first PT_LOAD at 0x200000; line 13 of elf.c at 0x2101e4 (list_frame).
    let elf = case("elf").remove(0);
    assert_eq!(elf.manifest.debug_id, "c3f9ee9a3fa0587cfd669fda94ae06946a4e87c2");
    assert_eq!(elf.manifest.arch.as_deref(), Some("arm64"));
    assert_eq!(lookup(&elf, 0x101e4), ("list_frame".into(), "elf.c".into(), 13));
}

#[test]
fn small_budgets_shard_native_tables_without_losing_lookups() {
    let bytes = fs::read(fixtures().join("inputs/Tiny.dSYM/Contents/Resources/DWARF/Tiny")).unwrap();
    let whole = build_native(&bytes, 1, &opts()).unwrap();
    let sharded = build_native(&bytes, 1, &Options { chunk_budget: 120, ..opts() }).unwrap();
    assert_eq!(whole.chunks.len(), 1);
    assert!(sharded.chunks.len() > 3, "{} chunks", sharded.chunks.len());
    for off in (0x3f8..0x480).step_by(4) {
        assert_eq!(lookup(&whole, off), lookup(&sharded, off), "offset {off:#x}");
    }
}

#[test]
fn swift_names_demangled_outside_clear_the_flag() {
    let bytes = fs::read(fixtures().join("inputs/Card.dSYM/Contents/Resources/DWARF/Card")).unwrap();
    let mangled = swift_names(&bytes, 0).unwrap();
    assert!(mangled.iter().any(|n| n == "$s4Card06expandA0yS2dF"), "{mangled:?}");
    let plain = build_native(&bytes, 0, &opts()).unwrap();
    assert_eq!(plain.manifest.mangled, vec!["swift"]);
    let map: BTreeMap<String, String> = mangled.iter().map(|n| (n.clone(), format!("demangled {n}"))).collect();
    let done = build_native(&bytes, 0, &Options { swift_names: map, ..opts() }).unwrap();
    assert!(done.manifest.mangled.is_empty());
    assert!(done.chunks[0].1.contains("demangled $s4Card06expandA0yS2dF"));
}

#[test]
fn errors_are_plain() {
    assert!(inspect(b"hello").unwrap_err().contains("not a symbol file"));
    assert!(build_r8("a -> b:\n", &opts()).unwrap_err().contains("--app-version"));
    assert!(build_sites("{\"format\":\"x\"}", &opts()).unwrap_err().contains("not a sites file"));
}
