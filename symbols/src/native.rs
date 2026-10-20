//! Mach-O (thin and fat) and ELF files: debug ids, architectures, load addresses, and from DWARF the
//! function ranges and the line table, with the symbol table filling what DWARF leaves out.

use crate::{chunk, demangle, Built, Options, Result};
use object::read::elf::{FileHeader, ProgramHeader};
use object::{FileKind, Object, ObjectSection, ObjectSegment, ObjectSymbol, SymbolKind};
use serde::Serialize;
use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};

/// One object in a symbol file: a thin file has one, a fat Mach-O one per architecture.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectInfo {
    pub index: usize,
    pub kind: &'static str,
    /// LC_UUID or GNU build id, lowercase hex without dashes; empty when the file has none.
    pub debug_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    /// Whether the object carries DWARF line information.
    pub has_dwarf: bool,
    #[serde(skip)]
    range: (usize, usize),
}

/// The objects in a Mach-O (thin or fat) or ELF file.
pub fn inspect(bytes: &[u8]) -> Result<Vec<ObjectInfo>> {
    let kind = FileKind::parse(bytes).map_err(|e| format!("not a symbol file: {e}"))?;
    let slices: Vec<(usize, usize)> = match kind {
        FileKind::MachOFat32 => object::read::macho::MachOFatFile32::parse(bytes)
            .map_err(|e| e.to_string())?
            .arches()
            .iter()
            .map(|a| object::read::macho::FatArch::file_range(a))
            .map(|(o, s)| (o as usize, s as usize))
            .collect(),
        FileKind::MachOFat64 => object::read::macho::MachOFatFile64::parse(bytes)
            .map_err(|e| e.to_string())?
            .arches()
            .iter()
            .map(|a| object::read::macho::FatArch::file_range(a))
            .map(|(o, s)| (o as usize, s as usize))
            .collect(),
        FileKind::MachO32 | FileKind::MachO64 | FileKind::Elf32 | FileKind::Elf64 => vec![(0, bytes.len())],
        other => return Err(format!("unsupported file kind {other:?}: expected a Mach-O dSYM or an ELF file")),
    };
    let mut out = Vec::new();
    for (index, (off, size)) in slices.into_iter().enumerate() {
        let data = bytes.get(off..off + size).ok_or("a fat architecture points past the end of the file")?;
        let file = object::File::parse(data).map_err(|e| e.to_string())?;
        let (kind, debug_id, arch) = match file.format() {
            object::BinaryFormat::MachO => ("macho", file.mach_uuid().ok().flatten().map(|u| hex(&u)).unwrap_or_default(), macho_arch(data)),
            object::BinaryFormat::Elf => ("elf", file.build_id().ok().flatten().map(hex).unwrap_or_default(), elf_arch(file.architecture())),
            f => return Err(format!("unsupported format {f:?}")),
        };
        let has_dwarf = file.section_by_name(".debug_line").map(|s| s.size() > 0).unwrap_or(false);
        out.push(ObjectInfo { index, kind, debug_id, arch, has_dwarf, range: (off, size) });
    }
    Ok(out)
}

/// The Swift mangled names object `index` uses, for the CLI to demangle with swift-demangle.
pub fn swift_names(bytes: &[u8], index: usize) -> Result<Vec<String>> {
    let (_, data) = object_at(bytes, index)?;
    let ex = extract(data)?;
    let mut names: Vec<String> = ex.fns.iter().map(|f| demangle::demangle(&f.2)).filter(|n| demangle::is_swift_mangled(n)).collect();
    names.sort();
    names.dedup();
    Ok(names)
}

