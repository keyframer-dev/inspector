import Foundation

public struct InspectorScreen: Codable, Hashable, Sendable {
    public var width: Double
    public var height: Double
    public var scale: Double
    public init(width: Double, height: Double, scale: Double) {
        self.width = width
        self.height = height
        self.scale = scale
    }
}

/// What one thread is called on this platform, and whether animations run on it.
public struct InspectorThreadInfo: Codable, Hashable, Sendable {
    public var label: String
    public var animates: Bool?
    public init(label: String, animates: Bool? = nil) {
        self.label = label
        self.animates = animates
    }
}

public struct InspectorSDK: Codable, Hashable, Sendable {
    public var name: String
    public var version: String
    public init(name: String, version: String) {
        self.name = name
        self.version = version
    }
}

/// The screen the app draws on: its refresh rate sets the frame budget (1000 / hz ms). `adaptive`: the
/// rate follows the content (ProMotion), and `hz` is the highest it runs at. Without it: 60 Hz.
public struct InspectorDisplay: Codable, Hashable, Sendable {
    public var hz: Double
    public var adaptive: Bool?
    public init(hz: Double, adaptive: Bool? = nil) {
        self.hz = hz
        self.adaptive = adaptive
    }
}

/// The person's motion settings: Reduce Motion on iOS.
public struct InspectorAccessibility: Codable, Hashable, Sendable {
    public var reduceMotion: Bool
    public init(reduceMotion: Bool) {
        self.reduceMotion = reduceMotion
    }
}

/// The app's `hello`, the first message on every connection.
public struct AppHello: Codable, Hashable, Sendable {
    public var role = "app"
    public var app: String
    /// The OS: "ios".
    public var platform: String
    public var capture: Bool?
    public var screen: InspectorScreen?
    public var scenarios: [String]?
    /// The protocol version the app speaks (1).
    public var `protocol`: Int?
    public var sdk: InspectorSDK?
    /// "uikit", "swiftui", "react-native"…
    public var framework: String?
    public var osVersion: String?
    /// "debug" or "release" (`#if DEBUG`): frame times in a debug build are inflated.
    public var build: String?
    /// By role (`js`, `ui`); a missing one is not measured.
    public var threads: [String: InspectorThreadInfo]?
    /// capture, playback, scrub, overrides, replay, scenarios, time, recordings…
    public var capabilities: [String]?
    /// The app's source folder on this Mac: call sites resolve against it to open in an editor, and
    /// "Apply to code" writes only under it.
    public var root: String?
    /// The display's refresh rate; a change while recording is a `display` marker.
    public var display: InspectorDisplay?
    /// Reduce Motion; a change while recording is an `accessibility` marker.
    public var accessibility: InspectorAccessibility?
    /// Which device it runs on (a physical one says its model, never its name).
    public var device: InspectorDevice?

    public init(
        app: String, platform: String, capture: Bool? = nil, screen: InspectorScreen? = nil, scenarios: [String]? = nil,
        protocol: Int? = nil, sdk: InspectorSDK? = nil, framework: String? = nil, osVersion: String? = nil,
        build: String? = nil, threads: [String: InspectorThreadInfo]? = nil, capabilities: [String]? = nil, root: String? = nil,
        display: InspectorDisplay? = nil, accessibility: InspectorAccessibility? = nil, device: InspectorDevice? = nil
    ) {
        self.app = app
        self.platform = platform
        self.capture = capture
        self.screen = screen
        self.scenarios = scenarios
        self.protocol = `protocol`
        self.sdk = sdk
        self.framework = framework
        self.osVersion = osVersion
        self.build = build
        self.threads = threads
        self.capabilities = capabilities
        self.root = root
        self.display = display
        self.accessibility = accessibility
        self.device = device
    }
}

public struct ScenarioDone: Codable, Hashable, Sendable {
    public var name: String
    public var ms: Double
    public var error: String?
    public init(name: String, ms: Double, error: String? = nil) {
        self.name = name
        self.ms = ms
        self.error = error
    }
}

