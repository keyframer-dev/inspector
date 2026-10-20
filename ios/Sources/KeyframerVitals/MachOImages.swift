import Foundation
import MachO

/// One loaded Mach-O image of the app (the main executable or a framework inside the app bundle).
///
/// How a `native` site ref is made, and why the uploaded dSYM resolves it:
///
/// - A Mach-O image's `__TEXT` segment has a link-time address, `vmaddr` (0x100000000 for an
///   executable, usually 0 for a framework). The dSYM's DWARF and symbol table use those addresses.
/// - At launch dyld loads the image at `vmaddr + slide` (ASLR); `_dyld_get_image_vmaddr_slide` gives the
///   slide. `__TEXT` starts at file offset 0, so the image's mach header sits at `vmaddr + slide`.
/// - A return address `pc` from the call stack is therefore `vmaddr + offset + slide`, and the report
///   sends `offset = pc - slide - vmaddr` (equal to `pc - header`): the distance from the start of
///   `__TEXT`, independent of ASLR and of the link address. The symbols CLI writes its chunks with the
///   same origin (protocol vitals.ts, `VitalsSymbolChunk`), so the server looks up `vmaddr + offset`
///   in DWARF terms, or `offset` in chunk terms.
/// - The offset is a *return address*: it points at the instruction after the call. Resolvers should
///   look up `offset - 1` to land inside the call (what atos and crash symbolicators do); the reporter
///   sends the raw return address so nothing is lost.
/// - `images[]` names the image by its LC_UUID (the dSYM carries the same UUID), lowercase hex without
///   dashes, with its file name (`Acme`, `Acme.framework/Acme`, never a path) and architecture
///   (`arm64`, `arm64e`, `x86_64`: the dSYM slice to read).
struct MachOImage: Equatable {
    /// Runtime address where `__TEXT` starts (the mach header).
    let start: UInt
    let textSize: UInt64
    let slide: Int
    /// `__TEXT`'s link-time address.
    let textVMAddr: UInt64
    let image: VitalsImage

    func contains(_ address: UInt) -> Bool {
        address >= start && UInt64(address - start) < textSize
    }

    /// `address` relative to `__TEXT`'s vmaddr, the ASLR slide taken out.
    func offset(of address: UInt) -> UInt64 {
        UInt64(bitPattern: Int64(bitPattern: UInt64(address)) &- Int64(slide)) &- textVMAddr
    }

    /// Reads an image's header in memory: `__TEXT` vmaddr and size, LC_UUID and the CPU type.
    static func read(header: UnsafeRawPointer, slide: Int, path: String) -> MachOImage? {
        let mh = header.loadUnaligned(as: mach_header_64.self)
        guard mh.magic == MH_MAGIC_64 else { return nil }
        var cursor = header + MemoryLayout<mach_header_64>.size
        var text: (vmaddr: UInt64, vmsize: UInt64)?
        var uuid: String?
        for _ in 0..<mh.ncmds {
            let lc = cursor.loadUnaligned(as: load_command.self)
            if lc.cmd == UInt32(LC_SEGMENT_64) {
                let seg = cursor.loadUnaligned(as: segment_command_64.self)
                let name = withUnsafeBytes(of: seg.segname) { raw in
                    String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
                }
                if name == "__TEXT" { text = (seg.vmaddr, seg.vmsize) }
            } else if lc.cmd == UInt32(LC_UUID) {
                let cmd = cursor.loadUnaligned(as: uuid_command.self)
                uuid = withUnsafeBytes(of: cmd.uuid) { raw in raw.map { String(format: "%02x", $0) }.joined() }
            }
            guard lc.cmdsize > 0 else { break }
            cursor += Int(lc.cmdsize)
        }
        guard let text, let uuid else { return nil }
        let start = UInt(bitPattern: Int(truncatingIfNeeded: Int64(bitPattern: text.vmaddr) &+ Int64(slide)))
        return MachOImage(
            start: start, textSize: text.vmsize, slide: slide, textVMAddr: text.vmaddr,
            image: VitalsImage(debugId: uuid, kind: "macho", name: fileName(path), arch: arch(cpu: mh.cputype, subtype: mh.cpusubtype))
        )
    }

    /// `Acme` for `.../Acme.app/Acme`, `Acme.framework/Acme` for a framework's binary: never a path.
    static func fileName(_ path: String) -> String {
        let parts = path.split(separator: "/")
        guard let last = parts.last else { return path }
        if parts.count >= 2, parts[parts.count - 2].hasSuffix(".framework") { return "\(parts[parts.count - 2])/\(last)" }
        return String(last)
    }

