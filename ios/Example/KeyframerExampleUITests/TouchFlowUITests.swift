import XCTest

/// Real touches for the inspector to record: run it while `bun Tools/editor.ts touches` records
/// (see README, "End-to-end check").
final class TouchFlowUITests: XCTestCase {
    func testTouchesDragAndNavigation() throws {
        let app = XCUIApplication()
        // A relay on another port: `TEST_RUNNER_KEYFRAMER_INSPECTOR_PORT=<port> xcodebuild test ...`.
        if let port = ProcessInfo.processInfo.environment["KEYFRAMER_INSPECTOR_PORT"] { app.launchEnvironment["KEYFRAMER_INSPECTOR_PORT"] = port }
        app.launch()
        // Time for the app to connect and the editor to start recording.
        sleep(3)
        app.buttons["bounce"].tap()
        sleep(1)
        let card = app.otherElements["Card"]
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let start = card.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        start.press(forDuration: 0.2, thenDragTo: start.withOffset(CGVector(dx: 90, dy: 70)))
        sleep(1)
        app.scrollViews["chips"].swipeLeft()
        sleep(1)
        app.buttons["push"].tap()
        sleep(2)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        sleep(2)
    }
}
