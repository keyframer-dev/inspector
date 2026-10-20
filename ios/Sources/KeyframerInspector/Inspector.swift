#if canImport(UIKit)
import QuartzCore
import UIKit

/// The app's side of the protocol: the iOS counterpart of react-native/src/client.ts, with the
/// same message order and behaviour.
///
///   - On every (re)connection: `hello`, then the catalog of signals, then whatever was queued.
///   - Animations and new signals are queued and sent every 100 ms as `events`; while recording,
///     samples, frame stats, drops and markers go as `samples` on the same tick.
///   - `record` samples the listed signals every frame (presentation values), measures frames, and
///     collects touches, navigation, app state and the keyboard as markers.
///   - `playback` pins recorded values in time order, `capture` pins one moment and snapshots the
///     screen, `scrub` (proposed) seeks Core Animation's own timeline.
///   - `overrides` edit the next animation added from that call site.
///   - `time` runs Core Animation slower, pauses or steps it (WindowClocks), answered with `time`.
///   - Animated layers are checked for visibility while recording (`visibility` markers) and for how
///     they are drawn (`renderHint` events), by LayerWatch.
///
/// Clocks: a recording's `t` is ms since `record` on, in media time (CACurrentMediaTime), the clock
/// of display link timestamps and touch timestamps, so nothing needs re-basing. `at` is wall clock.
@MainActor final class Inspector {
    static var shared: Inspector? {
        didSet { AnimationTap.isActive = shared != nil }
    }

    /// KeyframerInspectorSwiftUI traced something: the hello says `framework: "swiftui"`.
    static var usesSwiftUI = false

    private static let maxQueuedEvents = 2000
    private static let maxSamplesPerMessage = 3000
    private static let maxRecordedAnimations = 400
    static let sdkVersion = "0.2.0"

    let config: KeyframerInspector.Configuration
    private let resolver: CallSiteResolver
    private let connection: Connection
    private let signals = SignalRegistry()
    private let pins = PinBoard()
    private let scrubber = Scrubber()
    private let ticker = Ticker()
    private let clocks = WindowClocks()
    private let watch = LayerWatch()

    private var overrides: InspectorOverrides = [:]
    private var nextEid = 1
    private var editors = 0
    private var symbolNames: [String: SymbolName] = [:]

    // What the last hello said, so a recording can say what changed since.
    private var helloDisplay: InspectorDisplay?
    private var helloAccessibility: InspectorAccessibility?
    private var helloFramework: String?
    /// The highest rate the display reported: ProMotion still, when Low Power Mode caps it at 60 Hz.
    private var peakHz: Double = 0
    private var markedHz: Double = 60
    private var markedReduceMotion = false

    // Outgoing, flushed every 100 ms.
    private var queue: [InspectorEvent] = []
    private var samples: [InspectorSample] = []
    private var frames: [InspectorFrameStat] = []
    private var drops: [InspectorFrameDrop] = []
    private var markers: [InspectorMarker] = []
    private var flushTimer: Timer?

    // Recording.
    /// Who records what (`record`'s recorder): the app records while any recorder is on.
    private var recorders = Recorders()
    /// The union of the recorders, every signal while any of them records `*` (new ones join it).
    private var recording = Set<String>()
    private var recordAll = false
    private var recordStart: CFTimeInterval = 0
    private var lastRecordStart: CFTimeInterval?
    private var compressor = SampleCompressor()
    private var angles = AngleUnwrapper()
    private var meter: FrameMeter?
    private var observers: [NSObjectProtocol] = []
    private var touchIds: [ObjectIdentifier: Int] = [:]
    private var nextTouchId = 1
    private var lastTouchMove: [Int: Double] = [:]
    private var lastRoute: String?
    private var recorded: [RecordedAnimation] = []

    // Playback.
    private struct Run {
        var samples: [InspectorSample]
        var routes: [InspectorRoute]
        var t0: Double
        var start: CFTimeInterval
        var i = 0
        var r = 0
    }

    private var run: Run?
    private var captures: Task<Void, Never>?

    var isRecording: Bool { recordAll || !recording.isEmpty }

    /// Where the app's functions are declared (N33): nil until read, or when the sources cannot be.
    private var sources: SourceIndex?
    /// Where `sources` was read from when no `sourceRoot` was set: its paths are made absolute.
    private var sourcesBase: String?
    private let callerFile: String?

    init(config: KeyframerInspector.Configuration, callerFile: String? = nil) {
        self.config = config
        self.callerFile = callerFile
        let exe = Bundle.main.executableURL?.lastPathComponent ?? (Bundle.main.infoDictionary?["CFBundleExecutable"] as? String) ?? ""
        resolver = CallSiteResolver(executable: exe, extraImages: config.appModules)
        connection = Connection(url: config.url)
        ticker.onFrame = { [weak self] link in self?.frame(link) }
    }