pub fn build(bytes: &[u8], index: usize, opts: &Options) -> Result<Built> {
    let (info, data) = object_at(bytes, index)?;
    let ex = extract(data)?;
    if info.debug_id.is_empty() && opts.debug_id.is_none() {
        return Err(format!("the {} file has no {}: pass a debug id", info.kind, if info.kind == "macho" { "LC_UUID" } else { "GNU build id" }));
    }
    let mut left_mangled = false;
    let mut fns: Vec<(u64, u64, String)> = ex
        .fns
        .into_iter()
        .map(|(s, e, raw)| {
            let d = demangle::demangle(&raw);
            let name = if demangle::is_swift_mangled(&d) {
                match opts.swift_names.get(&d) {
                    Some(n) => n.clone(),
                    None => {
                        left_mangled = true;
                        d
                    }
                }
            } else {
                d
            };
            (s - ex.base, e - ex.base, name)
        })
        .collect();
    fns.sort();
    // One entry per range: identical code folded under several names keeps the first name.
    fns.dedup_by(|b, a| a.0 == b.0 && a.1 == b.1);
    let lines = outer_lines(fold_lines(ex.lines, ex.base), &ex.calls, ex.base);
    let chunks = chunk::native(&fns, &lines, &ex.files, opts.budget());
    let refs = chunks.iter().enumerate().map(|(i, c)| crate::ChunkRef { file: crate::chunk_file(i), first: format!("{:016x}", c.0) }).collect();
    let mut m = crate::manifest(info.kind, info.debug_id.clone(), opts, refs);
    m.arch = info.arch.clone();
    if left_mangled {
        m.mangled.push("swift".into());
    }
    let warnings = ex.warnings.iter().map(|(w, n)| if *n > 1 { format!("{w} ({n} times)") } else { w.clone() }).collect();
    Ok(Built { manifest: m, chunks: chunks.into_iter().enumerate().map(|(i, c)| (crate::chunk_file(i), c.1)).collect(), warnings })
}

fn object_at(bytes: &[u8], index: usize) -> Result<(ObjectInfo, &[u8])> {
    let objects = inspect(bytes)?;
    let info = objects.into_iter().nth(index).ok_or_else(|| format!("no object {index} in the file"))?;
    let (off, size) = info.range;
    Ok((info, &bytes[off..off + size]))
}

pub(crate) fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn macho_arch(data: &[u8]) -> Option<String> {
    let word = |at: usize| data.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let magic = word(0)?;
    if magic != 0xfeed_facf && magic != 0xfeed_face {
        return None;
    }
    let (cpu, sub) = (word(4)?, word(8)? & 0x00ff_ffff);
    Some(
        match (cpu, sub) {
            (0x0100_000c, 2) => "arm64e",
            (0x0100_000c, _) => "arm64",
            (0x0200_000c, _) => "arm64_32",
            (0x0100_0007, 8) => "x86_64h",
            (0x0100_0007, _) => "x86_64",
            (7, _) => "i386",
            (12, 9) => "armv7",
            (12, 11) => "armv7s",
            (12, 12) => "armv7k",
            (12, _) => "arm",
            _ => return Some(format!("cpu{cpu:x}")),
        }
        .to_string(),
    )
}

fn elf_arch(a: object::Architecture) -> Option<String> {
    use object::Architecture::*;
    Some(
        match a {
            Aarch64 => "arm64",
            Arm => "arm",
            X86_64 => "x86_64",
            I386 => "x86",
            Riscv64 => "riscv64",
            _ => return None,
        }
        .to_string(),
    )
}

/// The address offsets are relative to: Mach-O `__TEXT` vmaddr, ELF first PT_LOAD p_vaddr.
fn load_address(file: &object::File, data: &[u8]) -> u64 {
    match file.format() {
        object::BinaryFormat::MachO => file.segments().find(|s| s.name().ok().flatten() == Some("__TEXT")).map(|s| s.address()).unwrap_or(0),
        object::BinaryFormat::Elf => match FileKind::parse(data) {
            Ok(FileKind::Elf64) => elf_first_load::<object::elf::FileHeader64<object::Endianness>>(data),
            Ok(FileKind::Elf32) => elf_first_load::<object::elf::FileHeader32<object::Endianness>>(data),
            _ => None,
        }
        .unwrap_or(0),
        _ => 0,
    }
}

