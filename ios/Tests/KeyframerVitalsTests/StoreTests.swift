import Foundation
import XCTest
@testable import KeyframerVitals

final class StoreTests: XCTestCase {
    func testRetryQueueLimits() {
        var now = Date(timeIntervalSince1970: 1_000_000)
        let store = temporaryStore { now }
        defer { try? FileManager.default.removeItem(at: store.directory) }
        for i in 0..<7 {
            store.enqueue(Data("report \(i)".utf8))
            now += 1
        }
        XCTAssertEqual(store.pending().map { String(decoding: $0.body, as: UTF8.self) }, (2..<7).map { "report \($0)" }, "at most 5, the oldest dropped")

        store.clearAll()
        store.enqueue(Data(count: 60 * 1024))
        now += 1
        store.enqueue(Data(count: 50 * 1024))
        XCTAssertEqual(store.pending().map(\.body.count), [50 * 1024], "at most 100 KB")

        now += 7 * 86400
        XCTAssertEqual(store.pending(), [], "nothing older than 7 days")
    }

    func testRemoveAndCheckpoint() {
        let store = temporaryStore()
        defer { try? FileManager.default.removeItem(at: store.directory) }
        let a = store.enqueue(Data("a".utf8))
        store.enqueue(Data("b".utf8))
        store.remove(a)
        XCTAssertEqual(store.pending().map { String(decoding: $0.body, as: UTF8.self) }, ["b"])
        store.writeCheckpoint(Data("cp".utf8))
        XCTAssertEqual(store.takeCheckpoint(), Data("cp".utf8))
        XCTAssertNil(store.takeCheckpoint(), "taken once")
        store.writeCheckpoint(Data("cp".utf8))
        store.clearAll()
        XCTAssertNil(store.takeCheckpoint())
        XCTAssertEqual(store.pending(), [])
    }

    func testSessionsPerDay() {
        var now = Date(timeIntervalSince1970: 1_000_000)
        let store = temporaryStore { now }
        XCTAssertEqual((0..<5).map { _ in store.takeSessionSlot() }, [true, true, true, false, false])
        now += 86400
        XCTAssertTrue(store.takeSessionSlot(), "a new day")
    }

    func testConfigAndStop() throws {
        let store = temporaryStore()
        XCTAssertNil(store.config())
        let url = try XCTUnwrap(protocolFile("fixtures/vitals/config.json"))
        let config = try JSONDecoder().decode(VitalsConfig.self, from: Data(contentsOf: url))
        store.saveConfig(config)
        XCTAssertEqual(store.config()?.config, config)
        XCTAssertNil(store.stopUntil)
        store.stopUntil = Date(timeIntervalSince1970: 5)
        XCTAssertEqual(store.stopUntil, Date(timeIntervalSince1970: 5))
    }
}

final class PolicyTests: XCTestCase {
    func testMinSdk() {
        XCTAssertTrue(Policy.isBelow("0.9.3", minimum: "1.0.0"))
        XCTAssertTrue(Policy.isBelow("1.0", minimum: "1.0.1"))
        XCTAssertFalse(Policy.isBelow("1.0.0", minimum: "1.0.0"))
        XCTAssertFalse(Policy.isBelow("1.2.0-beta.1", minimum: "1.1.9"))
        XCTAssertFalse(Policy.isBelow("1.10.0", minimum: "1.9.0"))
        var config = VitalsConfig.defaults
        config.minSdk = ["ios": "9.0.0", "android": "0.0.1"]
        XCTAssertFalse(Policy.allows(config: config, stopUntil: nil, now: Date()))
        config.minSdk = ["ios": Vitals.sdkVersion, "android": "99.0.0"]
        XCTAssertTrue(Policy.allows(config: config, stopUntil: nil, now: Date()))
    }

    func testStopAndEnabled() {
        let now = Date()
        XCTAssertFalse(Policy.allows(config: .defaults, stopUntil: now + 10, now: now))
        XCTAssertTrue(Policy.allows(config: .defaults, stopUntil: now - 10, now: now))
        var off = VitalsConfig.defaults
        off.enabled = false
        XCTAssertFalse(Policy.allows(config: off, stopUntil: nil, now: now))
    }

