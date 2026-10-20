import Foundation

/// Where the app's functions are declared, read from its Swift sources, so a call site found on the
/// stack (`closure #1 in CardsViewController.fade()`, which has no line at runtime) gets a file and a
/// line (QA 0.2.0, N33). It needs the sources on a disk this process can read: the simulator reads
/// the Mac's, a device cannot (`unavailable` says why).
///
/// The line is the function's declaration, not the animation call inside it: the stack names the
/// function only. Built once, off the main thread; a function declared twice for one type (overloads)
/// keeps the first.
public struct SourceIndex: Sendable {
    public struct Location: Hashable, Sendable {
        /// Relative to the root the index was built with.
        public var file: String
        public var line: Int
    }

    /// Why sites have no file and line, for the app's log.
    public enum Unavailable: Error, Hashable, Sendable {
        case noRoot
        case unreadable(String)
        case noSwiftFiles(String)

        public var reason: String {
            switch self {
            case .noRoot:
                return "no source folder: set sourceRoot (or KEYFRAMER_ROOT) so call sites get a file and line"
            case .unreadable(let root):
                return "\(root) cannot be read from the app (a device cannot read the Mac's disk; the simulator can)"
            case .noSwiftFiles(let root):
                return "no Swift files under \(root)"
            }
        }
    }

    /// `Type.function` → where it is declared.
    private var functions: [String: Location] = [:]
    public var count: Int { functions.count }

    public init() {}

    /// Folders that are never the app's own sources.
    static let skipped: Set<String> = ["DerivedData", "Pods", "Carthage", "node_modules", "build", "Build", "SourcePackages", "checkouts"]
    static let maxFiles = 4000
    static let maxFileBytes = 1 << 20

