import Foundation
import MachO
import XCTest
@testable import KeyframerVitals

/// A function whose return address the tests resolve back to its name, the way the uploaded dSYM will.
@inline(never)
func vitalsProbeCaller() -> [UInt] {
    let frames = vitalsReturnAddresses()
    return frames
}

final class MachOTests: XCTestCase {
    /// The test binary, as dyld spells its path.
    private var executable: String {
        var info = Dl_info()
        dladdr(#dsohandle, &info)
        return String(cString: info.dli_fname)
    }

    private func table() -> ImageTable {
        let exe = executable
        return ImageTable { $0 == exe }
    }

    /// The test binary's own image: found from a return address, offset from `__TEXT`'s vmaddr with
    /// the slide taken out, its LC_UUID as dwarfdump prints it, and atos names the function at
    /// `vmaddr + offset - 1`: what the server does with the dSYM.
    func testReturnAddressResolvesInTheImage() throws {
        let frames = vitalsProbeCaller()
        let t = table()
        let (image, offset) = try XCTUnwrap(t.firstAppFrame(frames, skip: 0))
        XCTAssertEqual(image.start, UInt(bitPattern: #dsohandle), "__TEXT starts at the mach header")
        XCTAssertEqual(offset, UInt64(frames[0] - image.start), "offset = pc - slide - vmaddr = pc - header")
        XCTAssertEqual(image.image.name, (executable as NSString).lastPathComponent)
        XCTAssertEqual(image.image.kind, "macho")
        #if arch(arm64)
        XCTAssertEqual(image.image.arch, "arm64")
        #else
        XCTAssertEqual(image.image.arch, "x86_64")
        #endif
        XCTAssertTrue(image.image.debugId.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil)

        guard let xcrun = which("xcrun") else { throw XCTSkip("xcrun not found (macOS only)") }
        let dump = try XCTUnwrap(runTool(xcrun, ["dwarfdump", "--uuid", executable]))
        let uuids = dump.split(separator: "\n").compactMap { line -> (String, String)? in
            let parts = line.split(separator: " ")
            guard parts.count >= 3, parts[0] == "UUID:" else { return nil }
            return (parts[1].replacingOccurrences(of: "-", with: "").lowercased(), parts[2].trimmingCharacters(in: CharacterSet(charactersIn: "()")))
        }
        XCTAssertTrue(uuids.contains { $0.0 == image.image.debugId && $0.1 == image.image.arch }, "\(uuids) vs \(image.image)")

        let address = image.textVMAddr + offset - 1
        let symbol = try XCTUnwrap(runTool(xcrun, ["atos", "-o", executable, "-arch", image.image.arch!, String(format: "0x%llx", address)]))
        XCTAssertTrue(symbol.contains("vitalsProbeCaller"), symbol)
    }

    /// An executable linked at 0x100000000: the slide is taken out, so an address `n` bytes into
    /// `__TEXT` is offset `n` whatever ASLR chose.
    func testSlideIsTakenOut() throws {
        // The process's executable (MH_EXECUTE), wherever dyld lists it.
        let index = try XCTUnwrap((0..<_dyld_image_count()).first { _dyld_get_image_header($0)?.pointee.filetype == UInt32(MH_EXECUTE) })
        let header = try XCTUnwrap(_dyld_get_image_header(index))
        let path = String(cString: _dyld_get_image_name(index))
        let image = try XCTUnwrap(MachOImage.read(header: UnsafeRawPointer(header), slide: _dyld_get_image_vmaddr_slide(index), path: path))
        XCTAssertEqual(image.textVMAddr, 0x1_0000_0000)
        XCTAssertEqual(image.start, UInt(bitPattern: header))
        XCTAssertEqual(image.offset(of: image.start + 0x1234), 0x1234)
        XCTAssertTrue(image.contains(image.start + 0x1234))
        XCTAssertFalse(image.contains(image.start + UInt(image.textSize)))
        XCTAssertFalse(image.contains(image.start - 1))
    }

    func testSkipsTheReportersFramesThenTakesTheFirstAppFrame() throws {
        let t = table()
        let app = vitalsProbeCaller()[0]
        let system = UInt(bitPattern: unsafeBitCast(strlen as @convention(c) (UnsafePointer<CChar>) -> Int, to: UnsafeRawPointer.self))
        XCTAssertNil(t.image(containing: system), "system images are never app images")
        // [reporter frame, system, system, app]: skip 1 → the app frame.
        let (_, offset) = try XCTUnwrap(t.firstAppFrame([app, system, system, app + 4], skip: 1))
        XCTAssertEqual(offset, UInt64(app + 4 - UInt(bitPattern: #dsohandle)))
        XCTAssertNil(t.firstAppFrame([app, system], skip: 1), "no app frame: no native site")
        // Inside a UIView animation block: [reporter, UIKit, block body, UIKit animate, caller].
        let block = t.callSite([app, system, app + 8, app + 12, system, system, app + 16], skip: 1, inBlock: true)
        XCTAssertEqual(block?.offset, UInt64(app + 16 - UInt(bitPattern: #dsohandle)), "the caller of UIView.animate")
        let noCaller = t.callSite([app, system, app + 8, system], skip: 1, inBlock: true)
        XCTAssertEqual(noCaller?.offset, UInt64(app + 8 - UInt(bitPattern: #dsohandle)), "no caller above: the block")
        let direct = t.callSite([app, app + 20, system, app + 24], skip: 1, inBlock: true)
        XCTAssertEqual(direct?.offset, UInt64(app + 20 - UInt(bitPattern: #dsohandle)), "app code added it directly")
        XCTAssertNil(t.firstAppFrame([app], skip: 3))
    }

    func testFileNames() {
        XCTAssertEqual(MachOImage.fileName("/private/var/containers/Bundle/Application/X/Acme.app/Acme"), "Acme")
        XCTAssertEqual(MachOImage.fileName("/var/x/Acme.app/Frameworks/AcmeUI.framework/AcmeUI"), "AcmeUI.framework/AcmeUI")
        XCTAssertEqual(MachOImage.fileName("/var/x/Acme.app/Frameworks/libz2.dylib"), "libz2.dylib")
        XCTAssertEqual(MachOImage.arch(cpu: CPU_TYPE_ARM64, subtype: 2), "arm64e")
        XCTAssertEqual(MachOImage.arch(cpu: CPU_TYPE_ARM64, subtype: 0), "arm64")
    }
}
