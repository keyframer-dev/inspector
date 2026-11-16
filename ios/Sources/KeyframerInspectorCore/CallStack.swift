#if DEBUG || KEYFRAMER_INSPECTOR_RELEASE
import Foundation
import MachO

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

    /// A Swift symbol of the inspector's own modules, by the module's mangled name (`18KeyframerInspector`),
    /// which an extension of a system type (`CALayer.kf_add`) carries too. Matching the bare name would
    /// also skip an app module that starts with it.
    func isInspector(_ symbol: String) -> Bool {
        skippedModules.contains { symbol.contains("\($0.utf8.count)\($0)") }
    }

    /// The frames below the swizzled `-[CALayer addAnimation:forKey:]` (`kf_add`): everything above it
    /// is the inspector taking the stack, including compiler glue that carries no module name.
    public func callerFrames(_ frames: [SymbolFrame]) -> ArraySlice<SymbolFrame> {
        frames[callerStart(StackFrames(frames, resolver: self))...]
    }

    /// Where the caller's frames start: after the last `kf_add` among the first 24 frames. The inspector
    /// is linked into the app's image, so only app frames are looked at (no symbol lookup for the rest).
    func callerStart(_ stack: StackFrames) -> Int {
        var start = 0
        for i in 0..<min(24, stack.count) where stack.isApp(i) && stack.frame(i).symbol.contains("kf_add") { start = i + 1 }
        return start
    }

    /// The first app frame that is not the inspector's own code nor compiler glue.
    public func resolve(_ frames: [SymbolFrame], describe: (String) -> SymbolName = SymbolName.describe) -> ResolvedSite? {
        resolve(StackFrames(frames, resolver: self), describe: describe)
    }

    /// The same for a stack read lazily: only app frames are ever looked up, which is what makes it
    /// cheap enough for the main thread (a system image's symbol table is the slow part).
    public func resolve(_ stack: StackFrames, describe: (String) -> SymbolName = SymbolName.describe) -> ResolvedSite? {
        for i in callerStart(stack)..<stack.count where stack.isApp(i) {
            let f = stack.frame(i)
            if isInspector(f.symbol) { continue }
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
    public func stackFrames(_ frames: [SymbolFrame], describe: (String) -> SymbolName = SymbolName.describe, imageOffset: @escaping (UInt64) -> Int? = ImageOffset.of, limit: Int = 40) -> [InspectorStackFrame] {
        describeStack(StackFrames(frames, resolver: self, imageOffset: imageOffset), describe: describe, limit: limit).frames
    }

    /// The stack in the V8 shape the panel already parses (`    at name (file:line:column)`). Native
    /// frames have no line here, so `file` is `image+0xoffset-in-symbol`: something `atos` on the Mac
    /// can turn into a line later. Inspector frames are dropped like on React Native.
    public func formatStack(_ frames: [SymbolFrame], describe: (String) -> SymbolName = SymbolName.describe, limit: Int = 40, maxChars: Int = 4000) -> String {
        describeStack(StackFrames(frames, resolver: self), describe: describe, limit: limit, maxChars: maxChars).stack
    }

    /// Both shapes in one pass over the stack: the `stack` text and the protocol `frames`.
    public func describeStack(_ stack: StackFrames, describe: (String) -> SymbolName = SymbolName.describe, limit: Int = 40, maxChars: Int = 4000) -> DescribedStack {
        var lines: [String] = []
        var out: [InspectorStackFrame] = []
        for i in callerStart(stack)..<stack.count {
            let f = stack.frame(i)
            if isInspector(f.symbol) { continue }
            let name = describe(f.symbol)
            if let m = name.module, skippedModules.contains(m) { continue }
            if name.isThunk { continue }
            lines.append("    at \(name.display) (\(f.image)+0x\(String(f.offset, radix: 16)):0:0)")
            out.append(InspectorStackFrame(
                methodName: name.display, file: f.image, lineNumber: 0, column: 0,
                collapse: stack.isApp(i) ? nil : true,
                image: f.image, offset: stack.imageOffset(i), symbol: f.symbol
            ))
            if out.count >= limit { break }
        }
        let text = "Error\n" + lines.joined(separator: "\n")
        return DescribedStack(stack: text.count > maxChars ? String(text.prefix(maxChars)) : text, frames: out)
    }
}

/// A stack as an event carries it: the V8-shaped text and the protocol frames.
public struct DescribedStack: Hashable, Sendable {
    public var stack: String
    public var frames: [InspectorStackFrame]

    public init(stack: String, frames: [InspectorStackFrame]) {
        self.stack = stack
        self.frames = frames
    }
}

/// A stack's frames as the resolver reads them, by index: whether a frame is the app's is cheap to
/// tell, the frame itself (its symbol) may be looked up only when asked for.
public struct StackFrames {
    public let count: Int
    public let isApp: (Int) -> Bool
    public let frame: (Int) -> SymbolFrame
    public let imageOffset: (Int) -> Int?

    public init(count: Int, isApp: @escaping (Int) -> Bool, frame: @escaping (Int) -> SymbolFrame, imageOffset: @escaping (Int) -> Int?) {
        self.count = count
        self.isApp = isApp
        self.frame = frame
        self.imageOffset = imageOffset
    }

    /// Frames already read (`Thread.callStackSymbols` lines, the tests).
    public init(_ frames: [SymbolFrame], resolver: CallSiteResolver, imageOffset: @escaping (UInt64) -> Int? = ImageOffset.of) {
        self.init(count: frames.count, isApp: { resolver.isAppFrame(frames[$0]) }, frame: { frames[$0] }, imageOffset: { imageOffset(frames[$0].address) })
    }
}

// MARK: - Stacks taken as return addresses

/// A stack taken where it matters (inside the swizzle, inside withKeyframerAnimation) as return
/// addresses only: `backtrace`, no symbol lookup. Looking symbols up is what costs (`dladdr` searches an
/// image's symbol table, and a SwiftUI stack runs past a hundred frames), so `Thread.callStackSymbols`
/// on the main thread added tens of ms to the frame an animation started in. Symbols are read later,
/// off the main thread, through `StackSymbols` (once per address). Several events may share one stack
/// (a withKeyframerAnimation moving three traced values): it is described once.
public final class CapturedStack: @unchecked Sendable {
    public let addresses: [UInt]
    private let lock = NSLock()
    private var described: DescribedStack?

    public init(addresses: [UInt]) {
        self.addresses = addresses
    }

    /// The calling thread's return addresses, innermost first, this function's own frame left out.
    @inline(never)
    public static func capture(max: Int = 256) -> CapturedStack {
        var buffer = [UnsafeMutableRawPointer?](repeating: nil, count: max)
        let n = Int(backtrace(&buffer, Int32(max)))
        return CapturedStack(addresses: buffer.prefix(n).dropFirst().map { UInt(bitPattern: $0) })
    }

    /// `make()` the first time, the same answer after.
    public func described(_ make: () -> DescribedStack) -> DescribedStack {
        lock.lock()
        defer { lock.unlock() }
        if let described { return described }
        let d = make()
        described = d
        return d
    }
}

/// Symbols for return addresses, read with `dladdr` (what `Thread.callStackSymbols` does for every
/// frame, every time) and kept per address: an app's animations come from a few code paths, so after
/// the first time a frame costs a dictionary lookup. Whether an address is the app's is told from the
/// app images' `__TEXT` ranges, without any lookup. Thread-safe.
public final class StackSymbols: @unchecked Sendable {
    public let resolver: CallSiteResolver
    private let lock = NSLock()
    private var symbols: [UInt: (image: String, symbol: String, offset: Int, imageOffset: Int?)] = [:]
    private var names: [String: SymbolName] = [:]
    private var appRanges: [Range<UInt>] = []
    private var scannedImages: UInt32 = 0

    public init(resolver: CallSiteResolver) {
        self.resolver = resolver
    }

    /// `stack`'s frames, each looked up only when the resolver asks for it.
    public func frames(of stack: CapturedStack) -> StackFrames {
        let addresses = stack.addresses
        return StackFrames(
            count: addresses.count,
            isApp: { [self] in isApp(addresses[$0]) },
            frame: { [self] in frame(at: $0, address: addresses[$0]) },
            imageOffset: { [self] in lookUp(addresses[$0]).imageOffset }
        )
    }

    /// The first app frame of `stack` that is not the inspector's own nor compiler glue.
    public func resolve(_ stack: CapturedStack) -> ResolvedSite? {
        resolver.resolve(frames(of: stack), describe: describe)
    }

    /// `stack` as an event carries it, worked out once per stack.
    public func describe(_ stack: CapturedStack) -> DescribedStack {
        stack.described { resolver.describeStack(frames(of: stack), describe: describe) }
    }

    /// `SymbolName.describe`, kept per symbol.
    public func describe(_ symbol: String) -> SymbolName {
        lock.lock()
        if let cached = names[symbol] {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let name = SymbolName.describe(symbol)
        lock.lock()
        if names.count > 5000 { names = [:] }
        names[symbol] = name
        lock.unlock()
        return name
    }

    public func frame(at index: Int, address: UInt) -> SymbolFrame {
        let s = lookUp(address)
        return SymbolFrame(index: index, image: s.image, address: UInt64(address), symbol: s.symbol, offset: s.offset)
    }

    /// Does the first-time work of reading a stack now, off the main thread: the app images' `__TEXT`
    /// ranges, and one `dladdr` in each app image, whose first lookup indexes the image's symbols (30 ms
    /// for a large debug dylib). The first animation's stack then took 3.5 ms to read, not 13.6.
    public func prepare() {
        DispatchQueue.global(qos: .utility).async { [self] in
            _ = isApp(0)
            lock.lock()
            let ranges = appRanges
            lock.unlock()
            var info = Dl_info()
            for r in ranges {
                guard let p = UnsafeRawPointer(bitPattern: r.lowerBound + (r.upperBound - r.lowerBound) / 2) else { continue }
                _ = dladdr(p, &info)
            }
        }
    }

    /// Inside the `__TEXT` of one of the app's images (`resolver.appImages`, by file name).
    public func isApp(_ address: UInt) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let count = _dyld_image_count()
        if count != scannedImages {
            scannedImages = count
            appRanges = Self.textRanges { resolver.appImages.contains($0) }
        }
        return appRanges.contains { $0.contains(address) }
    }

    /// One frame the way `backtrace_symbols` prints it: the image's file name, the closest symbol and
    /// the distance from it (the image's name and the distance from its start when there is none).
    private func lookUp(_ address: UInt) -> (image: String, symbol: String, offset: Int, imageOffset: Int?) {
        lock.lock()
        if let hit = symbols[address] {
            lock.unlock()
            return hit
        }
        lock.unlock()
        var info = Dl_info()
        var entry: (image: String, symbol: String, offset: Int, imageOffset: Int?) = ("???", String(format: "0x%lx", address), 0, nil)
        if let pointer = UnsafeRawPointer(bitPattern: address), dladdr(pointer, &info) != 0 {
            let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "???"
            let base = info.dli_fbase.map { UInt(bitPattern: $0) }
            if let name = info.dli_sname, let start = info.dli_saddr {
                entry = (image, String(cString: name), Int(bitPattern: address &- UInt(bitPattern: start)), base.map { Int(bitPattern: address &- $0) })
            } else {
                entry = (image, image, base.map { Int(bitPattern: address &- $0) } ?? 0, base.map { Int(bitPattern: address &- $0) })
            }
        }
        lock.lock()
        if symbols.count > 20000 { symbols = [:] }
        symbols[address] = entry
        lock.unlock()
        return entry
    }

    /// The `__TEXT` ranges of the loaded images whose file name `keep` accepts.
    static func textRanges(_ keep: (String) -> Bool) -> [Range<UInt>] {
        var out: [Range<UInt>] = []
        for i in 0..<_dyld_image_count() {
            guard let name = _dyld_get_image_name(i), let header = _dyld_get_image_header(i) else { continue }
            guard keep((String(cString: name) as NSString).lastPathComponent) else { continue }
            if let range = textRange(header: UnsafeRawPointer(header), slide: _dyld_get_image_vmaddr_slide(i)) { out.append(range) }
        }
        return out
    }

    private static func textRange(header: UnsafeRawPointer, slide: Int) -> Range<UInt>? {
        let mh = header.loadUnaligned(as: mach_header_64.self)
        guard mh.magic == MH_MAGIC_64 else { return nil }
        var cursor = header + MemoryLayout<mach_header_64>.size
        for _ in 0..<mh.ncmds {
            let lc = cursor.loadUnaligned(as: load_command.self)
            if lc.cmd == UInt32(LC_SEGMENT_64) {
                let seg = cursor.loadUnaligned(as: segment_command_64.self)
                let name = withUnsafeBytes(of: seg.segname) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
                if name == "__TEXT" {
                    let start = UInt(bitPattern: Int(truncatingIfNeeded: Int64(bitPattern: seg.vmaddr) &+ Int64(slide)))
                    return start..<(start + UInt(seg.vmsize))
                }
            }
            guard lc.cmdsize > 0 else { break }
            cursor += Int(lc.cmdsize)
        }
        return nil
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
#endif