    func start() {
        Registry.tracked.removeAll { $0.layer.value == nil }
        for t in Registry.tracked {
            if let layer = t.layer.value { track(layer: layer, keyPaths: t.keyPaths, file: t.file, line: t.line) }
        }
        connection.onOpen = { [weak self] in self?.didConnect() }
        connection.onText = { [weak self] text in self?.receive(text) }
        // Nobody left to see slow motion, to resume a pause or to record for: the app gets its own
        // clock back, and every recorder goes (a reconnecting editor asks again).
        connection.onClose = { [weak self] in
            self?.stopEveryRecorder()
            self?.restoreTime()
        }
        connection.connect()
        readSources()
        var ticks = 0
        flushTimer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                ticks += 1
                if ticks % 3 == 0 { self?.checkSoon() }
                if ticks % 10 == 0 { self?.checkOnceASecond() }
                self?.flush()
            }
        }
        RunLoop.main.add(flushTimer!, forMode: .common)
    }

    func stop() {
        flushTimer?.invalidate()
        if isRecording { measure(false) }
        recorders.removeAll()
        recording = []
        recordAll = false
        run = nil
        pins.releaseAll()
        scrubber.end()
        restoreTime()
        ticker.set(running: false)
        connection.stop()
    }

    /// Reads the app's Swift sources off the main thread (the simulator reads the Mac's disk), so call
    /// sites found on the stack get a file and line. When it cannot, the log says why once, and those
    /// sites keep the function as their file and line 0.
    private func readSources() {
        let configured = config.sourceRoot
        let root = configured ?? callerFile.map { ($0 as NSString).deletingLastPathComponent }
        guard let root, !root.isEmpty else {
            Self.log("native call sites have no file and line: \(SourceIndex.Unavailable.noRoot.reason)")
            return
        }
        Task.detached(priority: .utility) { [weak self] in
            let built = SourceIndex.build(root: root)
            await MainActor.run {
                switch built {
                case .success(let index):
                    self?.sources = index
                    self?.sourcesBase = configured == nil ? root : nil
                case .failure(let why):
                    Self.log("native call sites have no file and line: \(why.reason)")
                }
            }
        }
    }

    static func log(_ text: String) {
        print("[KeyframerInspector] \(text)")
    }

    /// A few times a second: windows follow the editor's speed, and while recording, animated layers
    /// are checked for visibility.
    private func checkSoon() {
        let now = CACurrentMediaTime()
        clocks.follow(keyWindow: UIApplication.shared.kf_keyWindow?.layer, now: now)
        clocks.settle(now: now)
        if isRecording { checkVisibility(now: now) }
    }

    /// Once a second: layers that were freed leave the catalog, and while recording, the display's
    /// rate is read again (thermal limits change it without a notification).
    private func checkOnceASecond() {
        pruneSignals()
        watch.prune()
        checkDisplay()
    }

    // MARK: Connection

    private func didConnect() {
        sendHello()
        // The relay may not announce editors, so the catalog goes with every connection.
        sendCatalog()
        flush()
    }

    private func send(_ message: InspectorMessage) {
        guard let text = try? InspectorJSON.encode(message) else { return }
        connection.send(text)
    }

    private func sendHello() {
        let screen = UIApplication.shared.kf_keyWindow?.windowScene?.screen
        // The main thread is the app thread (`js`); the render server (`ui`) is out of reach.
        let capabilities = (config.captureScreen ? ["capture"] : []) + ["playback", "scrub", "overrides", "replay", "scenarios", "time"]
        let display = displayInfo()
        let accessibility = InspectorAccessibility(reduceMotion: UIAccessibility.isReduceMotionEnabled)
        let framework = Self.usesSwiftUI ? "swiftui" : "uikit"
        (helloDisplay, helloAccessibility, helloFramework) = (display, accessibility, framework)
        send(.appHello(AppHello(
            app: config.appName,
            platform: "ios",
            capture: config.captureScreen,
            screen: screen.map { InspectorScreen(width: $0.bounds.width, height: $0.bounds.height, scale: $0.scale) },
            scenarios: Registry.scenarioNames,
            protocol: 1,
            sdk: InspectorSDK(name: "KeyframerInspector", version: Self.sdkVersion),
            framework: framework,
            osVersion: UIDevice.current.systemVersion,
            build: Self.build,
            threads: ["js": InspectorThreadInfo(label: "Main", animates: true)],
            capabilities: capabilities,
            root: config.sourceRoot,
            display: display,
            accessibility: accessibility,
            // A simulator's UDID and name, a device's model only.
            device: InspectorDevice.current
        )))
        // A hello starts at normal speed: an app still slowed says so right after, and a reset to 1x
        // made while the connection was down is said now.
        if clocks.scale != 1 || timeDue { send(.time(scale: clocks.scale, step: nil)) }
        timeDue = false
    }

    /// The SwiftUI module was used after this connection's hello said uikit: say it again.
    func frameworkChanged() {
        guard connection.isOpen, let said = helloFramework, said != (Self.usesSwiftUI ? "swiftui" : "uikit") else { return }
        sendHello()
        sendCatalog()
    }

    /// The key window's screen: its top refresh rate, and whether it adapts (ProMotion). Nil before
    /// there is a window (the protocol then assumes 60 Hz).
    private func displayInfo() -> InspectorDisplay? {
        guard let screen = UIApplication.shared.kf_keyWindow?.windowScene?.screen, screen.maximumFramesPerSecond > 0 else { return nil }
        let hz = Double(screen.maximumFramesPerSecond)
        peakHz = max(peakHz, hz)
        return InspectorDisplay(hz: hz, adaptive: peakHz > 60 ? true : nil)
    }

    /// The rate frames are counted against. On iPhone a display link runs at 60 Hz at most unless the
    /// app's Info.plist has CADisableMinimumFrameDurationOnPhone, whatever the display can do: counting
    /// against 120 Hz there would call every other frame dropped.
    static func meterHz(display hz: Double) -> Double {
        let unlocked = Bundle.main.object(forInfoDictionaryKey: "CADisableMinimumFrameDurationOnPhone") as? Bool == true
        return UIDevice.current.userInterfaceIdiom == .phone && !unlocked ? min(hz, 60) : hz
    }

    /// How this app was built: frames in a debug build are slower, which the inspector allows for.
    #if DEBUG
    static let build = "debug"
    #else
    static let build = "release"
    #endif

    private func pruneSignals() {
        for id in signals.prune() { enqueue(.unsignal(id: id)) }
    }

    private func sendCatalog() {
        // Render hints refer to signals; an editor that joins later needs both.
        let events = signals.sites.map(InspectorEvent.signal) + watch.liveHints.map(InspectorEvent.renderHint)
        if !events.isEmpty { send(.events(events)) }
    }

    func scenariosChanged() {
        send(.scenarios(Registry.scenarioNames))
    }

    private func enqueue(_ event: InspectorEvent) {
        queue.append(event)
        if queue.count > Self.maxQueuedEvents { queue.removeFirst(queue.count - Self.maxQueuedEvents) }
    }

    private func flush() {
        guard connection.isOpen else { return }
        if !queue.isEmpty {
            send(.events(queue))
            queue = []
        }
        guard !samples.isEmpty || !frames.isEmpty || !drops.isEmpty || !markers.isEmpty else { return }
        var batch = SampleBatch(samples: [], frames: frames.isEmpty ? nil : frames, drops: drops.isEmpty ? nil : drops, markers: markers.isEmpty ? nil : markers)
        var rest = samples[...]
        repeat {
            batch.samples = Array(rest.prefix(Self.maxSamplesPerMessage))
            rest = rest.dropFirst(Self.maxSamplesPerMessage)
            send(.samples(batch))
            batch = SampleBatch(samples: [])
        } while !rest.isEmpty
        samples = []
        frames = []
        drops = []
        markers = []
    }

    // MARK: Messages from editors

    private func receive(_ text: String) {
        guard text != "pong", let message = try? InspectorJSON.decode(text) else { return }
        switch message {
        case .overrides(let o):
            overrides = o
        case .replay:
            releasePlayback()
            Registry.replay?.1()
        case .record(let ids, let on, let recorder):
            setRecording(ids, on: on, recorder: recorder)
        case .scenario(let name):
            runScenario(name)
        case .playback(let recorded, let routes):
            playback(recorded, routes: routes ?? [])
        case .capture(let request):
            let previous = captures
            captures = Task { @MainActor [weak self] in
                await previous?.value
                await self?.capture(request)
            }
        case .scrub(let t):
            scrub(t)
        case .time(let scale, let step):
            time(scale, step: step)
        case .presence(let p):
            if p.editors > editors { sendCatalog() }
            editors = p.editors
            if p.editors == 0 {
                // Nobody left to record for, or to see the app slowed.
                stopEveryRecorder()
                restoreTime()
            }
        case .editorHello:
            // An editor that joined after us missed hello and the catalog.
            sendHello()
            sendCatalog()
        default:
            break
        }
    }

    private func runScenario(_ name: String) {
        Task { @MainActor [weak self] in
            let t0 = CACurrentMediaTime()
            var error: String?
            if let scenario = Registry.scenarios[name]?.1 {
                do { try await scenario() } catch let e { error = String(describing: e) }
            } else {
                let names = Registry.scenarioNames
                error = "No scenario named \"\(name)\". Registered: \(names.isEmpty ? "none" : names.joined(separator: ", "))."
            }
            guard let self else { return }
            // What the scenario started goes out before it is reported done.
            self.flush()
            self.send(.scenarioDone(ScenarioDone(name: name, ms: ((CACurrentMediaTime() - t0) * 1000).rounded(), error: error)))
        }
    }

    // MARK: Recording

    private func elapsed(_ media: CFTimeInterval = CACurrentMediaTime()) -> Double {
        ((media - recordStart) * 1000).rounded()
    }

    /// `on`: these ids join that recorder (`*`: every value, also ones that mount meanwhile). Off: they
    /// leave it, or all of it with `*`; a recorder left with nothing goes away. Only the first recorder
    /// on starts a recording (its clock, compressor and frame meter), only the last one off stops it.
    private func setRecording(_ ids: [String], on: Bool, recorder: String?) {
        let was = isRecording
        if on {
            if !was {
                releasePlayback()
                recordStart = CACurrentMediaTime()
                lastRecordStart = recordStart
                compressor = SampleCompressor()
                angles = AngleUnwrapper()
                // Scrubbing reads the window clocks' history from here on.
                clocks.forget(before: recordStart)
                watch.resetVisibility()
            }
        }
        recorders.apply(ids, on: on, recorder: recorder)
        unionRecorders()
        if was != isRecording { measure(isRecording) }
    }

    private func stopEveryRecorder() {
        guard !recorders.isEmpty else { return }
        let was = isRecording
        recorders.removeAll()
        unionRecorders()
        if was { measure(false) }
    }

    private func unionRecorders() {
        recordAll = recorders.recordsAll
        recording = recordAll ? Set(signals.ids) : recorders.ids
    }

    private func measure(_ on: Bool) {
        if on {
            let hz = displayInfo()?.hz ?? 60
            meter = FrameMeter(thread: .js, hz: Self.meterHz(display: hz))
            // The recording starts now: a stall before the first display frame is measured too.
            meter?.start(at: 0)
            ticker.hz = hz
            lastTouchMove = [:]
            lastRoute = nil
            if let route = currentRoute() { mark(route: route.0, params: route.1) }
            // The hello went out when the app connected; what changed since is said at the start.
            markedHz = helloDisplay?.hz ?? 60
            markedReduceMotion = helloAccessibility?.reduceMotion ?? false
            checkDisplay()
            checkAccessibility()
            if clocks.scale != 1 { mark(.time(.init(t: elapsed(), scale: clocks.scale))) }
            let center = NotificationCenter.default
            // Low Power Mode caps a ProMotion display at 60 Hz.
            observers.append(center.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkDisplay() }
            })
            observers.append(center.addObserver(forName: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.checkAccessibility() }
            })
            let appState: [(Notification.Name, String)] = [
                (UIApplication.didBecomeActiveNotification, "active"),
                (UIApplication.willResignActiveNotification, "inactive"),
                (UIApplication.didEnterBackgroundNotification, "background"),
            ]
            for (name, state) in appState {
                observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.mark(.appState(.init(t: self?.elapsed() ?? 0, state: state))) }
                })
            }
            observers.append(center.addObserver(forName: UIResponder.keyboardDidShowNotification, object: nil, queue: .main) { [weak self] n in
                let height = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect)?.height ?? 0
                MainActor.assumeIsolated { self?.mark(.keyboard(.init(t: self?.elapsed() ?? 0, visible: true, height: height.rounded()))) }
            })
            observers.append(center.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.mark(.keyboard(.init(t: self?.elapsed() ?? 0, visible: false, height: 0))) }
            })
        } else {
            meter = nil
            samples.append(contentsOf: compressor.finish())
            for o in observers { NotificationCenter.default.removeObserver(o) }
            observers = []
            touchIds = [:]
            watch.resetVisibility()
        }
        updateTicker()
    }

    /// While recording: a `display` marker when the display's top rate changed, and frames counted
    /// against the new one.
    private func checkDisplay() {
        guard isRecording, let hz = displayInfo()?.hz, hz != markedHz else { return }
        markedHz = hz
        mark(.display(.init(t: elapsed(), hz: hz)))
        meter?.hz = Self.meterHz(display: hz)
        ticker.hz = hz
    }

    /// While recording: an `accessibility` marker when Reduce Motion was turned on or off.
    private func checkAccessibility() {
        let reduce = UIAccessibility.isReduceMotionEnabled
        guard isRecording, reduce != markedReduceMotion else { return }
        markedReduceMotion = reduce
        mark(.accessibility(.init(t: elapsed(), reduceMotion: reduce)))
    }

    private func mark(_ marker: InspectorMarker) {
        guard isRecording, markers.count < Self.maxQueuedEvents else { return }
        markers.append(marker)
    }

    private func mark(route: String, params: [String: JSONValue]?) {
        guard route != lastRoute else { return }
        lastRoute = route
        mark(.navigation(.init(t: elapsed(), route: route, params: params)))
    }

    private func updateTicker() {
        ticker.set(running: isRecording || run != nil)
    }

    /// One display frame: frame stats and samples while recording, the next samples while playing back.
    private func frame(_ link: CADisplayLink) {
        if isRecording, var m = meter {
            let t = (link.timestamp - recordStart) * 1000
            m.tick(t)
            let (stats, long) = m.drain()
            meter = m
            frames += stats.map { var s = $0; s.t = s.t.rounded(); return s }
            drops += long.map { var d = $0; d.t = d.t.rounded(); return d }
            sample(at: t.rounded())
        }
        if run != nil { step() }
        updateTicker()
    }

    private func sample(at t: Double) {
        for id in recording {
            guard let track = signals.track(id), var v = track.read() else { continue }
            if track.layer != nil, LayerKeyPath.isAngle(track.path) { v = angles.unwrap(id, v) }
            samples += compressor.push(id: id, t: t, v: v)
        }
    }

    // MARK: Animations

    /// Called synchronously from `-[CALayer addAnimation:forKey:]` on the main thread.
    func willAdd(_ anim: CAAnimation, forKey key: String?, to layer: CALayer, symbols: [String], editable: Bool = true) -> CAAnimation? {
        let now = CACurrentMediaTime()
        let explicit = ExplicitSites.current
        let keyPath = AnimationInfo.keyPath(of: anim)
        if AnimationInfo.privateKeyPaths.contains(keyPath) { return nil }
        let frames = SymbolFrame.parse(lines: symbols)
        let resolved = resolver.resolve(frames, describe: describe)
        guard explicit != nil || resolved != nil || config.reportSystemAnimations else { return nil }

        let naming = signals.naming(for: layer)
        let file: String
        let line: Int
        let column: Int
        let location: String
        if let e = explicit {
            let path = e.path(under: config.sourceRoot)
            (file, line, column) = (path, e.line, e.column)
            location = "\(path):\(e.line):\(e.column)"
        } else if let r = resolved {
            // No line numbers at runtime: the line of the function's declaration, read from the
            // sources (N33), else the function's name and line 0. The id is the function either way,
            // so it stays the same across edits and builds; recorded events carry frames for atos.
            if let l = sources?.locate(r.name) {
                (file, line, column) = (sourcesBase.map { ($0 as NSString).appendingPathComponent(l.file) } ?? l.file, l.line, 0)
            } else {
                (file, line, column) = (r.name.display, 0, 0)
            }
            location = r.id
        } else {
            (file, line, column) = ("<system>", 0, 0)
            location = naming.id("")
        }
        let siteId = "\(location)/\(keyPath)"

        var edited: CAAnimation?
        if editable, let edits = overrides[siteId] { edited = AnimationInfo.applying(edits, to: anim) }
        let effective = edited ?? anim

        let property = (anim as? CAPropertyAnimation)?.keyPath
        let model = property.flatMap { layer.value(forKeyPath: $0) }
        let presented = property.flatMap { (layer.presentation() ?? layer).value(forKeyPath: $0) }
        let begin = Self.begin(of: effective, on: layer, now: now)
        let info = AnimationInfo(effective, delayMs: max(0, begin.delay * 1000), from: presented, to: model)
        let site = InspectorCallSite(
            id: siteId, file: file, line: line, column: column,
            fn: Self.api(of: anim, frames: frames),
            component: resolved?.name.type ?? naming.owner,
            target: explicit?.name ?? naming.name,
            prop: keyPath,
            params: info.params
        )
        var event = InspectorAnimEvent(eid: nextEid, site: site, at: (Date().timeIntervalSince1970 * 1000).rounded(), args: info.args, thread: .js, durationMs: info.durationMs)
        nextEid += 1
        if isRecording {
            event.t = elapsed(now)
            event.stack = resolver.formatStack(frames, describe: describe)
            event.frames = resolver.stackFrames(frames, describe: describe)
        }
        enqueue(.anim(event))

        let paths = (effective as? CAAnimationGroup)?.animations?.map(AnimationInfo.keyPath(of:)) ?? [keyPath]
        track(layer: layer, keyPaths: paths, naming: naming, file: file, line: line)
        remember(effective, on: layer, begin: begin.local, from: presented, to: model)
        if isRecording { checkVisibility(of: layer, now: now, adding: true) }
        // A hint is the layer's, named by what it is about (`card/shadowPath`), whatever animates first.
        let name: (CALayer) -> String = { [signals] in
            let n = signals.naming(for: $0)
            return n.owner.map { "\($0).\(n.name)" } ?? n.name
        }
        for hint in watch.newHints(for: layer, keyPaths: paths, id: naming.id, now: now, name: name) { enqueue(.renderHint(hint)) }
        return edited
    }

    /// Registers the scalars a SwiftUI trace pushes (SwiftUIBridge).
    func track(source: KeyframerValueSource, sites: [InspectorSignalSite]) {
        for (i, site) in sites.enumerated() {
            guard let added = signals.ensure(source: source, index: i, site: site) else { continue }
            enqueue(.signal(added))
            if recordAll { recording.insert(added.id) }
        }
    }

    func overrides(for siteId: String) -> [String: Double]? {
        overrides[siteId]
    }

    /// An animation reported from outside Core Animation (a SwiftUI trace), with its call site.
    func report(site: InspectorCallSite, args: [JSONValue], durationMs: Double?, symbols: [String]?) {
        let now = CACurrentMediaTime()
        var event = InspectorAnimEvent(eid: nextEid, site: site, at: (Date().timeIntervalSince1970 * 1000).rounded(), args: args, thread: .js, durationMs: durationMs)
        nextEid += 1
        if isRecording {
            event.t = elapsed(now)
            if let symbols {
                let frames = SymbolFrame.parse(lines: symbols)
                event.stack = resolver.formatStack(frames, describe: describe)
                event.frames = resolver.stackFrames(frames, describe: describe)
            }
        }
        enqueue(.anim(event))
    }

    func track(layer: CALayer, keyPaths: [String], file: String, line: Int) {
        track(layer: layer, keyPaths: keyPaths, naming: signals.naming(for: layer), file: file, line: line)
    }

    private func track(layer: CALayer, keyPaths: [String], naming: LayerNaming, file: String, line: Int, kind: InspectorSignalSite.Kind? = nil) {
        for keyPath in keyPaths {
            for path in LayerKeyPath.scalarPaths(for: keyPath) {
                guard let site = signals.ensure(layer: layer, path: path, naming: naming, file: file, line: line, kind: kind) else { continue }
                enqueue(.signal(site))
                // Recording everything: a new signal joins.
                if recordAll { recording.insert(site.id) }
            }
        }
    }

    private func remember(_ anim: CAAnimation, on layer: CALayer, begin: CFTimeInterval, from: Any?, to: Any?) {
        guard let copy = anim.copy() as? CAAnimation else { return }
        copy.delegate = nil
        var holdsEnd = !anim.isRemovedOnCompletion && (anim.fillMode == .forwards || anim.fillMode == .both)
        switch anim {
        case let basic as CABasicAnimation:
            // UIKit leaves toValue implicit (or runs additive deltas): the model is the end value.
            holdsEnd = holdsEnd || basic.isAdditive || basic.toValue == nil || (basic.toValue as AnyObject?)?.isEqual(to) == true
        case let keyframes as CAKeyframeAnimation:
            holdsEnd = holdsEnd || (keyframes.values?.last as AnyObject?)?.isEqual(to) == true
        default:
            break
        }
        if let basic = copy as? CABasicAnimation, basic.byValue == nil {
            if basic.isAdditive, let from, let to {
                // UIKit's additive deltas are relative to the model value at the time, which a later
                // animation changes: kept as the absolute values they ran between instead (the same
                // curve, spring overshoot included).
                basic.isAdditive = false
                basic.fromValue = from
                basic.toValue = to
            } else if !basic.isAdditive {
                if basic.fromValue == nil { basic.fromValue = from }
                if basic.toValue == nil { basic.toValue = to }
            }
        }
        recorded.append(RecordedAnimation(layer: layer, anim: copy, begin: begin, holdsEnd: holdsEnd))
        if recorded.count > Self.maxRecordedAnimations { recorded.removeFirst(recorded.count - Self.maxRecordedAnimations) }
    }

    /// When an animation begins on the layer's own clock, and its delay in seconds of that clock. Core
    /// Animation's private `beginTimeMode` says how to read beginTime: UIKit uses "relative" (a delay
    /// after the commit, so `delay: 0.1` is 0.1); the default "non-zero" reads 0 as now and anything
    /// else as the layer's local time. The layer's clock, not media time: under the editor's slow
    /// motion or pause the two part ways.
    static func begin(of anim: CAAnimation, on layer: CALayer, now: CFTimeInterval) -> (local: CFTimeInterval, delay: Double) {
        let local = layer.convertTime(now, from: nil)
        if (anim.value(forKey: "beginTimeMode") as? String) == "relative" { return (local + anim.beginTime, anim.beginTime) }
        if anim.beginTime > 0 { return (anim.beginTime, anim.beginTime - local) }
        return (local, 0)
    }

    private func describe(_ symbol: String) -> SymbolName {
        if let cached = symbolNames[symbol] { return cached }
        let name = SymbolName.describe(symbol)
        if symbolNames.count > 5000 { symbolNames = [:] }
        symbolNames[symbol] = name
        return name
    }

    /// The API that started it, from UIKit's frames on the stack, else the animation's class.
    static func api(of anim: CAAnimation, frames: [SymbolFrame]) -> String {
        for f in frames.prefix(24) where f.image == "UIKitCore" || f.image == "UIKit" {
            let s = f.symbol
            if s.contains("UIViewPropertyAnimator") { return "UIViewPropertyAnimator" }
            if s.contains("Keyframe") { return "UIView.animateKeyframes" }
            if s.contains("transitionWithView") || s.contains("transitionFromView") { return "UIView.transition" }
            if s.contains("UIViewAnimationState") || s.contains("UIViewAnimationWithBlocks") || s.contains("animateWithDuration") || s.contains("UIViewAnimationBlockDelegate") {
                return "UIView.animate"
            }
        }
        return String(describing: type(of: anim))
    }

    // MARK: Touches and screens

    func handle(_ event: UIEvent) {
        guard event.type == .touches, let touches = event.allTouches else { return }
        for touch in touches {
            switch touch.phase {
            case .began:
                // A real finger takes the app back from playback.
                if run == nil && (!pins.isEmpty || scrubber.isActive) { releasePlayback() }
                if config.trackScrollViews { trackScrollView(around: touch.view) }
                let id = nextTouchId
                nextTouchId += 1
                touchIds[ObjectIdentifier(touch)] = id
                mark(touch, id: id, phase: .start)
            case .moved:
                guard let id = touchIds[ObjectIdentifier(touch)] else { continue }
                let t = touchTime(touch)
                // At most one move per finger per 120 Hz frame, like React Native.
                if t - (lastTouchMove[id] ?? -.infinity) < 8 { continue }
                lastTouchMove[id] = t
                mark(touch, id: id, phase: .move)
            case .ended, .cancelled:
                guard let id = touchIds.removeValue(forKey: ObjectIdentifier(touch)) else { continue }
                mark(touch, id: id, phase: touch.phase == .ended ? .end : .cancel)
            default:
                continue
            }
        }
    }

    private func touchTime(_ touch: UITouch) -> Double {
        // UITouch.timestamp is seconds of system uptime: the same clock as CACurrentMediaTime.
        ((touch.timestamp - recordStart) * 1000).rounded()
    }

    private func mark(_ touch: UITouch, id: Int, phase: TouchPhase) {
        guard isRecording else { return }
        var p = touch.location(in: nil)
        if let window = touch.window { p = window.convert(p, to: window.screen.coordinateSpace) }
        mark(.touch(.init(t: touchTime(touch), phase: phase, id: id, x: (p.x * 10).rounded() / 10, y: (p.y * 10).rounded() / 10)))
    }

    private func trackScrollView(around view: UIView?) {
        var v = view
        while let cur = v {
            if let scroll = cur as? UIScrollView, scroll.isScrollEnabled {
                track(layer: scroll.layer, keyPaths: ["bounds.origin"], naming: signals.naming(for: scroll.layer), file: "<scroll>", line: 0, kind: .scroll)
                return
            }
            v = cur.superview
        }
    }

    func didAppear(_ vc: UIViewController) {
        guard isRecording, Self.isScreen(vc) else { return }
        mark(route: Self.route(of: vc), params: vc.title.map { ["title": .string($0)] })
    }

    /// A screen of the app's own: its controller class comes from the app, or hosts SwiftUI. Containers
    /// (navigation, tabs, split, page) are not screens; what they show is.
    static func isScreen(_ vc: UIViewController) -> Bool {
        if vc is UINavigationController || vc is UITabBarController || vc is UISplitViewController || vc is UIPageViewController { return false }
        return Bundle(for: type(of: vc)) == Bundle.main || String(describing: type(of: vc)).hasPrefix("UIHostingController")
    }

    static func route(of vc: UIViewController) -> String {
        String(describing: type(of: vc))
    }

    /// The screen on top now: presented controllers first, then what containers show.
    private func currentRoute() -> (String, [String: JSONValue]?)? {
        var vc = UIApplication.shared.kf_keyWindow?.rootViewController
        while let cur = vc {
            if let presented = cur.presentedViewController, !presented.isBeingDismissed { vc = presented; continue }
            if let nav = cur as? UINavigationController, let top = nav.topViewController { vc = top; continue }
            if let tabs = cur as? UITabBarController, let selected = tabs.selectedViewController { vc = selected; continue }
            break
        }
        guard let top = vc else { return nil }
        return (Self.route(of: top), top.title.map { ["title": .string($0)] })
    }

    /// Goes to a recorded screen: the app's navigator, else back down the navigation stack.
    @discardableResult
    private func navigate(to route: InspectorRoute) -> Bool {
        if currentRoute()?.0 == route.route { return false }
        if let navigator = Registry.navigator { return navigator(route.route, route.params) }
        var vc = UIApplication.shared.kf_keyWindow?.rootViewController
        while let cur = vc {
            if let nav = cur as? UINavigationController {
                if let target = nav.viewControllers.last(where: { Self.route(of: $0) == route.route }) {
                    nav.popToViewController(target, animated: false)
                    return true
                }
                vc = nav.topViewController
            } else {
                vc = cur.presentedViewController ?? (cur as? UITabBarController)?.selectedViewController
            }
        }
        return false
    }

    func note(_ text: String) {
        mark(.note(.init(t: elapsed(), text: text)))
    }

    // MARK: Playback, capture, scrub

    private func releasePlayback() {
        run = nil
        pins.releaseAll()
        scrubber.end()
        updateTicker()
    }

    private func pin(_ sample: InspectorSample) {
        guard let track = signals.track(sample.id), let layer = track.layer else { return }
        pins.set(layer, path: track.path, value: sample.v)
    }

    private func playback(_ recorded: [InspectorSample], routes: [InspectorRoute]) {
        scrubber.end()
        let ordered = recorded.sorted { $0.t < $1.t }
        let screens = routes.sorted { $0.t < $1.t }
        guard let first = ordered.first else {
            if let s = screens.first { navigate(to: s) }
            return
        }
        run = Run(samples: ordered, routes: screens, t0: min(first.t, screens.first?.t ?? .infinity), start: CACurrentMediaTime())
        step()
        updateTicker()
    }

    private func step() {
        guard var r = run else { return }
        let elapsed = (CACurrentMediaTime() - r.start) * 1000
        while r.r < r.routes.count, r.routes[r.r].t - r.t0 <= elapsed {
            navigate(to: r.routes[r.r])
            r.r += 1
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        while r.i < r.samples.count, r.samples[r.i].t - r.t0 <= elapsed {
            pin(r.samples[r.i])
            r.i += 1
        }
        CATransaction.commit()
        run = r.i >= r.samples.count && r.r >= r.routes.count ? nil : r
    }

    private func capture(_ request: CaptureRequest) async {
        guard config.captureScreen else {
            send(.frame(CapturedFrame(id: request.id, error: "This app does not capture its screen: start the inspector with captureScreen: true.")))
            return
        }
        run = nil
        // Without samples it is a picture of what shows now (a scrubbed timeline included).
        if !request.samples.isEmpty { scrubber.end() }
        // The screen this moment was on: go there and let the transition finish first.
        if let route = request.route, navigate(to: route) { try? await Task.sleep(nanoseconds: 700_000_000) }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for s in request.samples { pin(s) }
        CATransaction.commit()
        // The pins reach the render server on the next commit and the screen a frame later.
        try? await Task.sleep(nanoseconds: 50_000_000)
        let format = request.format ?? "jpg"
        if let data = ScreenCapture.snapshot(width: request.width, format: format, quality: request.quality ?? 0.85) {
            send(.frame(CapturedFrame(id: request.id, data: data, format: format)))
        } else {
            send(.frame(CapturedFrame(id: request.id, error: "No window to capture.")))
        }
    }

    func scrub(_ t: Double?) {
        guard let t else {
            scrubber.end()
            return
        }
        run = nil
        pins.releaseAll()
        let base = lastRecordStart ?? CACurrentMediaTime()
        // A window on the editor's clock keeps it: freezing it too would lose the speed to restore.
        let windows = Set(clocks.layers.map(ObjectIdentifier.init))
        let live = signals.animatedLayers().filter { !windows.contains(ObjectIdentifier($0)) }
        scrubber.seek(toMedia: base + t / 1000, live: live, recorded: recorded.filter { $0.layer != nil }, context: { [clocks] in clocks.context(of: $0) })
        updateTicker()
    }

    // MARK: Time

    /// What the editor asked for with `time`: 1 normal, 0 paused.
    var timeScale: Double { clocks.scale }

    private func time(_ requested: Double?, step: Double?) {
        let now = CACurrentMediaTime()
        if let scale = TimeControl.sanitize(scale: requested) {
            let was = clocks.scale
            clocks.set(scale: scale, keyWindow: UIApplication.shared.kf_keyWindow?.layer, now: now)
            if was != scale { mark(.time(.init(t: elapsed(now), scale: scale))) }
            if scale == 0, let frames = TimeControl.sanitize(step: step) {
                clocks.step(frames: frames, hz: displayInfo()?.hz ?? 60, now: now)
                // One marker per step, at the moment it was taken.
                mark(.time(.init(t: elapsed(now), scale: 0, step: frames)))
            }
        }
        // Every editor shows the same speed, including after a message the app could not take.
        send(.time(scale: clocks.scale, step: nil))
    }

    /// The editor left (or the inspector stops, or the connection dropped): the app's own clock, now.
    /// Every reset says `time 1` to whoever can still hear it, also when the app already ran at 1 (the
    /// relay keeps the app's speed for editors that join later; QA 0.2.0, N7), or right after the next
    /// hello when the connection is down.
    private func restoreTime() {
        let was = clocks.scale
        clocks.restore(now: CACurrentMediaTime())
        if was != 1 { mark(.time(.init(t: elapsed(), scale: 1))) }
        if connection.isOpen { send(.time(scale: 1, step: nil)) } else { timeDue = true }
    }

    /// A reset to 1x happened while the connection was down: the next hello is followed by `time 1`.
    private var timeDue = false

    // MARK: Visibility

    /// Animated layers that are recorded, a few times a second: the ones with animations attached, and
    /// the ones last seen out of sight (to see them come back).
    private func checkVisibility(now: CFTimeInterval) {
        var looked = Set<ObjectIdentifier>()
        for id in recording {
            guard let layer = signals.track(id)?.layer, looked.insert(ObjectIdentifier(layer)).inserted else { continue }
            let animating = (layer.animationKeys() ?? []).contains { !$0.hasPrefix("kf.") }
            if animating || watch.isOutOfSight(layer) { checkVisibility(of: layer, now: now) }
        }
    }

    /// A `visibility` marker for each recorded signal of `layer` when it went out of sight or came back.
    private func checkVisibility(of layer: CALayer, now: CFTimeInterval, adding: Bool = false) {
        guard let change = watch.visibilityChange(of: layer, adding: adding) else { return }
        let t = elapsed(now)
        for id in signals.ids(of: layer) where recording.contains(id) {
            mark(.visibility(.init(t: t, id: id, visible: change.visible, reason: change.reason)))
        }
    }
}