    func testFetchAtMostDaily() {
        let now = Date()
        XCTAssertTrue(Policy.shouldFetch(fetchedAt: nil, ttlSec: nil, now: now))
        XCTAssertFalse(Policy.shouldFetch(fetchedAt: now - 3600, ttlSec: 300, now: now), "a 300 s ttl still waits a day")
        XCTAssertTrue(Policy.shouldFetch(fetchedAt: now - 86400, ttlSec: 300, now: now))
        XCTAssertFalse(Policy.shouldFetch(fetchedAt: now - 86400, ttlSec: 2 * 86400, now: now))
    }

    func testSampling() {
        XCTAssertTrue(Policy.sample(rate: 0.1, random: 0.05))
        XCTAssertFalse(Policy.sample(rate: 0.1, random: 0.1))
        XCTAssertFalse(Policy.sample(rate: 0, random: 0))
        XCTAssertTrue(Policy.sample(rate: 1, random: 0.999))
    }

    func testDeviceTiers() {
        XCTAssertEqual(DeviceModel.tier(model: "iPhone11,8", memoryGb: 3), .low)
        XCTAssertEqual(DeviceModel.tier(model: "iPhone14,7", memoryGb: 6), .mid)
        XCTAssertEqual(DeviceModel.tier(model: "iPhone15,3", memoryGb: 6), .high)
        XCTAssertEqual(DeviceModel.tier(model: "iPhone17,1", memoryGb: 8), .high)
        XCTAssertEqual(DeviceModel.tier(model: "iPhone12,8", memoryGb: 2.6), .low, "under 3 GB is low")
        XCTAssertEqual(DeviceModel.tier(model: "iPad13,1", memoryGb: 4), .high)
        XCTAssertEqual(DeviceModel.tier(model: "arm64", memoryGb: 16), .high, "unknown models by memory")
        XCTAssertNil(DeviceModel.tier(model: nil, memoryGb: nil))
        XCTAssertNil(DeviceModel.parse("iPhone"))
        XCTAssertEqual(DeviceModel.memoryGb(bytes: 3_900_000_000), 4)
    }
}

final class UploaderTests: XCTestCase {
    override func tearDown() {
        StubProtocol.handler = nil
        super.tearDown()
    }

    private func uploader() -> Uploader {
        let c = URLSessionConfiguration.ephemeral
        c.protocolClasses = [StubProtocol.self]
        return Uploader(endpoint: URL(string: "https://vitals.example")!, key: "kfp_live_abc", configuration: c)
    }

    private func send(status: Int, body: Data = Data()) -> (Uploader.Outcome, URLRequest?, Data?) {
        var seen: URLRequest?
        var seenBody: Data?
        StubProtocol.handler = { request in
            seen = request
            seenBody = request.httpBody ?? request.httpBodyStream.map(Self.read)
            return (status, body)
        }
        let done = expectation(description: "sent")
        var outcome: Uploader.Outcome?
        let report = try! sampleReport().encoded()
        uploader().send(report) { outcome = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        return (outcome!, seen, seenBody)
    }

    static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buf, maxLength: buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        return data
    }

