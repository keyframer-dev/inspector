//! A small JSON writer for chunks: compact, fixed key order, and a size known while building, so a
//! chunk is cut before it passes its budget.

/// `s` as a JSON string literal (the escapes JSON.stringify and serde_json both write).
pub fn string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Characters a number takes.
pub fn digits(mut n: u64) -> usize {
    let mut d = 1;
    while n >= 10 {
        n /= 10;
        d += 1;
    }
    d
}

/// Writes `[a,b,...]` of string literals already escaped.
pub fn push_list(out: &mut String, items: &[String]) {
    out.push('[');
    for (i, s) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(s);
    }
    out.push(']');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_like_json_stringify() {
        assert_eq!(string("a\"b\\c\nd\u{1}é"), "\"a\\\"b\\\\c\\nd\\u0001é\"");
        assert_eq!(digits(0), 1);
        assert_eq!(digits(10), 2);
        assert_eq!(digits(u64::MAX), 20);
    }
}
