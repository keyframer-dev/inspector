import Foundation

/// One line of `Thread.callStackSymbols`:
/// `3   MyApp    0x0000000102f3c1a4 $s5MyApp14ViewControllerC6bounceyyF + 120`
public struct SymbolFrame: Hashable, Sendable {
    public var index: Int
    /// The binary image: the app's executable, `MyApp.debug.dylib`, `UIKitCore`, `QuartzCore`…
    public var image: String
    public var address: UInt64
    /// As printed: mangled for Swift, `-[Class selector]` for Objective-C, `<redacted>` when stripped.
    public var symbol: String
    public var offset: Int

    public init(index: Int, image: String, address: UInt64, symbol: String, offset: Int) {
        self.index = index
        self.image = image
        self.address = address
        self.symbol = symbol
        self.offset = offset
    }

    // The image name can contain spaces, so it is everything up to the whitespace before `0x`.
    private static let pattern = try! NSRegularExpression(pattern: #"^\s*(\d+)\s+(.+?)\s+0x([0-9a-fA-F]+)\s+(.*?)(?:\s+\+\s+(\d+))?\s*$"#)

    public static func parse(_ line: String) -> SymbolFrame? {
        let ns = line as NSString
        guard let m = pattern.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { return nil }
        func group(_ i: Int) -> String? {
            let r = m.range(at: i)
            return r.location == NSNotFound ? nil : ns.substring(with: r)
        }
        guard let index = group(1).flatMap(Int.init), let image = group(2), let addr = group(3).flatMap({ UInt64($0, radix: 16) }) else { return nil }
        return SymbolFrame(index: index, image: image, address: addr, symbol: group(4) ?? "", offset: group(5).flatMap(Int.init) ?? 0)
    }

    public static func parse(lines: [String]) -> [SymbolFrame] {
        lines.compactMap(parse)
    }
}

/// Swift symbol demangling through the runtime's own `swift_demangle` (in libswiftCore on every
/// Apple OS; looked up with dlsym so nothing private is linked).
public enum Demangler {
    private typealias DemangleFn = @convention(c) (UnsafePointer<CChar>?, Int, UnsafeMutablePointer<CChar>?, UnsafeMutablePointer<Int>?, UInt32) -> UnsafeMutablePointer<CChar>?

    private static let demangleFn: DemangleFn? = {
        guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "swift_demangle") else { return nil } // RTLD_DEFAULT
        return unsafeBitCast(sym, to: DemangleFn.self)
    }()

    /// The demangled name, or the input unchanged when it is not a Swift symbol.
    public static func demangle(_ symbol: String) -> String {
        guard symbol.hasPrefix("$s") || symbol.hasPrefix("_$s") || symbol.hasPrefix("$S") || symbol.hasPrefix("_T"), let fn = demangleFn else { return symbol }
        return symbol.withCString { cstr in
            guard let out = fn(cstr, strlen(cstr), nil, nil, 0) else { return symbol }
            defer { free(out) }
            return String(cString: out)
        }
    }
}

/// A demangled symbol, reduced to what a person reads: `ViewController.bounce()` in type `ViewController`.
public struct SymbolName: Hashable, Sendable {
    public var module: String?
    public var type: String?
    /// `ViewController.bounce()`, or `closure #1 in ViewController.bounce()`.
    public var display: String

    public init(module: String?, type: String?, display: String) {
        self.module = module
        self.type = type
        self.display = display
    }

    private static let droppedPrefixes = ["@objc ", "merged ", "partial apply forwarder for ", "partial apply for ", "outlined copy of ", "specialized ", "@nonobjc "]

    /// Compiler glue between real functions (thunks, `@callee_guaranteed` adapters): never a call site.
    public var isThunk: Bool {
        display.hasPrefix("@") || display.contains("thunk") || display.hasPrefix("partial apply")
    }

    /// The app's entry point (`@main`): under everything the app does, so never the call site.
    public var isEntryPoint: Bool {
        display == "main" || display.hasSuffix("UIApplicationDelegate.main()") || display.hasSuffix("App.main()") || display.hasSuffix("$main()")
            || display.contains("main_executable_dylib_entry_point") // Xcode's debug dylib entry
    }

