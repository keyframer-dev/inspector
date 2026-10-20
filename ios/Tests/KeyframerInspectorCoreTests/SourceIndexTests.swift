import XCTest
@testable import KeyframerInspectorCore

/// N33b: a native call site (no line at runtime) gets the file and line of its function's declaration.
final class SourceIndexTests: XCTestCase {
    let cards = """
    import UIKit

    // class Commented { func fade() {} }
    final class CardsViewController: UIViewController {
        let card = UIView()
        /* func bounce() { } */
        override func viewDidLoad() {
            super.viewDidLoad()
            let s = "func spin() {"
        }

        @objc func fade() {
            UIView.animate(withDuration: 0.4) { self.card.alpha = 0 }
        }

        class func make() -> CardsViewController { .init() }

        struct Badge {
            func pulse<T>(_ t: T) {}
        }
    }

    extension CardsViewController {
        func spin() {
            UIView.animate(withDuration: 0.8) {}
        }
    }
    """

    func index() -> SourceIndex {
        var i = SourceIndex()
        i.add(source: cards, file: "KeyframerExample/CardsViewController.swift")
        i.add(source: "struct Other {\n    func fade() {}\n}\n", file: "KeyframerExample/Other.swift")
        return i
    }

    func at(_ display: String, type: String? = nil) -> SourceIndex.Location? {
        index().locate(SymbolName(module: "KeyframerExample", type: type, display: display))
    }

    func testFunctionsAndClosures() {
        XCTAssertEqual(at("closure #1 in CardsViewController.fade()"), .init(file: "KeyframerExample/CardsViewController.swift", line: 12))
        XCTAssertEqual(at("CardsViewController.viewDidLoad()")?.line, 7)
        XCTAssertEqual(at("closure #1 in closure #2 in CardsViewController.spin()")?.line, 24, "an extension counts as its type")
        XCTAssertEqual(at("CardsViewController.fade:")?.line, 12, "an Objective-C selector")
        XCTAssertEqual(at("static CardsViewController.make()")?.line, 16)
        XCTAssertEqual(at("CardsViewController.Badge.pulse<A>(_:)")?.line, 19, "a nested type")
        XCTAssertEqual(at("Other.fade()"), .init(file: "KeyframerExample/Other.swift", line: 2), "another type's fade")
    }

    func testWhatItDoesNotKnow() {
        XCTAssertNil(at("CardsViewController.bounce()"), "only in a comment")
        XCTAssertNil(at("CardsViewController.card.getter"))
        XCTAssertNil(at("Commented.fade()"))
        XCTAssertNil(at("Elsewhere.fade()"))
    }

    func testBuildingFromADisk() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kf-source-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("App/DerivedData"), withIntermediateDirectories: true)
        try cards.write(to: root.appendingPathComponent("App/Cards.swift"), atomically: true, encoding: .utf8)
        try "struct Stale { func fade() {} }".write(to: root.appendingPathComponent("App/DerivedData/Stale.swift"), atomically: true, encoding: .utf8)
        let built = try SourceIndex.build(root: root.path).get()
        XCTAssertEqual(built.locate(SymbolName(module: nil, type: nil, display: "closure #1 in CardsViewController.fade()")), .init(file: "App/Cards.swift", line: 12))
        XCTAssertNil(built.locate(SymbolName(module: nil, type: nil, display: "Stale.fade()")), "build products are skipped")
        XCTAssertEqual(SourceIndex.build(root: root.path + "/missing").failure, .unreadable(root.path + "/missing"))
        try FileManager.default.removeItem(at: root.appendingPathComponent("App/Cards.swift"))
        XCTAssertEqual(SourceIndex.build(root: root.path).failure, .noSwiftFiles(root.path))
    }
}

private extension Result {
    var failure: Failure? { if case .failure(let f) = self { return f }; return nil }
}