fn elf_first_load<Elf: FileHeader<Endian = object::Endianness>>(data: &[u8]) -> Option<u64> {
    let header = Elf::parse(data).ok()?;
    let endian = header.endian().ok()?;
    header
        .program_headers(endian, data)
        .ok()?
        .iter()
        .find(|ph| ph.p_type(endian) == object::elf::PT_LOAD)
        .map(|ph| ph.p_vaddr(endian).into())
}

/// A line-table row before folding: `file` None marks the end of a sequence.
#[derive(Debug, Clone, Copy)]
struct RawRow {
    addr: u64,
    file: Option<u32>,
    line: u32,
}

struct Extracted {
    base: u64,
    /// Absolute ranges and raw (mangled) names.
    fns: Vec<(u64, u64, String)>,
    lines: Vec<RawRow>,
    files: Vec<String>,
    /// Outermost inlined calls: [begin, end) absolute, and the call's file and line in the caller.
    calls: Vec<(u64, u64, u32, u32)>,
    /// Starts of functions DWARF names without a linkage name: the symbol table's name wins there.
    plain: HashSet<u64>,
    /// What was skipped (damaged or tombstoned DWARF), by message, with a count.
    warnings: BTreeMap<String, usize>,
}

impl Extracted {
    fn warn(&mut self, what: String) {
        *self.warnings.entry(what).or_insert(0) += 1;
    }
}

type Reader<'a> = gimli::EndianSlice<'a, gimli::RunTimeEndian>;

fn extract(data: &[u8]) -> Result<Extracted> {
    let file = object::File::parse(data).map_err(|e| e.to_string())?;
    let base = load_address(&file, data);
    let endian = if file.is_little_endian() { gimli::RunTimeEndian::Little } else { gimli::RunTimeEndian::Big };
    let load = |id: gimli::SectionId| -> std::result::Result<Cow<[u8]>, gimli::Error> {
        Ok(match file.section_by_name(id.name()) {
            Some(s) => s.uncompressed_data().unwrap_or(Cow::Borrowed(&[])),
            None => Cow::Borrowed(&[]),
        })
    };
    let owned = gimli::DwarfSections::load(load).map_err(|e| format!("reading DWARF: {e}"))?;
    let dwarf = owned.borrow(|s| gimli::EndianSlice::new(s, endian));
    let mut ex = Extracted { base, fns: Vec::new(), lines: Vec::new(), files: Vec::new(), calls: Vec::new(), plain: HashSet::new(), warnings: BTreeMap::new() };
    let mut file_ids: HashMap<String, u32> = HashMap::new();
    let mut units = dwarf.units();
    loop {
        let header = match units.next() {
            Ok(Some(h)) => h,
            Ok(None) => break,
            Err(e) => {
                ex.warn(format!("the DWARF unit list is damaged, later units skipped: {e}"));
                break;
            }
        };
        match dwarf.unit(header) {
            Ok(unit) => read_unit(&dwarf, &unit, &mut ex, &mut file_ids),
            Err(e) => ex.warn(format!("a DWARF unit could not be read and was skipped: {e}")),
        }
    }
    ex.fns.retain(|f| f.0 >= base && f.1 > f.0 && f.1 - f.0 < 1 << 32);
    ex.lines.retain(|r| r.addr >= base);
    add_symbols(&file, &mut ex);
    Ok(ex)
}

/// Maps a unit's file indexes to the file table of the whole object.
struct UnitFiles<'a> {
    comp_dir: String,
    cache: HashMap<u64, Option<u32>>,
    ids: &'a mut HashMap<String, u32>,
}

impl UnitFiles<'_> {
    fn id(&mut self, dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, header: &gimli::LineProgramHeader<Reader>, idx: u64, files: &mut Vec<String>) -> Option<u32> {
        if let Some(f) = self.cache.get(&idx) {
            return *f;
        }
        let f = header.file(idx).map(|fe| {
            let path = file_path(dwarf, unit, header, fe, &self.comp_dir);
            *self.ids.entry(path.clone()).or_insert_with(|| {
                files.push(path);
                (files.len() - 1) as u32
            })
        });
        self.cache.insert(idx, f);
        f
    }
}

