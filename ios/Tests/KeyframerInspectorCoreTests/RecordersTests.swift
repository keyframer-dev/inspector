import XCTest
@testable import KeyframerInspectorCore

/// N21: two editors recording at once. One stopping leaves the other's recording running.
final class RecordersTests: XCTestCase {
    func testTheLastRecorderStopsTheRecording() {
        var r = Recorders()
        r.apply(["*"], on: true, recorder: "panel")
        r.apply(["card/position.y"], on: true, recorder: "ci")
        XCTAssertEqual(r.count, 2)
        r.apply(["*"], on: false, recorder: "panel")
        XCTAssertFalse(r.isEmpty, "ci still records")
        XCTAssertFalse(r.recordsAll)
        XCTAssertEqual(r.ids, ["card/position.y"])
        r.apply(["card/position.y"], on: false, recorder: "ci")
        XCTAssertTrue(r.isEmpty, "a recorder left with nothing goes away")
    }

    func testTheUnionAndEverything() {
        var r = Recorders()
        r.apply(["a"], on: true, recorder: "one")
        r.apply(["b"], on: true, recorder: "two")
        XCTAssertEqual(r.ids, ["a", "b"])
        r.apply(["*"], on: true, recorder: "two")
        XCTAssertTrue(r.recordsAll)
        r.apply(["b"], on: false, recorder: "one")
        XCTAssertEqual(r.ids, ["a", "b"], "an id another recorder did not ask for stays")
    }

    /// Requests without a recorder share one anonymous recorder: older editors stop each other, as
    /// before, and nobody else.
    func testOlderEditorsShareOneRecorder() {
        var r = Recorders()
        r.apply(["*"], on: true, recorder: nil)
        r.apply(["*"], on: true, recorder: "mcp")
        r.apply(["*"], on: false, recorder: nil)
        XCTAssertEqual(r.count, 1)
        XCTAssertTrue(r.recordsAll, "the mcp's recording goes on")
        r.apply(["x"], on: true, recorder: nil)
        r.apply(["*"], on: false, recorder: nil)
        r.apply(["*"], on: false, recorder: "mcp")
        XCTAssertTrue(r.isEmpty)
    }

    func testTheLastEditorLeaving() {
        var r = Recorders()
        r.apply(["*"], on: true, recorder: "a")
        r.apply(["*"], on: true, recorder: "b")
        r.removeAll()
        XCTAssertTrue(r.isEmpty)
        // Turning on nothing is not a recorder.
        r.apply([], on: true, recorder: "c")
        XCTAssertTrue(r.isEmpty)
    }
}
