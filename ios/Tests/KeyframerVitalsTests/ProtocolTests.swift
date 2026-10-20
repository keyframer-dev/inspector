import Foundation
import XCTest
@testable import KeyframerVitals

final class ProtocolTests: XCTestCase {
    func testBuckets() {
        let expected = [0: 0, 1: 1, 2: 2, 3: 3, 4: 3, 5: 4, 8: 4, 9: 5, 16: 5, 17: 6, 32: 6, 33: 7, 500: 7]
        for (missed, bucket) in expected { XCTAssertEqual(Vitals.bucket(missed: missed), bucket, "missed \(missed)") }
    }

    func testSiteRefsRoundTrip() throws {
        let refs: [VitalsSiteRef] = [
            .name(name: "card-expand", type: nil),
            .name(name: "card", type: "FeedCard"),
            .native(image: 0, offset: 74565, type: "CardView"),
            .source(file: "app/feed.tsx", line: 42, column: 9),
            .hashed(hash: "a1b2c3d4e5f6"),
            .jvm(className: "a.b", method: "c", line: nil, file: nil),
        ]
        for ref in refs {
            let data = try JSONEncoder().encode(ref)
            XCTAssertEqual(try JSONDecoder().decode(VitalsSiteRef.self, from: data), ref)
        }
        let native = try JSONSerialization.jsonObject(with: JSONEncoder().encode(refs[2])) as! [String: Any]
        XCTAssertEqual(native["kind"] as? String, "native")
        XCTAssertEqual(native["offset"] as? Int, 74565)
        let named = try JSONSerialization.jsonObject(with: JSONEncoder().encode(refs[0])) as! [String: Any]
        XCTAssertNil(named["type"], "absent optionals are left out, never null")
    }

    func testReportShape() throws {
        let report = sampleReport()
        let data = try report.encoded()
        XCTAssertLessThan(data.count, Vitals.maxBytes)
        let json = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(json["format"] as? String, "keyframer-vitals")
        XCTAssertEqual(json["version"] as? Int, 1)
        XCTAssertEqual(Set(json.keys), ["format", "version", "app", "sdk", "device", "display", "state", "session", "screens", "sites", "worst", "images"])
        let screens = json["screens"] as! [[String: Any]]
        XCTAssertEqual(screens.map { $0["name"] as? String }, ["FeedViewController", "Profile [email] [number]"])
        let js = (screens[0]["threads"] as! [String: Any])["js"] as! [String: Any]
        XCTAssertEqual((js["hist"] as! [Int]).count, 8)
        XCTAssertEqual((js["hist"] as! [Int]).reduce(0, +), js["frames"] as? Int)
        XCTAssertTrue((screens[1]["threads"] as! [String: Any]).isEmpty, "a screen without frames has no thread stats")
        let images = json["images"] as! [[String: Any]]
        XCTAssertEqual(images.first?["debugId"] as? String, "4c4c44e05555314c8b8a7c3a7e5c0e1a")
        let decoded = try JSONDecoder().decode(VitalsReport.self, from: data)
        XCTAssertEqual(decoded, report)
    }

    /// The golden report the React Native engineer writes for iOS: this decoder reads it, and this
    /// encoder writes the same keys at every level it has.
    func testMatchesGoldenFixture() throws {
        guard let url = protocolFile("fixtures/vitals/report-ios.json") else {
            throw XCTSkip("fixtures/vitals/report-ios.json is not written yet")
        }
        let data = try Data(contentsOf: url)
        let golden = try JSONDecoder().decode(VitalsReport.self, from: data)
        XCTAssertEqual(golden.app.platform, "ios")
        let reencoded = try JSONSerialization.jsonObject(with: golden.encoded())
        let original = try JSONSerialization.jsonObject(with: data)
        XCTAssertEqual(Self.normalized(reencoded), Self.normalized(original), "decode + encode keeps the golden report as it is")

        // Our own report uses the golden's keys (it may leave optional ones out, never add others).
        let ours = try JSONSerialization.jsonObject(with: sampleReport().encoded())
        var problems: [String] = []
        Self.compareKeys(ours, original, path: "report", problems: &problems)
        XCTAssertEqual(problems, [])
    }

    /// The shared validator (`vitals-validate.ts`, what ingest runs) accepts this encoder's reports.
    func testSharedValidatorAccepts() throws {
        guard let validator = protocolFile("src/vitals-validate.ts") ?? protocolFile("vitals-validate.ts") else { throw XCTSkip("vitals-validate.ts not found") }
        guard let bun = which("bun") else { throw XCTSkip("bun is not installed") }
        let script = """
        import { validateVitalsReport } from '\(validator.path)'
        const text = await Bun.stdin.text()
        const res = validateVitalsReport(JSON.parse(text))
        console.log(JSON.stringify(res.ok ? { ok: true } : res))
        """
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("kfv-validate-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("validate.ts")
        try script.write(to: file, atomically: true, encoding: .utf8)
        let out = runTool(bun, [file.path], input: try sampleReport().encoded())
        XCTAssertEqual(out?.trimmingCharacters(in: .whitespacesAndNewlines), #"{"ok":true}"#)
    }

    static func normalized(_ x: Any) -> NSObject {
        (x as? NSObject) ?? NSNull()
    }

    static func compareKeys(_ ours: Any, _ golden: Any, path: String, problems: inout [String]) {
        if let o = ours as? [String: Any], let g = golden as? [String: Any] {
            // Maps keyed by data (threads) only need matching value shapes.
            let isMap = path.hasSuffix(".threads")
            for (k, v) in o {
                if let gv = g[k] {
                    compareKeys(v, gv, path: "\(path).\(k)", problems: &problems)
                } else if isMap, let any = g.values.first {
                    compareKeys(v, any, path: "\(path).\(k)", problems: &problems)
                } else if !isMap, !optionalKeys.contains(k) {
                    problems.append("\(path).\(k) is not in the golden report")
                }
            }
        } else if let o = ours as? [Any], let g = golden as? [Any], !g.isEmpty {
            for (i, v) in o.enumerated() {
                // Site refs differ by kind: compare with a golden entry of the same kind when there is one.
                let match = g.first { gv in
                    guard let kind = ((v as? [String: Any])?["ref"] as? [String: Any])?["kind"] as? String else { return true }
                    return ((gv as? [String: Any])?["ref"] as? [String: Any])?["kind"] as? String == kind
                } ?? g[0]
                compareKeys(v, match, path: "\(path)[\(i)]", problems: &problems)
            }
        }
    }

    /// Optional protocol fields a golden report may happen to leave out.
    static let optionalKeys: Set<String> = ["type", "key", "component", "prop", "runsReduceMotion", "afterNavMs", "images", "arch", "build", "framework", "id", "model", "tier", "memoryGb", "adaptive", "reduceMotion", "lowPower", "thermal", "debugId"]
}
