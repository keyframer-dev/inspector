import Foundation

// Swift mirrors of protocol/inspector.ts. Field names and optionality follow the TS types
// exactly: `x?: T` is omitted when nil, `x: T | null` is always written (as null when nil).
// Tests/KeyframerInspectorCoreTests/Fixtures/messages.json is generated from TS values that are
// type-checked against those types, and every one of them must survive a decode and encode here.

/// Threads by role: `js` is the app thread (where app code runs: the main thread on iOS), `ui` the
/// frame thread (iOS: the render server, out of reach, so never reported).
public enum InspectorThread: String, Codable, Hashable, Sendable {
    case ui, js
}

/// A numeric literal argument the panel can show and tweak: `"1.duration"` is `args[1].duration`.
public struct InspectorParam: Codable, Hashable, Sendable {
    public var path: String
    public var value: Double
    public init(path: String, value: Double) {
        self.path = path
        self.value = value
    }
}

/// Where an animation was started. On iOS `file`/`line` are exact for `KeyframerInspector.trace`
/// (from `#fileID`/`#line`) and approximate otherwise (see CallSiteResolver).
public struct InspectorCallSite: Codable, Hashable, Sendable {
    public var id: String
    public var file: String
    public var line: Int
    public var column: Int
    public var fn: String
    public var component: String?
    public var target: String?
    public var prop: String?
    public var params: [InspectorParam]

    public init(id: String, file: String, line: Int, column: Int, fn: String, component: String?, target: String?, prop: String?, params: [InspectorParam]) {
        self.id = id
        self.file = file
        self.line = line
        self.column = column
        self.fn = fn
        self.component = component
        self.target = target
        self.prop = prop
        self.params = params
    }

    enum CodingKeys: String, CodingKey { case id, file, line, column, fn, component, target, prop, params }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(file, forKey: .file)
        try c.encode(line, forKey: .line)
        try c.encode(column, forKey: .column)
        try c.encode(fn, forKey: .fn)
        try c.encode(component, forKey: .component)
        try c.encode(target, forKey: .target)
        try c.encode(prop, forKey: .prop)
        try c.encode(params, forKey: .params)
    }
}

/// A value the panel can record and play back. On iOS: one scalar of one layer property.
public struct InspectorSignalSite: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Hashable, Sendable {
        case value, scroll
    }

    public var id: String
    public var file: String
    /// 0 when unknown (a site found from a stack).
    public var line: Int
    public var column: Int?
    public var component: String?
    public var name: String?
    /// `scroll`: a scroll view's offset (playback scrolls the real view).
    public var kind: Kind?
    /// False when playback cannot write it back.
    public var writable: Bool?

    public init(id: String, file: String, line: Int, column: Int? = nil, component: String?, name: String?, kind: Kind? = nil, writable: Bool? = nil) {
        self.id = id
        self.file = file
        self.line = line
        self.column = column
        self.component = component
        self.name = name
        self.kind = kind
        self.writable = writable
    }

    enum CodingKeys: String, CodingKey { case id, file, line, column, component, name, kind, writable }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(file, forKey: .file)
        try c.encode(line, forKey: .line)
        try c.encodeIfPresent(column, forKey: .column)
        try c.encode(component, forKey: .component)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(kind, forKey: .kind)
        try c.encodeIfPresent(writable, forKey: .writable)
    }
}

public struct InspectorStyleLink: Codable, Hashable, Sendable {
    public var signal: String
    public var prop: String
}

public struct InspectorStyleSite: Codable, Hashable, Sendable {
    public var id: String
    public var file: String
    public var line: Int
    public var component: String?
    public var name: String?
    public var links: [InspectorStyleLink]

    enum CodingKeys: String, CodingKey { case id, file, line, component, name, links }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(file, forKey: .file)
        try c.encode(line, forKey: .line)
        try c.encode(component, forKey: .component)
        try c.encode(name, forKey: .name)
        try c.encode(links, forKey: .links)
    }
}

public struct InspectorStackFrame: Codable, Hashable, Sendable {
    public var methodName: String
    public var file: String
    public var lineNumber: Int
    public var column: Int
    public var collapse: Bool?
    /// A native frame not resolved to a line yet (`lineNumber` 0): its binary image, the offset into
    /// that image (what `atos -l <load address>` takes on the Mac) and the raw symbol.
    public var image: String?
    public var offset: Int?
    public var symbol: String?

