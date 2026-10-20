//! Cutting a symbol set into chunks under a JSON budget.

use crate::json;
use std::collections::HashMap;

#[derive(Default)]
struct NativeChunk {
    first: u64,
    names: Vec<String>,
    name_idx: HashMap<String, u32>,
    files: Vec<String>,
    file_idx: HashMap<u32, u32>,
    fns: Vec<(u64, u64, u32)>,
    lines: Vec<(u64, u32, u32)>,
    size: usize,
}

impl NativeChunk {
    fn new(first: u64) -> Self {
        // {"names":[],"files":[],"fns":[],"lines":[]}
        NativeChunk { first, size: 42, ..Default::default() }
    }

    fn name(&mut self, n: &str) -> (u32, usize) {
        if let Some(i) = self.name_idx.get(n) {
            return (*i, 0);
        }
        let lit = json::string(n);
        let cost = lit.len() + 1;
        self.names.push(lit);
        let i = (self.names.len() - 1) as u32;
        self.name_idx.insert(n.to_string(), i);
        (i, cost)
    }

    fn file(&mut self, gid: u32, all: &[String]) -> (u32, usize) {
        if let Some(i) = self.file_idx.get(&gid) {
            return (*i, 0);
        }
        let lit = json::string(all.get(gid as usize).map(String::as_str).unwrap_or(""));
        let cost = lit.len() + 1;
        self.files.push(lit);
        let i = (self.files.len() - 1) as u32;
        self.file_idx.insert(gid, i);
        (i, cost)
    }

    fn add_fn(&mut self, f: &(u64, u64, String)) {
        let (n, cost) = self.name(&f.2);
        self.size += cost + json::digits(f.0) + json::digits(f.1) + json::digits(n as u64) + 5;
        self.fns.push((f.0, f.1, n));
    }

    fn add_line(&mut self, r: (u64, u32, u32), all_files: &[String]) {
        let (fi, cost) = self.file(r.1, all_files);
        let row = (r.0, fi, r.2);
        // A row carried into this chunk gives way to a real row at the same offset.
        if let Some(last) = self.lines.last_mut() {
            if last.0 == r.0 {
                *last = row;
                return;
            }
        }
        self.size += cost + json::digits(r.0) + json::digits(fi as u64) + json::digits(r.2 as u64) + 5;
        self.lines.push(row);
    }

    fn json(&self) -> String {
        let mut out = String::with_capacity(self.size + 16);
        out.push_str("{\"names\":");
        json::push_list(&mut out, &self.names);
        out.push_str(",\"files\":");
        json::push_list(&mut out, &self.files);
        out.push_str(",\"fns\":[");
        for (i, f) in self.fns.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("[{},{},{}]", f.0, f.1, f.2));
        }
        out.push_str("],\"lines\":[");
        for (i, l) in self.lines.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            out.push_str(&format!("[{},{},{}]", l.0, l.1, l.2));
        }
        out.push_str("]}");
        out
    }
}

/// Native chunks: (first offset, JSON). Each chunk holds the functions starting in its range and the
/// line rows of its range; a chunk that starts inside a function or a line row repeats them, so a
/// lookup of offset X reads only the last chunk whose `first` is at most X.
pub fn native(fns: &[(u64, u64, String)], lines: &[(u64, u32, u32)], files: &[String], budget: usize) -> Vec<(u64, String)> {
    let mut out = Vec::new();
    if fns.is_empty() && lines.is_empty() {
        return out;
    }
    let start = fns.first().map(|f| f.0).unwrap_or(u64::MAX).min(lines.first().map(|l| l.0).unwrap_or(u64::MAX));
    let mut cur = NativeChunk::new(start);
    let (mut fi, mut li) = (0, 0);
    let mut last_addr = start;
    let mut last_line: Option<(u64, u32, u32)> = None;
    loop {
        // Functions before line rows at the same offset.
        let take_fn = match (fns.get(fi), lines.get(li)) {
            (Some(f), Some(l)) => f.0 <= l.0,
            (Some(_), None) => true,
            (None, Some(_)) => false,
            (None, None) => break,
        };
        let (addr, cost) = if take_fn {
            let f = &fns[fi];
            (f.0, json::digits(f.0) + json::digits(f.1) + 8 + f.2.len())
        } else {
            let l = lines[li];
            (l.0, json::digits(l.0) + 12)
        };
        let has_content = !cur.fns.is_empty() || !cur.lines.is_empty();
        if has_content && addr > last_addr && cur.size + cost > budget {
            let mut next = NativeChunk::new(addr);
            for f in cur.fns.iter().filter(|f| f.1 > addr) {
                let name = names_of(&cur, f.2);
                next.add_fn(&(f.0, f.1, name));
            }
            if let Some(l) = last_line {
                if l.0 < addr {
                    next.add_line((addr, l.1, l.2), files);
                }
            }
            out.push((cur.first, cur.json()));
            cur = next;
        }
        if take_fn {
            cur.add_fn(&fns[fi]);
            fi += 1;
        } else {
            cur.add_line(lines[li], files);
            last_line = Some(lines[li]);
            li += 1;
        }
        last_addr = addr;
    }
    out.push((cur.first, cur.json()));
    out
}