    /// Reads every `.swift` file under `root` (hidden folders and build products left out).
    public static func build(root: String) -> Result<SourceIndex, Unavailable> {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: root, isDirectory: &isDir), isDir.boolValue, fm.isReadableFile(atPath: root) else {
            return .failure(.unreadable(root))
        }
        let base = URL(fileURLWithPath: root).standardizedFileURL
        guard let walk = fm.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey], options: [.skipsHiddenFiles, .skipsPackageDescendants]) else {
            return .failure(.unreadable(root))
        }
        var index = SourceIndex()
        var files = 0
        let prefix = base.path.hasSuffix("/") ? base.path : base.path + "/"
        while let url = walk.nextObject() as? URL {
            let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            if values?.isDirectory == true {
                if skipped.contains(url.lastPathComponent) || url.lastPathComponent.hasSuffix(".xcodeproj") { walk.skipDescendants() }
                continue
            }
            guard url.pathExtension == "swift", (values?.fileSize ?? 0) <= maxFileBytes else { continue }
            files += 1
            if files > maxFiles { break }
            guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
            let path = url.standardizedFileURL.path
            index.add(source: text, file: path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path)
        }
        return files == 0 ? .failure(.noSwiftFiles(root)) : .success(index)
    }

    private static let typeDecl = try! NSRegularExpression(pattern: #"^\s*(?:[@\w()]+\s+)*?(?:class|struct|enum|actor|protocol|extension)\s+([A-Za-z_][\w.]*)"#)
    /// `class func`, `class var`: members, not types.
    private static let notTypes: Set<String> = ["func", "var", "let", "subscript", "init", "deinit", "override", "final", "static", "case"]
    private static let funcDecl = try! NSRegularExpression(pattern: #"\bfunc\s+([A-Za-z_]\w*|`\w+`)\s*[(<]|\b(init)\s*[?!]?\s*[(<]"#)

    /// One file's declarations. A function belongs to the innermost type whose braces are open around
    /// it (an extension counts as its type), so nested types and several types in a file are told apart.
    public mutating func add(source: String, file: String) {
        // Open types: their name and the brace depth inside them.
        var types: [(name: String, depth: Int)] = []
        var pending: String?
        var depth = 0
        var lineNumber = 0
        var inBlockComment = false
        for raw in source.split(separator: "\n", omittingEmptySubsequences: false) {
            lineNumber += 1
            var line = String(raw)
            // Comments and strings do not open or close braces, nor declare anything.
            if inBlockComment {
                guard let end = line.range(of: "*/") else { continue }
                line = String(line[end.upperBound...])
                inBlockComment = false
            }
            line = Self.code(of: line, inBlockComment: &inBlockComment)
            let ns = line as NSString
            let whole = NSRange(location: 0, length: ns.length)
            if let m = Self.typeDecl.firstMatch(in: line, range: whole), case let name = ns.substring(with: m.range(at: 1)), !Self.notTypes.contains(name) {
                // `extension A.B`: the innermost name is what a symbol prints with its outer types.
                let outer = types.last.map { $0.name + "." } ?? ""
                pending = line.contains("extension ") ? name : outer + name
            }
            if let m = Self.funcDecl.firstMatch(in: line, range: whole) {
                let r = m.range(at: 1).location != NSNotFound ? m.range(at: 1) : m.range(at: 2)
                let fn = ns.substring(with: r).trimmingCharacters(in: CharacterSet(charactersIn: "`"))
                let owner = pending ?? types.last?.name
                let key = owner.map { "\($0).\(fn)" } ?? fn
                if functions[key] == nil { functions[key] = Location(file: file, line: lineNumber) }
            }
            for ch in line {
                if ch == "{" {
                    depth += 1
                    if let p = pending {
                        types.append((p, depth))
                        pending = nil
                    }
                } else if ch == "}" {
                    if let top = types.last, top.depth == depth { types.removeLast() }
                    depth = max(0, depth - 1)
                }
            }
        }
    }

    /// `line` without comments and string contents.
    private static func code(of line: String, inBlockComment: inout Bool) -> String {
        var out = ""
        var inString = false
        var previous: Character?
        var it = line.makeIterator()
        while let ch = it.next() {
            if inString {
                if ch == "\"" && previous != "\\" { inString = false; out.append(ch) }
                previous = (previous == "\\" && ch == "\\") ? nil : ch
                continue
            }
            if ch == "/", previous == "/" {
                out.removeLast()
                return out
            }
            if ch == "*", previous == "/" {
                out.removeLast()
                // The rest of the line after the comment closes.
                var rest = ""
                while let c = it.next() { rest.append(c) }
                if let end = rest.range(of: "*/") {
                    return out + code(of: String(rest[end.upperBound...]), inBlockComment: &inBlockComment)
                }
                inBlockComment = true
                return out
            }
            if ch == "\"" { inString = true }
            out.append(ch)
            previous = ch
        }
        return out
    }

    /// Where a stack's function is declared. `name`: as SymbolName prints it (`closure #1 in
    /// CardsViewController.fade()`, `CardsViewController.fade:` for Objective-C, `Cards.Card.init(x:)`).
    public func locate(_ name: SymbolName) -> Location? {
        guard let (owner, fn) = Self.function(of: name.display) else { return nil }
        if let owner {
            // `Module.Type.f`, `Outer.Inner.f`: the longest suffix of the owner that was declared.
            let parts = owner.split(separator: ".")
            for i in 0..<parts.count {
                if let l = functions[parts[i...].joined(separator: ".") + "." + fn] { return l }
            }
            return nil
        }
        return functions[fn]
    }

    /// `closure #1 in closure #2 in A.B.f(x:)` → (`A.B`, `f`); a getter or setter → nil.
    static func function(of display: String) -> (owner: String?, name: String)? {
        var s = Substring(display)
        while let r = s.range(of: " in ") { s = s[r.upperBound...] }
        // Generic signatures and arguments: `f<A>(x:)`, Objective-C `fade:`; then `static A.f`.
        if let cut = s.firstIndex(where: { $0 == "(" || $0 == "<" || $0 == ":" }) { s = s[..<cut] }
        if let space = s.lastIndex(of: " ") { s = s[s.index(after: space)...] }
        let parts = s.split(separator: ".")
        guard let last = parts.last, !last.isEmpty, !["getter", "setter", "didSet", "willSet", "modify", "deinit"].contains(String(last)) else { return nil }
        let owner = parts.count > 1 ? parts.dropLast().joined(separator: ".") : nil
        return (owner, String(last))
    }
}
