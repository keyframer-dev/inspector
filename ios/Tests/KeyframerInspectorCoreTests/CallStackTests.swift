import XCTest
@testable import KeyframerInspectorCore

final class CallStackTests: XCTestCase {
    // Real lines from an iOS 26 simulator, the example app's UIView.animate spring.
    let lines = [
        "0   KeyframerExample.debug.dylib        0x0000000104d2a1c8 $s18KeyframerInspector12AnimationTapO7willAdd_6forKey2toSo11CAAnimationCSgAG_SSSgSo7CALayerCtFZ + 212",
        // Compiler glue from the inspector's own closures, emitted into the app image, nameless.
        "1   KeyframerExample.debug.dylib        0x0000000104d29d00 $sIeg_ytIegr_TR + 24",
        "1   KeyframerExample.debug.dylib        0x0000000104d29e10 $sSo7CALayerC18KeyframerInspectorE6kf_add_6forKeyySo11CAAnimationC_SSSgtF + 160",
        "2   QuartzCore                          0x000000018c0b1234 _ZN2CA5Layer12add_animationEP11CAAnimationPK10__CFString + 88",
        "3   UIKitCore                           0x0000000185c5e044 -[UIViewAnimationState actionForLayer:forKey:forView:] + 1012",
        "4   UIKitCore                           0x0000000185c6a3c8 +[UIView(UIViewAnimationWithBlocks) _setupAnimationWithDuration:delay:view:options:factory:animations:start:animationStateGenerator:completion:] + 480",
        "5   KeyframerExample.debug.dylib        0x0000000104d10a50 $s16KeyframerExample14ViewControllerC6bounceyyFyycfU_ + 120",
        "6   KeyframerExample.debug.dylib        0x0000000104d10b20 $s16KeyframerExample14ViewControllerC6bounceyyF + 300",
        "7   Some Framework                      0x0000000104d10b20 <redacted> + 12",
        "8   libdyld.dylib                       0x00000001800b1234 start + 4",
    ]

    func testParsesEveryLine() {
        let frames = SymbolFrame.parse(lines: lines)
        XCTAssertEqual(frames.count, lines.count)
        XCTAssertEqual(frames[6].image, "KeyframerExample.debug.dylib")
        XCTAssertEqual(frames[6].address, 0x0000_0001_04d1_0a50)
        XCTAssertEqual(frames[6].offset, 120)
        XCTAssertEqual(frames[4].symbol, "-[UIViewAnimationState actionForLayer:forKey:forView:]")
        XCTAssertEqual(frames[8].image, "Some Framework")
        XCTAssertEqual(frames[8].symbol, "<redacted>")
    }

    func testDemanglesWithTheRuntime() {
        XCTAssertEqual(Demangler.demangle("$s16KeyframerExample14ViewControllerC6bounceyyF"), "KeyframerExample.ViewController.bounce() -> ()")
        XCTAssertEqual(Demangler.demangle("-[UIView foo]"), "-[UIView foo]")
    }

    func testDescribesSwiftAndObjectiveCSymbols() {
        let method = SymbolName.describe("$s16KeyframerExample14ViewControllerC6bounceyyF")
        XCTAssertEqual(method, SymbolName(module: "KeyframerExample", type: "ViewController", display: "ViewController.bounce()"))
        let closure = SymbolName.describe("$s16KeyframerExample14ViewControllerC6bounceyyFyycfU_")
        XCTAssertEqual(closure.display, "closure #1 in ViewController.bounce()")
        XCTAssertEqual(closure.type, "ViewController")
        let objc = SymbolName.describe("-[UIView(UIViewAnimationWithBlocks) animateWithDuration:animations:]")
        XCTAssertEqual(objc.type, "UIView")
        XCTAssertEqual(objc.display, "UIView.animateWithDuration:animations:")
        let tail = SymbolName.describe("@objc KeyframerExample.ViewController.tapped(_: __C.UIButton) -> ()")
        XCTAssertEqual(tail.display, "ViewController.tapped(_: __C.UIButton)")
        let generic = SymbolName.describe("KeyframerExample.Box<A>.run(closure: (Swift.Int) -> ()) -> ()")
        XCTAssertEqual(generic.type, "Box")
        XCTAssertEqual(generic.display, "Box.run(closure: (Swift.Int) -> ())")
        let local = SymbolName.describe("closure #1 in press #1 (_: Swift.String, wait: Swift.UInt64) -> @Swift.MainActor () async throws -> () in KeyframerExample.SceneDelegate.(registerScenarios in _1339DD0A52724B7AE6F634F58874A689)(__C.UINavigationController) -> ()")
        XCTAssertEqual(local.display, "closure #1 in press #1 in SceneDelegate.registerScenarios(__C.UINavigationController)")
        XCTAssertEqual(local.type, "SceneDelegate")
        let resume = SymbolName.describe("(1) await resume partial function for KeyframerExample.Loader.load() async -> ()")
        XCTAssertEqual(resume.display, "Loader.load() async")
    }