    public init(methodName: String, file: String, lineNumber: Int, column: Int, collapse: Bool? = nil, image: String? = nil, offset: Int? = nil, symbol: String? = nil) {
        self.methodName = methodName
        self.file = file
        self.lineNumber = lineNumber
        self.column = column
        self.collapse = collapse
        self.image = image
        self.offset = offset
        self.symbol = symbol
    }
}

public struct InspectorAnimEvent: Codable, Hashable, Sendable {
    public var eid: Int
    public var site: InspectorCallSite
    /// Wall clock (ms since 1970), like `Date.now()`.
    public var at: Double
    public var args: [JSONValue]
    public var thread: InspectorThread?
    /// While recording: when it started, on the recording's clock.
    public var t: Double?
    public var stack: String?
    /// The stack as frames (native frames carry image and offset for symbolication on the Mac).
    public var frames: [InspectorStackFrame]?
    /// How long it runs, delay included; nil when it repeats forever.
    public var durationMs: Double?

    public init(eid: Int, site: InspectorCallSite, at: Double, args: [JSONValue], thread: InspectorThread? = nil, t: Double? = nil, stack: String? = nil, frames: [InspectorStackFrame]? = nil, durationMs: Double? = nil) {
        self.eid = eid
        self.site = site
        self.at = at
        self.args = args
        self.thread = thread
        self.t = t
        self.stack = stack
        self.frames = frames
        self.durationMs = durationMs
    }
}

public enum InspectorEvent: Hashable, Sendable {
    case anim(InspectorAnimEvent)
    case signal(InspectorSignalSite)
    /// A value that went away (its layer was freed): it leaves the catalog.
    case unsignal(id: String)
    case style(InspectorStyleSite)
}

extension InspectorEvent: Codable {
    enum CodingKeys: String, CodingKey { case kind, site, id }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "anim": self = .anim(try InspectorAnimEvent(from: decoder))
        case "signal": self = .signal(try c.decode(InspectorSignalSite.self, forKey: .site))
        case "unsignal": self = .unsignal(id: try c.decode(String.self, forKey: .id))
        case "style": self = .style(try c.decode(InspectorStyleSite.self, forKey: .site))
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown event kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .anim(let e):
            try c.encode("anim", forKey: .kind)
            try e.encode(to: encoder)
        case .signal(let s):
            try c.encode("signal", forKey: .kind)
            try c.encode(s, forKey: .site)
        case .unsignal(let id):
            try c.encode("unsignal", forKey: .kind)
            try c.encode(id, forKey: .id)
        case .style(let s):
            try c.encode("style", forKey: .kind)
            try c.encode(s, forKey: .site)
        }
    }
}

public struct InspectorSample: Codable, Hashable, Sendable {
    public var id: String
    public var t: Double
    public var v: Double
    public init(id: String, t: Double, v: Double) {
        self.id = id
        self.t = t
        self.v = v
    }
}

public struct InspectorFrameStat: Codable, Hashable, Sendable {
    public var t: Double
    public var thread: InspectorThread
    public var fps: Double
    public var dropped: Int
    public init(t: Double, thread: InspectorThread, fps: Double, dropped: Int) {
        self.t = t
        self.thread = thread
        self.fps = fps
        self.dropped = dropped
    }
}

public struct InspectorFrameDrop: Codable, Hashable, Sendable {
    public var t: Double
    public var thread: InspectorThread
    public var ms: Double
    public var dropped: Int
    public init(t: Double, thread: InspectorThread, ms: Double, dropped: Int) {
        self.t = t
        self.thread = thread
        self.ms = ms
        self.dropped = dropped
    }
}

public struct InspectorRoute: Codable, Hashable, Sendable {
    public var t: Double
    public var route: String
    public var params: [String: JSONValue]?
    public init(t: Double, route: String, params: [String: JSONValue]? = nil) {
        self.t = t
        self.route = route
        self.params = params
    }
}

public enum TouchPhase: String, Codable, Hashable, Sendable {
    case start, move, end, cancel
}

/// Something that happened while recording besides motion. Coordinates are screen points.
public enum InspectorMarker: Hashable, Sendable {
    public struct Touch: Codable, Hashable, Sendable {
        public var t: Double
        public var phase: TouchPhase
        public var id: Int
        public var x: Double
        public var y: Double
        public var lost: Bool?
        public init(t: Double, phase: TouchPhase, id: Int, x: Double, y: Double, lost: Bool? = nil) {
            self.t = t
            self.phase = phase
            self.id = id
            self.x = x
            self.y = y
            self.lost = lost
        }
    }

