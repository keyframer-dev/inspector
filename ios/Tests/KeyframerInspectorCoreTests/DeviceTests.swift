import XCTest
@testable import KeyframerInspectorCore

/// What the hello says about the device, and what it must never say.
final class DeviceTests: XCTestCase {
    private let simulatorEnvironment = [
        "SIMULATOR_UDID": "D95F3325-AE85-4445-9CB9-2D3C90388D88",
        "SIMULATOR_DEVICE_NAME": "iPhone 17 Pro",
        "SIMULATOR_MODEL_IDENTIFIER": "iPhone18,1",
    ]

    func testASimulatorSaysWhichOne() {
        let device = InspectorDevice.describe(.simulator, environment: simulatorEnvironment, model: "arm64")
        XCTAssertEqual(device, InspectorDevice(name: "iPhone 17 Pro", model: "iPhone18,1", id: "D95F3325-AE85-4445-9CB9-2D3C90388D88", simulator: true))
        XCTAssertEqual(InspectorDevice.describe(.simulator, environment: ["SIMULATOR_UDID": ""], model: nil), InspectorDevice(simulator: true), "empty values are left out")
    }

    // Launched with no SIMULATOR_* variables: the UDID from where the app lives, the name from the
    // simulator's device.plist, never the path (it holds the Mac's user name).
    private let udid = "E0289221-D5FE-475A-A14A-A7B9392E4707"
    private var home: String { "/Users/someone/Library/Developer/CoreSimulator/Devices/\(udid)/data/Containers/Data/Application/0C3F2B1E-8A4D-4E6B-9F12-3456789ABCDE" }
    private var bundle: String { "/Users/someone/Library/Developer/CoreSimulator/Devices/\(udid)/data/Containers/Bundle/Application/9A8B7C6D-5E4F-4321-ABCD-EF0123456789/KeyframerExample.app" }

    func testASimulatorWithoutItsVariablesReadsItsFolder() throws {
        var asked: [String] = []
        let device = InspectorDevice.describe(.simulator, environment: [:], model: "arm64", paths: [home, bundle]) { path in
            asked.append(path)
            return ["name": "iPhone 17 Pro", "UDID": self.udid, "deviceType": "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro"]
        }
        XCTAssertEqual(device, InspectorDevice(name: "iPhone 17 Pro", id: udid, simulator: true), "no model: device.plist has no identifier, and never the Mac's arm64")
        XCTAssertEqual(asked, ["/Users/someone/Library/Developer/CoreSimulator/Devices/\(udid)/device.plist"])
        let json = String(decoding: try JSONEncoder().encode(device), as: UTF8.self)
        XCTAssertFalse(json.contains("someone") || json.contains("/Users"), "the path never leaves: \(json)")
    }

    func testTheFolderComesFromTheBundleWhenTheHomeIsElsewhere() {
        let device = InspectorDevice.describe(.simulator, environment: [:], model: nil, paths: ["/var/empty", bundle]) { _ in nil }
        XCTAssertEqual(device, InspectorDevice(id: udid, simulator: true), "no device.plist to read: the UDID alone")
        // A test device set (Xcode's XCTestDevices) lays devices out the same way.
        let testSet = "/Users/someone/Library/Developer/XCTestDevices/\(udid.lowercased())/data/Containers/Data/Application/0C3F2B1E-8A4D-4E6B-9F12-3456789ABCDE"
        XCTAssertEqual(InspectorDevice.describe(.simulator, environment: [:], model: nil, paths: [testSet]).id, udid)
    }

    func testASimulatorThatCannotTellStillSaysItIsOne() {
        XCTAssertEqual(InspectorDevice.describe(.simulator, environment: [:], model: "arm64", paths: ["/private/var/mobile"]), InspectorDevice(simulator: true))
        // The variables win over the folder when both are there; the model identifier is used either way.
        XCTAssertEqual(InspectorDevice.describe(.simulator, environment: simulatorEnvironment, model: nil, paths: [home]) { _ in ["name": "Other"] }.name, "iPhone 17 Pro")
        XCTAssertEqual(InspectorDevice.describe(.simulator, environment: ["SIMULATOR_MODEL_IDENTIFIER": "iPhone18,1"], model: nil, paths: [home]) { _ in nil }.model, "iPhone18,1")
    }

    /// A physical device's name is usually its owner's, and recordings get shared: only the model goes.
    func testADeviceNeverSaysItsName() throws {
        let device = InspectorDevice.describe(.device, environment: simulatorEnvironment, model: "iPhone17,1", paths: [home]) { _ in ["name": "Catalin's iPhone"] }
        XCTAssertEqual(device, InspectorDevice(model: "iPhone17,1", simulator: false), "neither the environment nor any path is read")
        let json = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(device))
        XCTAssertEqual(json, ["model": "iPhone17,1", "simulator": false])
    }

    func testAMacSaysItsModelOnly() {
        XCTAssertEqual(InspectorDevice.describe(.mac, environment: simulatorEnvironment, model: "Mac15,6"), InspectorDevice(model: "Mac15,6"))
    }

    /// The hello carries it, and leaves it out when there is none.
    func testTheHelloCarriesIt() throws {
        func json(_ hello: AppHello) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(InspectorJSON.encode(.appHello(hello)).utf8)) }
        XCTAssertEqual(try json(AppHello(app: "A", platform: "ios", device: InspectorDevice(model: "iPhone17,1", simulator: false)))["device"], ["model": "iPhone17,1", "simulator": false])
        XCTAssertNil(try json(AppHello(app: "A", platform: "ios"))["device"])
    }

    /// On a simulator: the fallback, run against this process's real folder and device.plist with the
    /// environment taken away, finds the same simulator the variables name.
    func testTheFallbackFindsThisSimulator() throws {
        #if targetEnvironment(simulator)
        let env = ProcessInfo.processInfo.environment
        let found = InspectorDevice.describe(
            .simulator, environment: [:], model: nil, paths: [NSHomeDirectory(), Bundle.main.bundlePath],
            readPlist: { NSDictionary(contentsOfFile: $0) as? [String: Any] }
        )
        XCTAssertEqual(found.simulator, true)
        XCTAssertNil(found.model)
        if let udid = env["SIMULATOR_UDID"] { XCTAssertEqual(found.id, udid) } else { XCTAssertNotNil(found.id) }
        if let name = env["SIMULATOR_DEVICE_NAME"] { XCTAssertEqual(found.name, name) } else { XCTAssertNotNil(found.name) }
        #else
        throw XCTSkip("a simulator's folder only exists on a simulator")
        #endif
    }

    func testThisProcess() {
        let device = InspectorDevice.current
        #if targetEnvironment(simulator)
        XCTAssertEqual(device.simulator, true)
        #else
        // macOS (swift test): the Mac's model, nothing that names it.
        XCTAssertNil(device.name)
        XCTAssertNil(device.id)
        XCTAssertNil(device.simulator)
        XCTAssertTrue(device.model?.hasPrefix("Mac") == true || device.model?.contains(",") == true, String(describing: device.model))
        #endif
    }
}