fn read_unit(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, ex: &mut Extracted, file_ids: &mut HashMap<String, u32>) {
    let comp_dir = unit.comp_dir.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let mut uf = UnitFiles { comp_dir, cache: HashMap::new(), ids: file_ids };
    if let Err(e) = read_lines(dwarf, unit, ex, &mut uf) {
        // Close the sequence that broke off.
        if let Some(last) = ex.lines.last().copied() {
            ex.lines.push(RawRow { addr: last.addr, file: None, line: 0 });
        }
        ex.warn(format!("a line program stopped early: {e}"));
    }
    if let Err(e) = read_functions(dwarf, unit, ex, &mut uf) {
        ex.warn(format!("a unit's functions stopped early: {e}"));
    }
}

fn read_lines(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, ex: &mut Extracted, uf: &mut UnitFiles) -> gimli::Result<()> {
    if let Some(program) = unit.line_program.clone() {
        let mut rows = program.rows();
        let mut errors = 0;
        loop {
            let (header, row) = match rows.next_row() {
                Ok(Some(r)) => {
                    errors = 0;
                    r
                }
                Ok(None) => break,
                // dsymutil sometimes ends a sequence with a negative DW_LNS_advance_pc (the end
                // address below the start); gimli refuses the overflow after consuming the
                // instruction, so the next call goes on with DW_LNE_end_sequence at the last address.
                Err(gimli::Error::AddressOverflow) if errors < 64 => {
                    errors += 1;
                    continue;
                }
                Err(e) => return Err(e),
            };
            if row.end_sequence() {
                ex.lines.push(RawRow { addr: row.address(), file: None, line: 0 });
                continue;
            }
            let file = uf.id(dwarf, unit, header, row.file_index(), &mut ex.files);
            let line = row.line().map(|l| l.get().min(u32::MAX as u64) as u32).unwrap_or(0);
            // A row without a file is kept as "no line information".
            ex.lines.push(RawRow { addr: row.address(), file: Some(file.unwrap_or(u32::MAX)), line: if file.is_some() { line } else { 0 } });
        }
    }
    Ok(())
}

/// A DIE's address ranges; none when they do not read (tombstoned, dead-stripped code: low_pc -1
/// plus a length overflows).
fn ranges_of(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, entry: &gimli::DebuggingInformationEntry<Reader>) -> Vec<gimli::Range> {
    let mut rs = Vec::new();
    let Ok(mut ranges) = dwarf.die_ranges(unit, entry) else { return rs };
    loop {
        match ranges.next() {
            Ok(Some(r)) if r.end > r.begin => rs.push(r),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {
                rs.clear();
                break;
            }
        }
    }
    rs
}

fn read_functions(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, ex: &mut Extracted, uf: &mut UnitFiles) -> gimli::Result<()> {
    let header = unit.line_program.as_ref().map(|p| p.header().clone());
    let mut entries = unit.entries();
    // Tags of the current DIE's ancestors.
    let mut stack: Vec<gimli::DwTag> = Vec::new();
    let mut depth: isize = 0;
    while let Some((delta, entry)) = entries.next_dfs()? {
        depth += delta;
        stack.truncate(depth.max(0) as usize);
        let tag = entry.tag();
        let parent_scope = stack.iter().rev().find(|t| **t == gimli::DW_TAG_subprogram || **t == gimli::DW_TAG_inlined_subroutine).copied();
        stack.push(tag);
        if tag == gimli::DW_TAG_inlined_subroutine {
            // Only the outermost inlined call: its call site is a line of the function itself.
            if parent_scope != Some(gimli::DW_TAG_subprogram) {
                continue;
            }
            let (Some(h), Ok(Some(gimli::AttributeValue::FileIndex(fi))), Ok(Some(line))) = (header.as_ref(), entry.attr_value(gimli::DW_AT_call_file), entry.attr_value(gimli::DW_AT_call_line)) else { continue };
            let Some(line) = line.udata_value() else { continue };
            let Some(file) = uf.id(dwarf, unit, h, fi, &mut ex.files) else { continue };
            for r in ranges_of(dwarf, unit, entry) {
                ex.calls.push((r.begin, r.end, file, line.min(u32::MAX as u64) as u32));
            }
            continue;
        }
        if tag != gimli::DW_TAG_subprogram {
            continue;
        }
        let rs = ranges_of(dwarf, unit, entry);
        if rs.is_empty() {
            continue;
        }
        let Some((name, linkage)) = die_name(dwarf, unit, entry, 0) else { continue };
        if name.is_empty() {
            continue;
        }
        if !linkage {
            ex.plain.extend(rs.iter().map(|r| r.begin));
        }
        for r in rs {
            ex.fns.push((r.begin, r.end, name.clone()));
        }
    }
    Ok(())
}

