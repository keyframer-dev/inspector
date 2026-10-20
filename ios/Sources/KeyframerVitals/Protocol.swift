import Foundation

// The Motion Vitals wire format, mirrored from protocol/vitals.ts (VITALS_VERSION 1).
// Field names and optionality follow that file exactly; the golden test checks this encoder against
// packages/protocol/fixtures/vitals/report-ios.json. Foundation only, so `swift test` runs it on macOS.

enum Vitals {
    static let format = "keyframer-vitals"
    static let version = 1
    static let endpoint = URL(string: "https://vitals.keyframer.dev")!
    /// Histogram buckets of frames missed per frame, by lower bound: 0, 1, 2, 3-4, 5-8, 9-16, 17-32, 33+.
    static let buckets = [0, 1, 2, 3, 5, 9, 17, 33]
    /// A frame this long or longer is frozen (absolute time, Android vitals' definition).
    static let frozenMs = 700.0
    /// A window is at most this much foreground time.
    static let windowMs = 10 * 60 * 1000.0
    /// A session ends after this long in the background.
    static let sessionGapMs = 30 * 1000.0
    static let maxScreens = 40
    static let maxSites = 200
    static let maxImages = 64
    static let maxBytes = 32 * 1024
    static let screenNameLength = 64
    /// SDKs send this many worst frames (the protocol accepts up to 10).
    static let worstFrames = 5
    static let maxSessionsPerDay = 3
    static let defaultSampleRate = 0.1

    static let sdkName = "KeyframerVitals"
    static let sdkVersion = "0.1.0"

    /// Index of the histogram bucket for a frame that missed `missed` vsyncs.
    static func bucket(missed: Int) -> Int {
        var i = 0
        for (j, lower) in buckets.enumerated() where missed >= lower { i = j }
        return i
    }
}

enum VitalsThread: String, Codable, Hashable { case ui, js }
enum VitalsTier: String, Codable { case low, mid, high }
enum VitalsThermal: String, Codable, Comparable {
    case nominal, fair, serious, critical
    private var rank: Int { [.nominal: 0, .fair: 1, .serious: 2, .critical: 3][self] ?? 0 }
    static func < (a: Self, b: Self) -> Bool { a.rank < b.rank }
}
enum VitalsCause: String, Codable {
    case screenMount = "screen-mount", burst, busyStart = "busy-start", scroll, gesture
    case jsTask = "js-task", uiWork = "ui-work", slowRender = "slow-render", unknown
}
enum VitalsEnded: String, Codable { case background, window, unknown }

struct VitalsThreadStats: Codable, Equatable {
    var frames = 0
    var hist = [Int](repeating: 0, count: Vitals.buckets.count)
    var frozen = 0
    var hitchMs = 0.0
    var idleFrames = 0
    var idleMissed = 0
}

/// Where a call site is. iOS sends `name` (a `trace` name) and `native` (an offset into `images`).
enum VitalsSiteRef: Codable, Hashable {
    case source(file: String, line: Int, column: Int?)
    case hashed(hash: String)
    case name(name: String, type: String?)
    case native(image: Int, offset: UInt64, type: String?)
    case jvm(className: String, method: String, line: Int?, file: String?)

    private enum Keys: String, CodingKey { case kind, file, line, column, hash, name, type, image, offset, className, method }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "source": self = .source(file: try c.decode(String.self, forKey: .file), line: try c.decode(Int.self, forKey: .line), column: try c.decodeIfPresent(Int.self, forKey: .column))
        case "hashed": self = .hashed(hash: try c.decode(String.self, forKey: .hash))
        case "name": self = .name(name: try c.decode(String.self, forKey: .name), type: try c.decodeIfPresent(String.self, forKey: .type))
        case "native": self = .native(image: try c.decode(Int.self, forKey: .image), offset: try c.decode(UInt64.self, forKey: .offset), type: try c.decodeIfPresent(String.self, forKey: .type))
        case "jvm": self = .jvm(className: try c.decode(String.self, forKey: .className), method: try c.decode(String.self, forKey: .method), line: try c.decodeIfPresent(Int.self, forKey: .line), file: try c.decodeIfPresent(String.self, forKey: .file))
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown site kind \(kind)")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        switch self {
        case let .source(file, line, column):
            try c.encode("source", forKey: .kind); try c.encode(file, forKey: .file); try c.encode(line, forKey: .line); try c.encodeIfPresent(column, forKey: .column)
        case let .hashed(hash):
            try c.encode("hashed", forKey: .kind); try c.encode(hash, forKey: .hash)
        case let .name(name, type):
            try c.encode("name", forKey: .kind); try c.encode(name, forKey: .name); try c.encodeIfPresent(type, forKey: .type)
        case let .native(image, offset, type):
            try c.encode("native", forKey: .kind); try c.encode(image, forKey: .image); try c.encode(offset, forKey: .offset); try c.encodeIfPresent(type, forKey: .type)
        case let .jvm(className, method, line, file):
            try c.encode("jvm", forKey: .kind); try c.encode(className, forKey: .className); try c.encode(method, forKey: .method)
            try c.encodeIfPresent(line, forKey: .line); try c.encodeIfPresent(file, forKey: .file)
        }
    }
}