    func testRecognizesCompilerGlue() {
        XCTAssertTrue(SymbolName.describe("$sIeg_ytIegr_TR").isThunk)
        XCTAssertTrue(SymbolName.describe("partial apply forwarder for reabstraction thunk helper ()").isThunk)
        XCTAssertTrue(SymbolName(module: nil, type: nil, display: "@escaping @callee_guaranteed ()").isThunk)
        XCTAssertFalse(SymbolName.describe("$s16KeyframerExample14ViewControllerC6bounceyyF").isThunk)
    }

    /// UIKit animating on its own (a button highlight) has only the app's `@main` under it.
    func testTheEntryPointIsNotACallSite() {
        let lines = [
            "0   QuartzCore                          0x000000018c0b1234 _ZN2CA5Layer12add_animationEP11CAAnimationPK10__CFString + 88",
            "1   UIKitCore                           0x0000000185c5e044 -[UIButton _setHighlighted:animated:] + 200",
            "2   KeyframerExample.debug.dylib        0x0000000104d10b20 $sSo21UIApplicationDelegateP5UIKitE4mainyyFZ + 120",
            "3   KeyframerExample.debug.dylib        0x0000000104d10c00 main + 32",
        ]
        XCTAssertTrue(SymbolName.describe("$sSo21UIApplicationDelegateP5UIKitE4mainyyFZ").isEntryPoint)
        XCTAssertTrue(SymbolName.describe("__debug_main_executable_dylib_entry_point").isEntryPoint)
        XCTAssertNil(CallSiteResolver(executable: "KeyframerExample").resolve(SymbolFrame.parse(lines: lines)))
    }

    /// The first app frame that is not the inspector: the animation block, not the swizzle.
    func testResolvesTheAppFrame() throws {
        let resolver = CallSiteResolver(executable: "KeyframerExample")
        let site = try XCTUnwrap(resolver.resolve(SymbolFrame.parse(lines: lines)))
        XCTAssertEqual(site.frame.index, 5, "the frame under the animation block, not the glue above kf_add")
        XCTAssertEqual(site.name.display, "closure #1 in ViewController.bounce()")
        XCTAssertEqual(site.id, "closure #1 in ViewController.bounce()", "no return offset: stable across builds and per property")
        XCTAssertTrue(resolver.isAppFrame(SymbolFrame(index: 0, image: "KeyframerExample", address: 0, symbol: "x", offset: 0)))
        XCTAssertNil(CallSiteResolver(executable: "Other").resolve(SymbolFrame.parse(lines: lines)))
    }

    /// Protocol frames: no lines yet, image + offset for atos, library frames collapsed.
    func testStackFramesForTheProtocol() {
        let resolver = CallSiteResolver(executable: "KeyframerExample")
        let frames = resolver.stackFrames(SymbolFrame.parse(lines: lines), imageOffset: { Int($0 & 0xFFFF) })
        XCTAssertFalse(frames.contains { $0.symbol?.contains("KeyframerInspector") == true })
        let app = frames.first { $0.methodName == "closure #1 in ViewController.bounce()" }
        XCTAssertEqual(app?.lineNumber, 0)
        XCTAssertEqual(app?.image, "KeyframerExample.debug.dylib")
        XCTAssertEqual(app?.offset, 0x0a50)
        XCTAssertEqual(app?.symbol, "$s16KeyframerExample14ViewControllerC6bounceyyFyycfU_")
        XCTAssertNil(app?.collapse)
        XCTAssertEqual(frames.first { $0.image == "UIKitCore" }?.collapse, true)
        // A real address in this process resolves through dladdr.
        let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "swift_demangle")
        XCTAssertNotNil(ImageOffset.of(UInt64(UInt(bitPattern: sym))))
        XCTAssertNil(ImageOffset.of(0))
    }

    /// Formatted the way the panel's parseStack reads V8 stacks, the inspector's own frames dropped.
    func testFormatsAStackThePanelCanParse() {
        let text = CallSiteResolver(executable: "KeyframerExample").formatStack(SymbolFrame.parse(lines: lines))
        let rows = text.split(separator: "\n").map(String.init)
        XCTAssertEqual(rows.first, "Error")
        XCTAssertFalse(text.contains("AnimationTap"))
        XCTAssertTrue(rows.contains("    at closure #1 in ViewController.bounce() (KeyframerExample.debug.dylib+0x78:0:0)"))
        let v8 = try! NSRegularExpression(pattern: #"^\s*at (?:(.+?) \()?(?:address at )?(.+?):(\d+):(\d+)\)?\s*$"#)
        for row in rows.dropFirst() {
            XCTAssertNotNil(v8.firstMatch(in: row, range: NSRange(row.startIndex..., in: row)), row)
        }
    }
}