/// One `samples` batch: values, plus frames and markers while recording.
public struct SampleBatch: Codable, Hashable, Sendable {
    public var samples: [InspectorSample]
    public var frames: [InspectorFrameStat]?
    public var drops: [InspectorFrameDrop]?
    public var commits: [JSONValue]?
    public var markers: [InspectorMarker]?
    public var tasks: [JSONValue]?
    public var work: [JSONValue]?

    public init(samples: [InspectorSample], frames: [InspectorFrameStat]? = nil, drops: [InspectorFrameDrop]? = nil, markers: [InspectorMarker]? = nil) {
        self.samples = samples
        self.frames = frames
        self.drops = drops
        self.markers = markers
    }
}

/// The answer to `capture`.
public struct CapturedFrame: Codable, Hashable, Sendable {
    public var id: String
    public var data: String?
    public var format: String?
    public var error: String?
    public init(id: String, data: String? = nil, format: String? = nil, error: String? = nil) {
        self.id = id
        self.data = data
        self.format = format
        self.error = error
    }
}

public struct CaptureRequest: Codable, Hashable, Sendable {
    public var id: String
    public var samples: [InspectorSample]
    public var format: String?
    public var quality: Double?
    public var width: Double?
    public var route: InspectorRoute?
    public init(id: String, samples: [InspectorSample], format: String? = nil, quality: Double? = nil, width: Double? = nil, route: InspectorRoute? = nil) {
        self.id = id
        self.samples = samples
        self.format = format
        self.quality = quality
        self.width = width
        self.route = route
    }
}

public struct Presence: Codable, Hashable, Sendable {
    public var app: Bool
    public var editors: Int
    public var cli: Bool
    public init(app: Bool, editors: Int, cli: Bool) {
        self.app = app
        self.editors = editors
        self.cli = cli
    }
}

/// Every message of the protocol this SDK sends or acts on. Messages it only passes through
/// (cli `apply`/`source`/`sources`, device `recording`) are kept as `.other` with their JSON intact.
public enum InspectorMessage: Hashable, Sendable {
    // app → editors
    case appHello(AppHello)
    case scenarios([String])
    case scenarioDone(ScenarioDone)
    case events([InspectorEvent])
    case samples(SampleBatch)
    case frame(CapturedFrame)
    // editor → app
    case editorHello
    case overrides(InspectorOverrides)
    case replay
    /// `recorder`: who records (an id the editor keeps for its connection); nil is the one anonymous
    /// recorder older editors share.
    case record(signalIds: [String], on: Bool, recorder: String?)
    case scenario(String)
    case playback(samples: [InspectorSample], routes: [InspectorRoute]?)
    case capture(CaptureRequest)
    /// Seek the app's Core Animation timeline to `t` ms on the last recording's clock; null hands it back.
    case scrub(t: Double?)
    /// Both ways, one shape. Editor → app: run animations at `scale` (1 normal, 0 paused) and, while
    /// paused, advance `step` frames at the display's rate. App → editors: the speed now (no step).
    /// Read leniently: a `scale` that is missing or not a number is nil, and the message is still
    /// answered.
    case time(scale: Double?, step: Double?)
    // relay → everyone
    case presence(Presence)
    /// Anything else, kept whole.
    case other(type: String, json: JSONValue)
}