    static func arch(cpu: cpu_type_t, subtype: cpu_subtype_t) -> String? {
        let sub = UInt32(bitPattern: subtype) & 0x00FF_FFFF
        switch cpu {
        case CPU_TYPE_ARM64: return sub == 2 ? "arm64e" : "arm64"
        case CPU_TYPE_X86_64: return sub == 8 ? "x86_64h" : "x86_64"
        default: return nil
        }
    }
}

/// The app's images, read from dyld once and again only when the image count changes (a framework
/// loaded later). System images are never kept: only frames in the app's own code become sites.
final class ImageTable {
    private let isAppImage: (String) -> Bool
    private var images: [MachOImage] = []
    private var scannedCount: UInt32 = 0
    private let lock = NSLock()

    /// `isAppImage` decides from an image's path; `standard` keeps what lives inside the app bundle.
    init(isAppImage: @escaping (String) -> Bool) {
        self.isAppImage = isAppImage
    }

    /// The main executable's folder (the `.app` bundle on iOS) and everything under it. Read from
    /// dyld's own path of image 0 so both sides use the same spelling (`/private/var/...`).
    static func standard() -> ImageTable {
        let main = _dyld_get_image_name(0).map { String(cString: $0) } ?? Bundle.main.bundlePath
        let bundle = (main as NSString).deletingLastPathComponent + "/"
        return ImageTable { $0.hasPrefix(bundle) }
    }

    var all: [MachOImage] {
        lock.lock(); defer { lock.unlock() }
        refreshLocked()
        return images
    }

    private func refreshLocked() {
        let count = _dyld_image_count()
        guard count != scannedCount else { return }
        scannedCount = count
        var found: [MachOImage] = []
        for i in 0..<count {
            guard let header = _dyld_get_image_header(i), let name = _dyld_get_image_name(i) else { continue }
            let path = String(cString: name)
            guard isAppImage(path), let image = MachOImage.read(header: UnsafeRawPointer(header), slide: _dyld_get_image_vmaddr_slide(i), path: path) else { continue }
            found.append(image)
        }
        images = found
    }

    /// The app image holding `address`, if any.
    func image(containing address: UInt) -> MachOImage? {
        lock.lock(); defer { lock.unlock() }
        refreshLocked()
        return images.first { $0.contains(address) }
    }

    /// The call site in a stack of return addresses: the first address at or after `skip` (the
    /// reporter's own frames) that lies in an app image.
    ///
    /// `inBlock`: the animation was added while a UIView animation block ran (`UIView.animate`,
    /// `UIViewPropertyAnimator`). The first app frames are then the block's body, called back by UIKit,
    /// and in an optimized build often only the compiler's `thunk for @escaping () -> ()`, shared by
    /// every block (the body tail-calls UIKit's setter, so its own frame is gone). The site is the next
    /// app frame above UIKit's animation frames instead: the code that called `UIView.animate`. When
    /// there is none, the block's frame is kept.
    func callSite(_ addresses: [UInt], skip: Int, inBlock: Bool = false) -> (image: MachOImage, offset: UInt64)? {
        guard skip < addresses.count else { return nil }
        let frames = addresses[skip...].map { (address: $0, image: image(containing: $0)) }
        guard let first = frames.firstIndex(where: { $0.image != nil }) else { return nil }
        var pick = first
        // App code that calls addAnimation:forKey: itself is its own site, block or not.
        if inBlock, first > 0 {
            var i = first
            while i < frames.count, frames[i].image != nil { i += 1 }        // the block's own frames
            let systemStart = i
            while i < frames.count, frames[i].image == nil { i += 1 }        // UIKit running the block
            if i > systemStart, i < frames.count { pick = i }
        }
        let f = frames[pick]
        return f.image.map { ($0, $0.offset(of: f.address)) }
    }

    func firstAppFrame(_ addresses: [UInt], skip: Int) -> (image: MachOImage, offset: UInt64)? {
        callSite(addresses, skip: skip)
    }
}

/// Return addresses of the calling thread, the innermost first (frame 0 is the caller of this function).
@inline(never)
func vitalsReturnAddresses(max: Int = 32) -> [UInt] {
    var buffer = [UnsafeMutableRawPointer?](repeating: nil, count: max)
    let n = Int(backtrace(&buffer, Int32(max)))
    // Frame 0 of backtrace() is this function itself.
    return buffer.prefix(n).dropFirst().map { UInt(bitPattern: $0) }
}