struct VitalsSite: Codable, Equatable {
    var ref: VitalsSiteRef
    var key: String?
    var fn: String
    var component: String?
    var prop: String?
    var screen: Int
    var runs: Int
    var activeMs: Double
    var frames: Int
    var missed: Int
    var hitchMs: Double
    var worstMs: Double
    var runsReduceMotion: Int?

    private enum CodingKeys: String, CodingKey {
        case ref, key, fn, component, prop, screen, runs, activeMs, frames, missed, hitchMs, worstMs, runsReduceMotion
    }

    /// `component` and `prop` are `string | null`: written as null when unknown, like the other SDKs.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(ref, forKey: .ref)
        try c.encodeIfPresent(key, forKey: .key)
        try c.encode(fn, forKey: .fn)
        try c.encode(component, forKey: .component)
        try c.encode(prop, forKey: .prop)
        try c.encode(screen, forKey: .screen)
        try c.encode(runs, forKey: .runs)
        try c.encode(activeMs, forKey: .activeMs)
        try c.encode(frames, forKey: .frames)
        try c.encode(missed, forKey: .missed)
        try c.encode(hitchMs, forKey: .hitchMs)
        try c.encode(worstMs, forKey: .worstMs)
        try c.encodeIfPresent(runsReduceMotion, forKey: .runsReduceMotion)
    }
}

struct VitalsWorstFrame: Codable, Equatable {
    var thread: VitalsThread
    var ms: Double
    var missed: Int
    var screen: Int
    var sites: [Int]
    var cause: VitalsCause
    var afterNavMs: Double?
}

struct VitalsImage: Codable, Equatable, Hashable {
    /// Lowercase hex without dashes (the LC_UUID).
    var debugId: String
    var kind: String
    /// File name only: `Acme`, `App.framework/App`.
    var name: String
    var arch: String?
}

struct VitalsScreen: Codable, Equatable {
    var name: String
    var ms: Double
    var threads: [String: VitalsThreadStats]
}

struct VitalsReport: Codable, Equatable {
    struct App: Codable, Equatable {
        var id: String?
        var version: String
        var build: String?
        var platform: String
        var framework: String?
        var environment: String
        var debugId: String?
    }
    struct Sdk: Codable, Equatable { var name: String; var version: String }
    struct Device: Codable, Equatable {
        var os: String
        var osMajor: Int
        var model: String?
        var tier: VitalsTier?
        var memoryGb: Double?
    }
    struct Display: Codable, Equatable { var hz: Double; var adaptive: Bool?; var targetHz: Double }
    struct State: Codable, Equatable { var reduceMotion: Bool?; var lowPower: Bool?; var thermal: VitalsThermal? }
    struct Session: Codable, Equatable {
        var nonce: String
        var seq: Int
        var sampleRate: Double
        var foregroundMs: Double
        var measuredMs: Double
        var ended: VitalsEnded
    }

    var format = Vitals.format
    var version = Vitals.version
    var app: App
    var sdk: Sdk
    var device: Device
    var display: Display
    var state: State
    var session: Session
    var screens: [VitalsScreen]
    var sites: [VitalsSite]
    var worst: [VitalsWorstFrame]
    var images: [VitalsImage]?

    func encoded() throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try e.encode(self)
    }
}

/// Per-project settings from upload responses and GET /v1/config/<key>.
struct VitalsConfig: Codable, Equatable, Sendable {
    struct Collect: Codable, Equatable, Sendable {
        var reduceMotion: Bool
        var deviceModel: Bool
        var development: Bool
    }
    var enabled: Bool
    var sampleRate: Double
    var boostUntil: String?
    var minSdk: [String: String]?
    var collect: Collect
    var stop: Bool?
    var ttlSec: Double

    /// What a device uses before it has ever fetched a config: Reduce Motion off, models on.
    static let defaults = VitalsConfig(
        enabled: true, sampleRate: Vitals.defaultSampleRate, boostUntil: nil, minSdk: nil,
        collect: Collect(reduceMotion: false, deviceModel: true, development: true), stop: nil, ttlSec: 86400
    )
}

struct VitalsIngestResponse: Codable {
    var ok: Bool
    var config: VitalsConfig?
    var error: String?
}