extension InspectorMessage: Codable {
    enum CodingKeys: String, CodingKey { case type, role, names, events, overrides, signalIds, on, recorder, name, samples, routes, t, scale, step }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "hello":
            let role = try c.decodeIfPresent(String.self, forKey: .role)
            if role == "app" { self = .appHello(try AppHello(from: decoder)) }
            else if role == "editor" { self = .editorHello }
            else { self = .other(type: type, json: try JSONValue(from: decoder)) }
        case "scenarios": self = .scenarios(try c.decode([String].self, forKey: .names))
        case "scenarioDone": self = .scenarioDone(try ScenarioDone(from: decoder))
        case "events": self = .events(try c.decode([InspectorEvent].self, forKey: .events))
        case "samples": self = .samples(try SampleBatch(from: decoder))
        case "frame": self = .frame(try CapturedFrame(from: decoder))
        case "overrides": self = .overrides(try c.decodeIfPresent(InspectorOverrides.self, forKey: .overrides) ?? [:])
        case "replay": self = .replay
        case "record":
            self = .record(
                signalIds: try c.decodeIfPresent([String].self, forKey: .signalIds) ?? [], on: try c.decodeIfPresent(Bool.self, forKey: .on) ?? false,
                recorder: try c.decodeIfPresent(String.self, forKey: .recorder)
            )
        case "scenario": self = .scenario(try c.decode(String.self, forKey: .name))
        case "playback":
            self = .playback(samples: try c.decodeIfPresent([InspectorSample].self, forKey: .samples) ?? [], routes: try c.decodeIfPresent([InspectorRoute].self, forKey: .routes))
        case "capture": self = .capture(try CaptureRequest(from: decoder))
        case "scrub": self = .scrub(t: try c.decodeIfPresent(Double.self, forKey: .t))
        case "time": self = .time(scale: (try? c.decodeIfPresent(Double.self, forKey: .scale)) ?? nil, step: (try? c.decodeIfPresent(Double.self, forKey: .step)) ?? nil)
        case "presence": self = .presence(try Presence(from: decoder))
        default: self = .other(type: type, json: try JSONValue(from: decoder))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .appHello(let h):
            try c.encode("hello", forKey: .type)
            try h.encode(to: encoder)
        case .scenarios(let names):
            try c.encode("scenarios", forKey: .type)
            try c.encode(names, forKey: .names)
        case .scenarioDone(let d):
            try c.encode("scenarioDone", forKey: .type)
            try d.encode(to: encoder)
        case .events(let events):
            try c.encode("events", forKey: .type)
            try c.encode(events, forKey: .events)
        case .samples(let batch):
            try c.encode("samples", forKey: .type)
            try batch.encode(to: encoder)
        case .frame(let f):
            try c.encode("frame", forKey: .type)
            try f.encode(to: encoder)
        case .editorHello:
            try c.encode("hello", forKey: .type)
            try c.encode("editor", forKey: .role)
        case .overrides(let o):
            try c.encode("overrides", forKey: .type)
            try c.encode(o, forKey: .overrides)
        case .replay:
            try c.encode("replay", forKey: .type)
        case .record(let ids, let on, let recorder):
            try c.encode("record", forKey: .type)
            try c.encode(ids, forKey: .signalIds)
            try c.encode(on, forKey: .on)
            try c.encodeIfPresent(recorder, forKey: .recorder)
        case .scenario(let name):
            try c.encode("scenario", forKey: .type)
            try c.encode(name, forKey: .name)
        case .playback(let samples, let routes):
            try c.encode("playback", forKey: .type)
            try c.encode(samples, forKey: .samples)
            try c.encodeIfPresent(routes, forKey: .routes)
        case .capture(let r):
            try c.encode("capture", forKey: .type)
            try r.encode(to: encoder)
        case .scrub(let t):
            try c.encode("scrub", forKey: .type)
            try c.encode(t, forKey: .t)
        case .time(let scale, let step):
            try c.encode("time", forKey: .type)
            try c.encodeIfPresent(scale, forKey: .scale)
            try c.encodeIfPresent(step, forKey: .step)
        case .presence(let p):
            try c.encode("presence", forKey: .type)
            try p.encode(to: encoder)
        case .other(_, let json):
            try json.encode(to: encoder)
        }
    }
}

public enum InspectorJSON {
    public static func encode(_ message: InspectorMessage) throws -> String {
        let data = try JSONEncoder().encode(message)
        return String(decoding: data, as: UTF8.self)
    }

    public static func decode(_ text: String) throws -> InspectorMessage {
        try JSONDecoder().decode(InspectorMessage.self, from: Data(text.utf8))
    }
}
