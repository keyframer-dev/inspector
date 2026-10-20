import Foundation
import XCTest
@testable import KeyframerVitals

/// Finds a file of the protocol package from this test file, inside the inspector repository
/// (`packages/protocol/...`) or the public one (`protocol/...`).
func protocolFile(_ relative: String, file: StaticString = #filePath) -> URL? {
    var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
    for _ in 0..<8 {
        for prefix in ["packages/protocol/", "protocol/"] {
            let url = dir.appendingPathComponent(prefix + relative)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        dir.deleteLastPathComponent()
    }
    return nil
}

/// Runs a command, returning its standard output (nil when it failed or is missing).
func runTool(_ launchPath: String, _ args: [String], input: Data? = nil) -> String? {
    #if os(macOS)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: launchPath)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = Pipe()
    if let input {
        let inPipe = Pipe()
        p.standardInput = inPipe
        do { try p.run() } catch { return nil }
        inPipe.fileHandleForWriting.write(input)
        try? inPipe.fileHandleForWriting.close()
    } else {
        do { try p.run() } catch { return nil }
    }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard p.terminationStatus == 0 else { return nil }
    return String(decoding: data, as: UTF8.self)
    #else
    return nil
    #endif
}

func which(_ tool: String) -> String? {
    runTool("/usr/bin/env", ["which", tool])?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        ?? ["/opt/homebrew/bin/\(tool)", "/usr/local/bin/\(tool)", "\(NSHomeDirectory())/.bun/bin/\(tool)"].first { FileManager.default.isExecutableFile(atPath: $0) }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// A store in a fresh temporary folder and UserDefaults suite.
func temporaryStore(now: @escaping () -> Date = Date.init) -> VitalsStore {
    let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("kfv-\(UUID().uuidString)")
    let suite = "kfv-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return VitalsStore(directory: dir, defaults: defaults, now: now)
}

/// A report that exercises every field the iOS reporter sends.
func sampleReport() -> VitalsReport {
    var w = WindowAggregator()
    w.resume(at: 0)
    w.setScreen("FeedViewController", at: 0)
    let image = VitalsImage(debugId: "4c4c44e05555314c8b8a7c3a7e5c0e1a", kind: "macho", name: "Acme", arch: "arm64")
    w.animationStarted(SiteInfo(ref: .native(image: image, offset: 0x1_2345, type: "CardView"), fn: "UIView.animate", prop: "position", component: nil), start: 100, end: 450)
    w.animationStarted(SiteInfo(ref: .name("card-expand", type: nil), fn: "trace", prop: nil, component: nil), start: 120, end: 600, reduceMotion: true)
    var meter = VitalsFrameMeter(hz: 60)
    meter.start(at: 100)
    var t = 100.0
    for gap in [16.7, 16.6, 50.1, 16.7, 16.6, 16.7, 33.4, 16.6, 16.7, 16.7, 800, 16.7] {
        t += gap
        if let f = meter.tick(t) { w.frame(f, at: t, touch: .none) }
    }
    w.setScreen(Mask.screenName("Profile ada@example.com 123456"), at: 2000)
    return w.report(at: 3000, ended: .background, context: .init(
        app: .init(id: "com.acme.app", version: "2.4.0", build: "118", platform: "ios", framework: "UIKit", environment: "production", debugId: nil),
        device: .init(os: "ios", osMajor: 18, model: "iPhone15,3", tier: .high, memoryGb: 6),
        display: .init(hz: 120, adaptive: true, targetHz: 60),
        state: .init(reduceMotion: nil, lowPower: false, thermal: .nominal),
        nonce: Reporter.nonce(), seq: 0, sampleRate: 0.1, reduceMotion: false
    ))
}
