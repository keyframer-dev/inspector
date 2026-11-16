import QuartzCore
import XCTest
@testable import KeyframerInspectorCore

final class LaunchTests: XCTestCase {
    func testLaunchArgumentsAndTheEnvironment() {
        let args = LaunchOptions(environment: [:], arguments: ["keyframer": "YES", "keyframerHost": "192.168.1.20", "keyframerPort": "18797", "keyframerSystem": "YES"])
        XCTAssertEqual(args.enabled, true)
        XCTAssertFalse(args.enabledByEnvironment, "a launch argument does not turn a release build on")
        XCTAssertEqual(args.host, "192.168.1.20")
        XCTAssertEqual(args.port, 18797)
        XCTAssertEqual(args.reportSystemAnimations, true)
        XCTAssertTrue(args.asked)

        let env = LaunchOptions(environment: ["KEYFRAMER_INSPECTOR": "0", "KEYFRAMER_INSPECTOR_HOST": "10.0.0.2"], arguments: ["keyframer": "YES", "keyframerHost": "192.168.1.20"])
        XCTAssertEqual(env.enabled, false, "the environment wins")
        XCTAssertEqual(env.host, "10.0.0.2")
        XCTAssertFalse(env.asked, "off wins over a host")

        let host = LaunchOptions(environment: [:], arguments: ["keyframerHost": "192.168.1.20"])
        XCTAssertNil(host.enabled)
        XCTAssertTrue(host.asked, "a host is asking for it")

        let none = LaunchOptions(environment: [:], arguments: ["keyframerHost": " ", "keyframerPort": "x", "keyframerSystem": "maybe"])
        XCTAssertNil(none.host)
        XCTAssertNil(none.port)
        XCTAssertNil(none.reportSystemAnimations)
        XCTAssertFalse(none.asked)
        XCTAssertTrue(LaunchOptions(environment: ["KEYFRAMER_INSPECTOR": "1"], arguments: [:]).enabledByEnvironment)
        XCTAssertEqual(LaunchOptions(environment: [:], arguments: ["keyframer": NSNumber(value: false)]).enabled, false)
    }

    /// The route is the latest named screen still shown; when it goes, the one under it.
    func testDeclaredScreens() {
        var screens = DeclaredScreens()
        let (home, settings, sheet) = (UUID(), UUID(), UUID())
        XCTAssertNil(screens.top)
        screens.appear(home, name: "Home")
        screens.appear(settings, name: "Settings")
        XCTAssertEqual(screens.top, "Settings")
        // A push: the covered screen disappears, in whichever order SwiftUI calls them.
        screens.disappear(home)
        XCTAssertEqual(screens.top, "Settings")
        screens.appear(home, name: "Home")
        screens.disappear(settings)
        XCTAssertEqual(screens.top, "Home")
        screens.appear(sheet, name: "History")
        screens.rename(sheet, to: "History 2")
        XCTAssertEqual(screens.top, "History 2")
        screens.disappear(sheet)
        XCTAssertEqual(screens.top, "Home")
        screens.disappear(home)
        XCTAssertTrue(screens.isEmpty)
    }

    /// Animations that move no key path are named by what they do, and become no signals.
    func testAnimationsWithoutAKeyPath() throws {
        XCTAssertEqual(AnimationInfo.propertyKeyPaths(of: CABasicAnimation(keyPath: "opacity")), ["opacity"])
        let group = CAAnimationGroup()
        group.animations = [CABasicAnimation(keyPath: "position"), CATransition()]
        XCTAssertEqual(AnimationInfo.propertyKeyPaths(of: group), ["position"])
        XCTAssertEqual(AnimationInfo.keyPath(of: CATransition()), "transition")
        XCTAssertEqual(AnimationInfo.propertyKeyPaths(of: CATransition()), [])
        // Core Animation's private match animations (iOS 26's glass follows its buttons with them).
        let cls = try XCTUnwrap(NSClassFromString("CAMatchMoveAnimation") as? CAAnimation.Type)
        let match = cls.init()
        XCTAssertEqual(AnimationInfo.keyPath(of: match), "matchMove")
        XCTAssertEqual(AnimationInfo.propertyKeyPaths(of: match), [])
    }
}