fn attr_string(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, v: gimli::AttributeValue<Reader>) -> Option<String> {
    dwarf.attr_string(unit, v).ok().map(|s| s.to_string_lossy().into_owned())
}

/// The linkage name (mangled) when there is one, else the name, following
/// DW_AT_specification and DW_AT_abstract_origin within the unit. The flag: a linkage name.
fn die_name(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, entry: &gimli::DebuggingInformationEntry<Reader>, depth: u32) -> Option<(String, bool)> {
    for at in [gimli::DW_AT_linkage_name, gimli::DW_AT_MIPS_linkage_name] {
        if let Ok(Some(v)) = entry.attr_value(at) {
            if let Some(s) = attr_string(dwarf, unit, v) {
                return Some((s, true));
            }
        }
    }
    if depth < 4 {
        for at in [gimli::DW_AT_specification, gimli::DW_AT_abstract_origin] {
            if let Ok(Some(gimli::AttributeValue::UnitRef(off))) = entry.attr_value(at) {
                if let Ok(other) = unit.entry(off) {
                    if let Some(n) = die_name(dwarf, unit, &other, depth + 1) {
                        return Some(n);
                    }
                }
            }
        }
    }
    if let Ok(Some(v)) = entry.attr_value(gimli::DW_AT_name) {
        return attr_string(dwarf, unit, v).map(|s| (s, false));
    }
    None
}

fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() || name.starts_with('/') {
        name.to_string()
    } else if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// A source path, relative to the unit's compilation directory when it is inside it.
fn file_path(dwarf: &gimli::Dwarf<Reader>, unit: &gimli::Unit<Reader>, header: &gimli::LineProgramHeader<Reader>, fe: &gimli::FileEntry<Reader>, comp_dir: &str) -> String {
    let mut name = attr_string(dwarf, unit, fe.path_name()).unwrap_or_default();
    // Dart (Flutter) names files by URI: file:///…/main.dart becomes a path; package: and dart:
    // URIs are kept as they are.
    if let Some(p) = name.strip_prefix("file://") {
        name = p.to_string();
    } else if uri_scheme(&name) {
        return name;
    }
    let mut path = name.clone();
    if !name.starts_with('/') {
        let dir = fe.directory(header).and_then(|d| attr_string(dwarf, unit, d)).unwrap_or_default();
        let dir = if dir.starts_with('/') { dir } else { join(comp_dir, &dir) };
        path = join(&dir, &name);
    }
    let path = normalize(&path);
    if !comp_dir.is_empty() {
        let prefix = format!("{}/", comp_dir.trim_end_matches('/'));
        if let Some(rel) = path.strip_prefix(&prefix) {
            return rel.to_string();
        }
    }
    path
}

/// `package:foo/bar.dart`, `dart:core/list.dart`: a URI scheme (two letters or more, so `C:` is not).
fn uri_scheme(s: &str) -> bool {
    match s.find(':') {
        Some(i) if i >= 2 => s[..i].chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '.' || c == '-') && s.as_bytes()[0].is_ascii_alphabetic(),
        _ => false,
    }
}