/// A CADisplayLink that runs only while something needs frames, asking for the display's top rate.
@MainActor final class Ticker {
    var onFrame: ((CADisplayLink) -> Void)?
    private var link: CADisplayLink?
    /// The display's top rate (it changes with Low Power Mode).
    var hz: Double = 120 {
        didSet { link?.preferredFrameRateRange = Self.range(hz) }
    }

    private static func range(_ hz: Double) -> CAFrameRateRange {
        let top = Float(max(hz, 30))
        return CAFrameRateRange(minimum: min(60, top), maximum: top, preferred: top)
    }

    func set(running: Bool) {
        if running, link == nil {
            let link = CADisplayLink(target: LinkTarget(self), selector: #selector(LinkTarget.tick(_:)))
            link.preferredFrameRateRange = Self.range(hz)
            link.add(to: .main, forMode: .common)
            self.link = link
        } else if !running, let link {
            link.invalidate()
            self.link = nil
        }
    }

    fileprivate func tick(_ link: CADisplayLink) {
        onFrame?(link)
    }
}

/// CADisplayLink retains its target; this one only points back weakly.
private final class LinkTarget: NSObject {
    weak var owner: Ticker?

    init(_ owner: Ticker) {
        self.owner = owner
    }

    @objc func tick(_ link: CADisplayLink) {
        MainActor.assumeIsolated { owner?.tick(link) }
    }
}

enum ScreenCapture {
    /// The key window as base64 JPEG or PNG, `width` points wide when asked (one pixel per point
    /// otherwise, which keeps frames small enough for the relay).
    @MainActor static func snapshot(width: Double?, format: String, quality: Double) -> String? {
        guard let window = UIApplication.shared.kf_keyWindow else { return nil }
        let bounds = window.bounds
        let rendererFormat = UIGraphicsImageRendererFormat()
        rendererFormat.scale = width.map { $0 / bounds.width } ?? 1
        rendererFormat.opaque = true
        let image = UIGraphicsImageRenderer(bounds: bounds, format: rendererFormat).image { _ in
            // afterScreenUpdates: the render server's picture, animations (and pins) included.
            window.drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        let data = format == "png" ? image.pngData() : image.jpegData(compressionQuality: quality)
        return data?.base64EncodedString()
    }
}
#endif