fn names_of(c: &NativeChunk, idx: u32) -> String {
    // The chunk keeps names as JSON literals; carried functions need the plain name back.
    let lit = &c.names[idx as usize];
    serde_json::from_str::<String>(lit).unwrap_or_default()
}

/// Keyed chunks (r8 classes, rn-sites): `entries` sorted by key, each value already JSON. Returns
/// (first key, JSON `{"<field>":{...}}`).
pub fn keyed(field: &str, entries: &[(String, String)], budget: usize) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let open = format!("{{{}:{{", json::string(field));
    let mut cur = String::new();
    let mut first = String::new();
    for (k, v) in entries {
        let item = format!("{}:{}", json::string(k), v);
        if !cur.is_empty() && open.len() + cur.len() + item.len() + 3 > budget {
            out.push((std::mem::take(&mut first), format!("{open}{cur}}}}}")));
            cur.clear();
        }
        if cur.is_empty() {
            first = k.clone();
        } else {
            cur.push(',');
        }
        cur.push_str(&item);
    }
    if !cur.is_empty() || out.is_empty() {
        out.push((first, format!("{open}{cur}}}}}")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_functions_and_rows_across_chunks() {
        let fns = vec![(0, 100, "a".to_string()), (100, 400, "b".to_string())];
        let lines: Vec<(u64, u32, u32)> = (0..40).map(|i| (i * 10, 0, i as u32 + 1)).collect();
        let files = vec!["x.c".to_string()];
        let chunks = native(&fns, &lines, &files, 200);
        assert!(chunks.len() > 2);
        // Every chunk after the first that starts inside "b" repeats it.
        for (first, json) in &chunks[1..] {
            let v: serde_json::Value = serde_json::from_str(json).unwrap();
            let fns = v["fns"].as_array().unwrap();
            let lines = v["lines"].as_array().unwrap();
            assert_eq!(lines[0][0].as_u64().unwrap(), *first);
            if *first >= 100 {
                assert_eq!(v["names"][fns[0][2].as_u64().unwrap() as usize], "b");
            }
            assert!(json.len() <= 200 + 40, "chunk {} bytes", json.len());
        }
        // The rows of all chunks together are the table.
        let mut all: Vec<u64> = Vec::new();
        for (_, json) in &chunks {
            let v: serde_json::Value = serde_json::from_str(json).unwrap();
            for l in v["lines"].as_array().unwrap() {
                all.push(l[0].as_u64().unwrap());
            }
        }
        all.dedup();
        assert_eq!(all, (0..40).map(|i| i * 10).collect::<Vec<_>>());
    }

    #[test]
    fn keyed_chunks_split_by_budget() {
        let entries: Vec<(String, String)> = (0..10).map(|i| (format!("k{i}"), "{\"v\":1}".to_string())).collect();
        let chunks = keyed("sites", &entries, 60);
        assert!(chunks.len() > 1);
        assert_eq!(chunks[0].0, "k0");
        for (_, j) in &chunks {
            let v: serde_json::Value = serde_json::from_str(j).unwrap();
            assert!(v["sites"].is_object());
        }
    }
}