/// Drops `.` segments and resolves `..` where it can.
fn normalize(p: &str) -> String {
    let abs = p.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." if parts.last().is_some_and(|l| *l != "..") => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    if abs {
        format!("/{joined}")
    } else {
        joined
    }
}

/// Text symbols cover what DWARF does not (functions built without debug info).
fn add_symbols(file: &object::File, ex: &mut Extracted) {
    let macho = file.format() == object::BinaryFormat::MachO;
    let mut syms: Vec<(u64, u64, String)> = Vec::new();
    for s in file.symbols() {
        if s.kind() != SymbolKind::Text || !s.is_definition() || s.address() < ex.base {
            continue;
        }
        let Ok(name) = s.name() else { continue };
        if name.is_empty() || name.starts_with("ltmp") || name.starts_with("$x") || name.starts_with("$d") {
            continue;
        }
        let name = if macho { name.strip_prefix('_').unwrap_or(name) } else { name };
        // Image headers, not code.
        if matches!(name, "_mh_execute_header" | "_mh_dylib_header" | "_mh_bundle_header" | "__dso_handle" | "_dso_handle") {
            continue;
        }
        let end = match s.section_index().and_then(|i| file.section_by_index(i).ok()) {
            Some(sec) => sec.address() + sec.size(),
            None => s.address() + s.size(),
        };
        let size_end = if s.size() > 0 { s.address() + s.size() } else { end };
        syms.push((s.address(), size_end.min(end), name.to_string()));
    }
    syms.sort();
    syms.dedup_by(|b, a| a.0 == b.0);
    // A symbol without a size ends where the next one starts.
    for i in 0..syms.len() {
        if let Some(next) = syms.get(i + 1).map(|n| n.0) {
            if syms[i].1 > next {
                syms[i].1 = next;
            }
        }
    }
    // Where DWARF has a bare name, the symbol at the same start names it (as llvm-symbolizer does):
    // Dart drops a private class's underscore in DWARF (`Future._complete` for `_Future._complete`).
    if !ex.plain.is_empty() {
        let by_start: HashMap<u64, &str> = syms.iter().map(|s| (s.0, s.2.as_str())).collect();
        for f in ex.fns.iter_mut() {
            if ex.plain.contains(&f.0) {
                if let Some(n) = by_start.get(&f.0) {
                    f.2 = n.to_string();
                }
            }
        }
    }
    let mut dwarf: Vec<(u64, u64)> = ex.fns.iter().map(|f| (f.0, f.1)).collect();
    dwarf.sort();
    for (start, mut end, name) in syms {
        let i = dwarf.partition_point(|r| r.0 <= start);
        if i > 0 && dwarf[i - 1].1 > start {
            continue;
        }
        if let Some(next) = dwarf.get(i) {
            end = end.min(next.0);
        }
        if end > start {
            ex.fns.push((start, end, name));
        }
    }
}

/// The line table as rows of [offset, file, line]: one row per address (a sequence's end gives way
/// to a row starting there), line 0 for "no line information" (with the previous row's file),
/// consecutive equal rows merged.
fn fold_lines(mut raw: Vec<RawRow>, base: u64) -> Vec<(u64, u32, u32)> {
    raw.sort_by_key(|r| r.addr);
    let mut out: Vec<(u64, u32, u32)> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let addr = raw[i].addr;
        let mut j = i;
        let mut pick: Option<RawRow> = None;
        while j < raw.len() && raw[j].addr == addr {
            if raw[j].file.is_some() {
                pick = Some(raw[j]);
            }
            j += 1;
        }
        i = j;
        let prev_file = out.last().map(|r| r.1);
        let (file, line) = match pick {
            Some(r) if r.line > 0 && r.file != Some(u32::MAX) => (r.file.unwrap(), r.line),
            Some(r) => (prev_file.unwrap_or_else(|| r.file.filter(|f| *f != u32::MAX).unwrap_or(0)), 0),
            None => match prev_file {
                Some(f) => (f, 0),
                // A sequence end before any row: nothing to say yet.
                None => continue,
            },
        };
        if let Some(last) = out.last() {
            if last.1 == file && last.2 == line {
                continue;
            }
        }
        out.push((addr - base, file, line));
    }
    out
}