    public struct Navigation: Codable, Hashable, Sendable {
        public var t: Double
        public var route: String
        public var params: [String: JSONValue]?

        public init(t: Double, route: String, params: [String: JSONValue]? = nil) {
            self.t = t
            self.route = route
            self.params = params
        }
    }

    public struct AppState: Codable, Hashable, Sendable {
        public var t: Double
        public var state: String

        public init(t: Double, state: String) {
            self.t = t
            self.state = state
        }
    }

    public struct Keyboard: Codable, Hashable, Sendable {
        public var t: Double
        public var visible: Bool
        public var height: Double

        public init(t: Double, visible: Bool, height: Double) {
            self.t = t
            self.visible = visible
            self.height = height
        }
    }

    public struct Log: Codable, Hashable, Sendable {
        public var t: Double
        public var level: String
        public var message: String
        public var stack: String?
        public var frames: [InspectorStackFrame]?

        public init(t: Double, level: String, message: String, stack: String? = nil, frames: [InspectorStackFrame]? = nil) {
            self.t = t
            self.level = level
            self.message = message
            self.stack = stack
            self.frames = frames
        }
    }

    public struct Note: Codable, Hashable, Sendable {
        public var t: Double
        public var text: String

        public init(t: Double, text: String) {
            self.t = t
            self.text = text
        }
    }

    public struct Gesture: Codable, Hashable, Sendable {
        public var t: Double
        public var gesture: String
        public var on: String
        public var handler: Int
        public var x: Double?
        public var y: Double?
        public var site: String
        public var component: String?

        public init(t: Double, gesture: String, on: String, handler: Int, x: Double?, y: Double?, site: String, component: String?) {
            self.t = t
            self.gesture = gesture
            self.on = on
            self.handler = handler
            self.x = x
            self.y = y
            self.site = site
            self.component = component
        }

        enum CodingKeys: String, CodingKey { case t, gesture, on, handler, x, y, site, component }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(t, forKey: .t)
            try c.encode(gesture, forKey: .gesture)
            try c.encode(on, forKey: .on)
            try c.encode(handler, forKey: .handler)
            try c.encode(x, forKey: .x)
            try c.encode(y, forKey: .y)
            try c.encode(site, forKey: .site)
            try c.encode(component, forKey: .component)
        }
    }

    case touch(Touch)
    case navigation(Navigation)
    case appState(AppState)
    case keyboard(Keyboard)
    case log(Log)
    case note(Note)
    case gesture(Gesture)
}

extension InspectorMarker: Codable {
    enum CodingKeys: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "touch": self = .touch(try Touch(from: decoder))
        case "navigation": self = .navigation(try Navigation(from: decoder))
        case "appState": self = .appState(try AppState(from: decoder))
        case "keyboard": self = .keyboard(try Keyboard(from: decoder))
        case "log": self = .log(try Log(from: decoder))
        case "note": self = .note(try Note(from: decoder))
        case "gesture": self = .gesture(try Gesture(from: decoder))
        case let kind: throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown marker kind \(kind)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        let payload: Encodable
        switch self {
        case .touch(let m): try c.encode("touch", forKey: .kind); payload = m
        case .navigation(let m): try c.encode("navigation", forKey: .kind); payload = m
        case .appState(let m): try c.encode("appState", forKey: .kind); payload = m
        case .keyboard(let m): try c.encode("keyboard", forKey: .kind); payload = m
        case .log(let m): try c.encode("log", forKey: .kind); payload = m
        case .note(let m): try c.encode("note", forKey: .kind); payload = m
        case .gesture(let m): try c.encode("gesture", forKey: .kind); payload = m
        }
        try payload.encode(to: encoder)
    }

    public var t: Double {
        switch self {
        case .touch(let m): return m.t
        case .navigation(let m): return m.t
        case .appState(let m): return m.t
        case .keyboard(let m): return m.t
        case .log(let m): return m.t
        case .note(let m): return m.t
        case .gesture(let m): return m.t
        }
    }
}

/// Live edits keyed by call site id: param path to value.
public typealias InspectorOverrides = [String: [String: Double]]
