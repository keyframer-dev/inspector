//! Demangling: C++ (Itanium) and Rust here; Swift is left to `swift-demangle` (the CLI runs it as a
//! post-pass on macOS and passes the results in `Options::swift_names`).

/// Swift mangling prefixes: Swift 5+ (`$s`), Swift 4 (`$S`, `_T0`), embedded (`$e`).
pub fn is_swift_mangled(name: &str) -> bool {
    let n = name.strip_prefix('_').filter(|n| n.starts_with('$')).unwrap_or(name);
    n.starts_with("$s") || n.starts_with("$S") || n.starts_with("$e") || n.starts_with("_T0")
}

/// The readable form of a symbol name. Swift names come back as they are (with a Mach-O symbol
/// table's extra underscore dropped); anything that does not demangle is kept.
pub fn demangle(name: &str) -> String {
    if is_swift_mangled(name) {
        return name.strip_prefix('_').filter(|n| n.starts_with('$')).unwrap_or(name).to_string();
    }
    // Mach-O symbol tables add one underscore: __Z…, __R….
    let n = if name.starts_with("__Z") || name.starts_with("__R") { &name[1..] } else { name };
    if n.starts_with("_Z") || n.starts_with("_R") {
        if let Ok(d) = rustc_demangle::try_demangle(n) {
            return format!("{d:#}");
        }
        if n.starts_with("_Z") {
            if let Ok(sym) = cpp_demangle::Symbol::new(n) {
                if let Ok(d) = sym.demangle(&cpp_demangle::DemangleOptions::default()) {
                    return d;
                }
            }
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demangles_cpp_rust_and_keeps_swift() {
        assert_eq!(demangle("_ZN6motion11interpolateEiii"), "motion::interpolate(int, int, int)");
        assert_eq!(demangle("__ZN6motion11interpolateEiii"), "motion::interpolate(int, int, int)");
        assert_eq!(demangle("_ZN4core3ptr13drop_in_place17h0123456789abcdefE"), "core::ptr::drop_in_place");
        assert_eq!(demangle("_RNvCs1234_7mycrate3foo"), "mycrate::foo");
        assert_eq!(demangle("_$s4Card10expandCardyS2dF"), "$s4Card10expandCardyS2dF");
        assert!(is_swift_mangled("$s4Card10expandCardyS2dF"));
        assert_eq!(demangle("card_expand"), "card_expand");
        assert_eq!(demangle("_Znot a symbol"), "_Znot a symbol");
    }
}