/// Rows inside an outermost inlined call take the call's file and line, so a row names a line of
/// the function `fns` names (what atos shows by default): the developer's call, not a line deep in
/// a header that was inlined into it.
fn outer_lines(rows: Vec<(u64, u32, u32)>, calls: &[(u64, u64, u32, u32)], base: u64) -> Vec<(u64, u32, u32)> {
    let mut calls: Vec<(u64, u64, u32, u32)> = calls.iter().filter(|c| c.0 >= base && c.3 > 0).map(|c| (c.0 - base, c.1 - base, c.2, c.3)).collect();
    if calls.is_empty() {
        return rows;
    }
    calls.sort();
    // Overlapping calls (should not happen at the outermost level): the first wins.
    let mut kept: Vec<(u64, u64, u32, u32)> = Vec::with_capacity(calls.len());
    for c in calls {
        if kept.last().is_none_or(|k| c.0 >= k.1) {
            kept.push(c);
        }
    }
    let inside = |addr: u64| {
        let i = kept.partition_point(|k| k.0 <= addr);
        i > 0 && addr < kept[i - 1].1
    };
    // The row in effect at an address, from the original table.
    let active = |addr: u64| {
        let i = rows.partition_point(|r| r.0 <= addr);
        if i == 0 {
            None
        } else {
            Some(rows[i - 1])
        }
    };
    let mut out: Vec<(u64, u32, u32)> = rows.iter().copied().filter(|r| !inside(r.0)).collect();
    for k in &kept {
        out.push((k.0, k.2, k.3));
        if !inside(k.1) && rows.binary_search_by_key(&k.1, |r| r.0).is_err() {
            if let Some(r) = active(k.1) {
                out.push((k.1, r.1, r.2));
            }
        }
    }
    out.sort_by_key(|r| r.0);
    out.dedup_by_key(|r| r.0);
    let mut merged: Vec<(u64, u32, u32)> = Vec::with_capacity(out.len());
    for r in out {
        if merged.last().is_some_and(|l| l.1 == r.1 && l.2 == r.2) {
            continue;
        }
        merged.push(r);
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inlined_calls_take_the_call_line() {
        let rows = vec![(0, 0, 10), (4, 1, 500), (8, 1, 501), (12, 0, 11), (16, 0, 12)];
        // A call at line 10 inlined over [4, 12), another at line 12 over [16, 20) with no row at 20.
        let calls = vec![(104, 112, 0, 10), (116, 120, 0, 12)];
        assert_eq!(outer_lines(rows, &calls, 100), vec![(0, 0, 10), (12, 0, 11), (16, 0, 12)]);
    }

    #[test]
    fn folds_rows() {
        let r = |addr, file: Option<u32>, line| RawRow { addr, file, line };
        let rows = vec![r(0x10, Some(0), 5), r(0x14, Some(0), 5), r(0x18, Some(0), 6), r(0x20, None, 0), r(0x20, Some(1), 9), r(0x30, None, 0), r(0x40, Some(0), 0)];
        assert_eq!(fold_lines(rows, 0x10), vec![(0, 0, 5), (8, 0, 6), (0x10, 1, 9), (0x20, 1, 0)]);
    }

    #[test]
    fn normalizes_paths() {
        assert_eq!(normalize("/src/app/./a/../b.c"), "/src/app/b.c");
        assert_eq!(normalize("../x/y.c"), "../x/y.c");
        assert!(uri_scheme("package:flutter/src/widgets/framework.dart"));
        assert!(uri_scheme("dart:core/list.dart"));
        assert!(!uri_scheme("C:/src/a.c"));
        assert!(!uri_scheme("/src/a:b.c"));
    }
}
