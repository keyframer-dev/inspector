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
///
/// Clocks: a recording's `t` is ms since `record` on, in media time (CACurrentMediaTime), the clock
/// of display link timestamps and touch timestamps, so nothing needs re-basing. `at` is wall clock.
@MainActor final class Inspector {
    static var shared: Inspector? {
        didSet { AnimationTap.isActive = shared != nil }
    }

    private static let maxQueuedEvents = 2000
    private static let maxSamplesPerMessage = 3000
    private static let maxRecordedAnimations = 400
    static let sdkVersion = "0.1.0"

    let config: KeyframerInspector.Configuration
    private let resolver: CallSiteResolver
    private let connection: Connection
    private let signals = SignalRegistry()
    private let pins = PinBoard()
    private let scrubber = Scrubber()
    private let ticker = Ticker()

    private var overrides: InspectorOverrides = [:]
    private var nextEid = 1
    private var editors = 0
    private var symbolNames: [String: SymbolName] = [:]

    // Outgoing, flushed every 100 ms.
    private var queue: [InspectorEvent] = []
    private var samples: [InspectorSample] = []
    private var frames: [InspectorFrameStat] = []
    private var drops: [InspectorFrameDrop] = []
    private var markers: [InspectorMarker] = []
    private var flushTimer: Timer?

    // Recording.
    private var recording = Set<String>()
    private var recordAll = false
    private var recordStart: CFTimeInterval = 0
    private var lastRecordStart: CFTimeInterval?
    private var compressor = SampleCompressor()
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

    private var isRecording: Bool { recordAll || !recording.isEmpty }

    init(config: KeyframerInspector.Configuration) {
        self.config = config
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
        connection.connect()
        var ticks = 0
        flushTimer = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                // Once a second: layers that were freed leave the catalog.
                ticks += 1
                if ticks % 10 == 0 { self?.pruneSignals() }
                self?.flush()
            }
        }
        RunLoop.main.add(flushTimer!, forMode: .common)
    }

    func stop() {
        flushTimer?.invalidate()
        if isRecording { measure(false) }
        recording = []
        recordAll = false
        run = nil
        pins.releaseAll()
        scrubber.end()
        ticker.set(running: false)
        connection.stop()
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
        let capabilities = (config.captureScreen ? ["capture"] : []) + ["playback", "scrub", "overrides", "replay", "scenarios"]
        send(.appHello(AppHello(
            app: config.appName,
            platform: "ios",
            capture: config.captureScreen,
            screen: screen.map { InspectorScreen(width: $0.bounds.width, height: $0.bounds.height, scale: $0.scale) },
            scenarios: Registry.scenarioNames,
            protocol: 1,
            sdk: InspectorSDK(name: "KeyframerInspector", version: Self.sdkVersion),
            framework: "uikit",
            osVersion: UIDevice.current.systemVersion,
            build: Self.build,
            threads: ["js": InspectorThreadInfo(label: "Main", animates: true)],
            capabilities: capabilities,
            root: config.sourceRoot
        )))
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
        let sites = signals.sites
        if !sites.isEmpty { send(.events(sites.map(InspectorEvent.signal))) }
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
        case .record(let ids, let on):
            setRecording(ids, on: on)
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
        case .presence(let p):
            if p.editors > editors { sendCatalog() }
            editors = p.editors
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

    private func setRecording(_ ids: [String], on: Bool) {
        let was = isRecording
        let all = ids.contains("*")
        if on {
            if !was {
                releasePlayback()
                recordStart = CACurrentMediaTime()
                lastRecordStart = recordStart
                compressor = SampleCompressor()
            }
            if all { recordAll = true }
            recording.formUnion(all ? signals.ids : ids)
        } else if all {
            recordAll = false
            recording.removeAll()
        } else {
            recording.subtract(ids)
        }
        if was != isRecording { measure(isRecording) }
    }

    private func measure(_ on: Bool) {
        if on {
            meter = FrameMeter(thread: .js)
            lastTouchMove = [:]
            lastRoute = nil
            if let route = currentRoute() { mark(route: route.0, params: route.1) }
            let center = NotificationCenter.default
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
        }
        updateTicker()
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
            guard let track = signals.track(id), let layer = track.layer else { continue }
            let source = layer.presentation() ?? layer
            guard let v = LayerValue.number(source.value(forKeyPath: track.path)) else { continue }
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
            // No line numbers at runtime: the function is the place, its offset tells call sites apart.
            (file, line, column) = (r.name.display, 0, 0)
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
        let begin = Self.beginMedia(of: effective, on: layer, now: now)
        let info = AnimationInfo(effective, delayMs: max(0, (begin - now) * 1000), from: presented, to: model)
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
        remember(effective, on: layer, begin: begin, from: presented, to: model)
        return edited
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

    /// When an animation begins, in media time. Core Animation's private `beginTimeMode` says how to
    /// read beginTime: UIKit uses "relative" (a delay after the commit, so `delay: 0.1` is 0.1); the
    /// default "non-zero" reads 0 as now and anything else as the layer's local time.
    static func beginMedia(of anim: CAAnimation, on layer: CALayer, now: CFTimeInterval) -> CFTimeInterval {
        if (anim.value(forKey: "beginTimeMode") as? String) == "relative" { return now + anim.beginTime }
        return anim.beginTime > 0 ? layer.convertTime(anim.beginTime, to: nil) : now
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
        scrubber.seek(toMedia: base + t / 1000, live: signals.animatedLayers(), recorded: recorded.filter { $0.layer != nil })
        updateTicker()
    }
}

/// A CADisplayLink that runs only while something needs frames, asking for the display's top rate.
@MainActor final class Ticker {
    var onFrame: ((CADisplayLink) -> Void)?
    private var link: CADisplayLink?

    func set(running: Bool) {
        if running, link == nil {
            let link = CADisplayLink(target: LinkTarget(self), selector: #selector(LinkTarget.tick(_:)))
            if #available(iOS 15.0, *) {
                link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            }
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