    public static func describe(_ raw: String) -> SymbolName {
        // Objective-C: -[ViewController bounce:] / +[Foo bar]
        if (raw.hasPrefix("-[") || raw.hasPrefix("+[")), raw.hasSuffix("]") {
            let inner = raw.dropFirst(2).dropLast()
            let parts = inner.split(separator: " ", maxSplits: 1)
            var cls = String(parts.first ?? "")
            if let paren = cls.firstIndex(of: "(") { cls = String(cls[..<paren]) } // category
            let sel = parts.count > 1 ? String(parts[1]) : ""
            return SymbolName(module: nil, type: cls, display: "\(cls).\(sel)")
        }
        var s = Demangler.demangle(raw)
        // `(registerScenarios in _1339DD0A…)` (a private name) → `registerScenarios`; async resumes too.
        s = s.replacingOccurrences(of: #"\(([^()]+?) in _[0-9A-F]{16,}\)"#, with: "$1", options: .regularExpression)
        s = s.replacingOccurrences(of: #"^\(\d+\) (await|suspend) resume partial function for "#, with: "", options: .regularExpression)
        var stripped = true
        while stripped {
            stripped = false
            for p in droppedPrefixes where s.hasPrefix(p) {
                s.removeFirst(p.count)
                stripped = true
            }
        }
        // `closure #1 () -> () in MyApp.ViewController.bounce() -> ()`: the closures, then their context.
        var closures: [String] = []
        while let r = topLevelRange(of: " in ", in: s) {
            let head = String(s[..<r.lowerBound])
            closures.append(closureLabel(head))
            s = String(s[r.upperBound...])
        }
        let context = dropSignatureTail(s)
        let nameEnd = topLevelIndex(of: "(", in: context) ?? context.endIndex
        let path = splitTopLevel(String(context[..<nameEnd]), on: ".")
        let args = String(context[nameEnd...])
        var module: String?
        var components = path
        if components.count > 1 {
            module = components.removeFirst()
        }
        let type = components.count > 1 ? components.dropLast().last.map { stripGenerics($0) } : nil
        let function = components.map(stripGenerics).joined(separator: ".") + args
        let display = (closures + [function]).joined(separator: " in ")
        return SymbolName(module: module, type: type, display: display.isEmpty ? raw : display)
    }

    private static func closureLabel(_ head: String) -> String {
        // "closure #1 () -> ()" → "closure #1"; a local function "press #1 (_: Swift.String) -> ()" → "press #1".
        if let r = head.range(of: #"(implicit )?closure #\d+"#, options: .regularExpression) { return String(head[r]) }
        if let r = head.range(of: " (") { return String(head[..<r.lowerBound]) }
        return head
    }

    /// `bounce() -> ()` → `bounce()`, `card.getter : UIView` → `card.getter`.
    private static func dropSignatureTail(_ s: String) -> String {
        var out = s
        if let r = topLevelRange(of: " -> ", in: out) { out = String(out[..<r.lowerBound]) }
        if let r = topLevelRange(of: " : ", in: out) { out = String(out[..<r.lowerBound]) }
        return out
    }

    private static func stripGenerics(_ s: String) -> String {
        guard let i = s.firstIndex(of: "<") else { return s }
        return String(s[..<i])
    }

    /// The first occurrence of `needle` outside (), <> and [].
    private static func topLevelRange(of needle: String, in s: String) -> Range<String.Index>? {
        var depth = 0
        var i = s.startIndex
        while i < s.endIndex {
            let ch = s[i]
            if ch == "(" || ch == "<" || ch == "[" { depth += 1 }
            else if ch == ")" || ch == ">" || ch == "]" { if !(ch == ">" && s[..<i].hasSuffix("-")) { depth = max(0, depth - 1) } }
            else if depth == 0, s[i...].hasPrefix(needle) { return i..<s.index(i, offsetBy: needle.count) }
            i = s.index(after: i)
        }
        return nil
    }

    private static func topLevelIndex(of ch: Character, in s: String) -> String.Index? {
        var depth = 0
        for i in s.indices {
            let c = s[i]
            if c == ch, depth == 0 { return i }
            if c == "<" || c == "[" { depth += 1 } else if c == ">" || c == "]" { depth = max(0, depth - 1) }
        }
        return nil
    }

    private static func splitTopLevel(_ s: String, on sep: Character) -> [String] {
        var parts: [String] = []
        var depth = 0
        var current = ""
        for c in s {
            if c == "<" || c == "(" || c == "[" { depth += 1 } else if c == ">" || c == ")" || c == "]" { depth = max(0, depth - 1) }
            if c == sep, depth == 0 {
                parts.append(current)
                current = ""
            } else {
                current.append(c)
            }
        }
        parts.append(current)
        return parts
    }
}

/// Where an animation call came from, as far as a stack can tell.
public struct ResolvedSite: Hashable, Sendable {
    /// `KeyframerExample.debug.dylib`'s frame: `ViewController.bounce()`.
    public var name: SymbolName
    public var frame: SymbolFrame
    /// The function, as a person reads it: stable across builds and edits, and the same for every
    /// property one block animates (a return address' offset was neither: it moved with every edit,
    /// and differed per property setter). Two separate animations of one property in one function
    /// share it.
    public var id: String { name.display }
}

/// Picks the app's own frame out of a stack and formats stacks for the panel.
///
/// App frames are the ones whose image is the app: its executable (`MyApp`), or the
/// `MyApp.debug.dylib` Xcode builds for debug runs, plus any module the app names. The inspector's own
/// frames (it is linked into the same image) are skipped by their Swift module name.
public struct CallSiteResolver: Sendable {
    public var appImages: Set<String>
    public var skippedModules: Set<String>

    public init(executable: String, extraImages: [String] = [], skippedModules: Set<String> = ["KeyframerInspector", "KeyframerInspectorCore", "KeyframerInspectorSwiftUI"]) {
        var images: Set<String> = [executable, "\(executable).debug.dylib"]
        images.formUnion(extraImages)
        self.appImages = images
        self.skippedModules = skippedModules
    }

    public func isAppFrame(_ f: SymbolFrame) -> Bool {
        appImages.contains(f.image)
    }

    /// The frames below the swizzled `-[CALayer addAnimation:forKey:]` (`kf_add`): everything above it
    /// is the inspector taking the stack, including compiler glue that carries no module name.
    public func callerFrames(_ frames: [SymbolFrame]) -> ArraySlice<SymbolFrame> {
        if let i = frames.prefix(24).lastIndex(where: { $0.symbol.contains("kf_add") }) { return frames[(i + 1)...] }
        return frames[...]
    }

    /// The first app frame that is not the inspector's own code nor compiler glue.
    public func resolve(_ frames: [SymbolFrame], describe: (String) -> SymbolName = SymbolName.describe) -> ResolvedSite? {
        for f in callerFrames(frames) where isAppFrame(f) {
            if f.symbol.contains("KeyframerInspector") { continue }
            let name = describe(f.symbol)
            if let m = name.module, skippedModules.contains(m) { continue }
            if name.isThunk || name.isEntryPoint { continue }
            return ResolvedSite(name: name, frame: f)
        }
        return nil
    }

    /// The stack as protocol frames: `lineNumber` 0 (unknown at runtime), with the image, the offset
    /// into it (what `atos` needs, from `imageOffset`) and the raw symbol, so the Mac can resolve lines.
    /// Library frames are marked `collapse`.
    public func stackFrames(_ frames: [SymbolFrame], describe: (String) -> SymbolName = SymbolName.describe, imageOffset: (UInt64) -> Int? = ImageOffset.of, limit: Int = 40) -> [InspectorStackFrame] {
        var out: [InspectorStackFrame] = []
        for f in callerFrames(frames) {
            if f.symbol.contains("KeyframerInspector") { continue }
            let name = describe(f.symbol)
            if let m = name.module, skippedModules.contains(m) { continue }
            if name.isThunk { continue }
            out.append(InspectorStackFrame(
                methodName: name.display, file: f.image, lineNumber: 0, column: 0,
                collapse: isAppFrame(f) ? nil : true,
                image: f.image, offset: imageOffset(f.address), symbol: f.symbol
            ))
            if out.count >= limit { break }
        }
        return out
    }

    /// The stack in the V8 shape the panel already parses (`    at name (file:line:column)`). Native
    /// frames have no line here, so `file` is `image+0xoffset-in-symbol`: something `atos` on the Mac
    /// can turn into a line later. Inspector frames are dropped like on React Native.
    public func formatStack(_ frames: [SymbolFrame], describe: (String) -> SymbolName = SymbolName.describe, limit: Int = 40, maxChars: Int = 4000) -> String {
        var lines: [String] = []
        for f in callerFrames(frames) {
            if f.symbol.contains("KeyframerInspector") { continue }
            let name = describe(f.symbol)
            if let m = name.module, skippedModules.contains(m) { continue }
            if name.isThunk { continue }
            lines.append("    at \(name.display) (\(f.image)+0x\(String(f.offset, radix: 16)):0:0)")
            if lines.count >= limit { break }
        }
        let text = "Error\n" + lines.joined(separator: "\n")
        return text.count > maxChars ? String(text.prefix(maxChars)) : text
    }
}

/// Where an address sits in its binary image (address minus the image's load address), from `dladdr`.
public enum ImageOffset {
    public static func of(_ address: UInt64) -> Int? {
        guard let pointer = UnsafeRawPointer(bitPattern: UInt(address)) else { return nil }
        var info = Dl_info()
        guard dladdr(pointer, &info) != 0, let base = info.dli_fbase else { return nil }
        return Int(address - UInt64(UInt(bitPattern: base)))
    }
}