    func testPostsGzippedJsonWithTheKey() throws {
        let response = try Data(contentsOf: XCTUnwrap(protocolFile("fixtures/vitals/ingest-response.json")))
        let (outcome, request, body) = send(status: 200, body: response)
        guard case let .sent(config) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(config?.sampleRate, 0.3)
        XCTAssertEqual(request?.url?.absoluteString, "https://vitals.example/v1/reports")
        XCTAssertEqual(request?.httpMethod, "POST")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer kfp_live_abc")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Content-Encoding"), "gzip")
        let gz = try XCTUnwrap(body)
        XCTAssertEqual(Array(gz.prefix(2)), [0x1f, 0x8b])
        let plain = try XCTUnwrap(GzipTests.inflate(gz))
        XCTAssertEqual(try JSONDecoder().decode(VitalsReport.self, from: plain), sampleReport().withNonce(from: plain))
    }

    func testOutcomes() throws {
        XCTAssertEqual(send(status: 401).0, .stop)
        XCTAssertEqual(send(status: 410).0, .stop)
        XCTAssertEqual(send(status: 400).0, .rejected)
        XCTAssertEqual(send(status: 413).0, .rejected)
        XCTAssertEqual(send(status: 429).0, .retry)
        XCTAssertEqual(send(status: 503).0, .retry)
        let stop = try Data(contentsOf: XCTUnwrap(protocolFile("fixtures/vitals/ingest-response-stop.json")))
        XCTAssertEqual(send(status: 200, body: stop).0, .sent(try JSONDecoder().decode(VitalsIngestResponse.self, from: stop).config))
        XCTAssertEqual(Uploader.outcome(data: nil, response: nil, error: URLError(.notConnectedToInternet)), .retry)
    }

    func testFetchesConfig() throws {
        let body = try Data(contentsOf: XCTUnwrap(protocolFile("fixtures/vitals/config.json")))
        var url: URL?
        StubProtocol.handler = { request in url = request.url; return (200, body) }
        let done = expectation(description: "fetched")
        var result: Result<VitalsConfig, Uploader.Outcome>?
        uploader().fetchConfig { result = $0; done.fulfill() }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(url?.absoluteString, "https://vitals.example/v1/config/kfp_live_abc")
        XCTAssertEqual(try result?.get().ttlSec, 86400)
    }
}

extension VitalsReport {
    /// The same report with the nonce read back from `data` (sampleReport makes a new one each call).
    func withNonce(from data: Data) -> VitalsReport {
        var r = self
        r.session.nonce = (try? JSONDecoder().decode(VitalsReport.self, from: data))?.session.nonce ?? ""
        return r
    }
}

final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else { return client!.urlProtocol(self, didFailWithError: URLError(.badServerResponse)) }
        let (status, body) = handler(request)
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class GzipTests: XCTestCase {
    /// gzip decoded in process: the 10-byte header, raw deflate, then CRC-32 and size (checked).
    static func inflate(_ data: Data) -> Data? {
        guard data.count > 18, data[data.startIndex] == 0x1f, data[data.startIndex + 1] == 0x8b else { return nil }
        let body = data.subdata(in: (data.startIndex + 10)..<(data.endIndex - 8))
        guard let plain = try? (body as NSData).decompressed(using: .zlib) as Data else { return nil }
        let tail = [UInt8](data.suffix(8))
        let crc = UInt32(tail[0]) | UInt32(tail[1]) << 8 | UInt32(tail[2]) << 16 | UInt32(tail[3]) << 24
        let size = UInt32(tail[4]) | UInt32(tail[5]) << 8 | UInt32(tail[6]) << 16 | UInt32(tail[7]) << 24
        guard crc == Gzip.crc32(plain), size == UInt32(truncatingIfNeeded: plain.count) else { return nil }
        return plain
    }

    static func gunzip(_ data: Data) -> Data? {
        guard let gzip = which("gzip") ?? (FileManager.default.isExecutableFile(atPath: "/usr/bin/gzip") ? "/usr/bin/gzip" : nil) else { return nil }
        let dir = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("kfv-gz-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("body.gz")
        try? data.write(to: file)
        return runTool(gzip, ["-dc", file.path]).map { Data($0.utf8) }
    }

    func testGzipIsReadableByGzip() throws {
        let text = String(repeating: "keyframer vitals ", count: 500) + "end"
        let gz = try XCTUnwrap(Gzip.compress(Data(text.utf8)))
        XCTAssertLessThan(gz.count, text.utf8.count / 4)
        XCTAssertEqual(GzipTests.inflate(gz).map { String(decoding: $0, as: UTF8.self) }, text)
        #if os(macOS)
        XCTAssertEqual(GzipTests.gunzip(gz).map { String(decoding: $0, as: UTF8.self) }, text, "and by the gzip tool")
        #endif
    }

    func testCrc32() {
        XCTAssertEqual(Gzip.crc32(Data("123456789".utf8)), 0xCBF4_3926)
        XCTAssertEqual(Gzip.crc32(Data()), 0)
    }
}
