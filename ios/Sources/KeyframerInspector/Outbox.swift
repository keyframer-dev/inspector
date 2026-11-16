#if canImport(UIKit) && (DEBUG || KEYFRAMER_INSPECTOR_RELEASE)
import Foundation

/// An event waiting for the next flush. An `anim` may still need its stack read, which happens on the
/// way out, off the main thread (Outbox): its `stack` and `frames` while recording, and for a Core
/// Animation add the UIKit API that started it (`fn`).
struct Outgoing {
    var event: InspectorEvent
    /// Where it was started, as return addresses (nothing looked up yet).
    var stack: CapturedStack? = nil
    /// Taken while recording: the event carries `stack` and `frames`.
    var withFrames = false
    /// `fn` becomes the UIKit API found on the stack when there is one (it is the animation's class until then).
    var apiFromStack = false
}

/// Where every message leaves, in order, through one serial queue. What costs and can wait happens
/// there, off the main thread: reading the stacks animations were started from (symbols, demangling,
/// formatting) and encoding JSON. The text then goes back to the main thread's connection. Nothing
/// overtakes what was posted before it (a scenario's events before its `scenarioDone`, a hello before
/// the catalog).
final class Outbox: @unchecked Sendable {
    private let queue = DispatchQueue(label: "dev.keyframer.inspector.outbox", qos: .utility)
    private let symbols: StackSymbols
    private let deliver: @MainActor (String) -> Void

    init(symbols: StackSymbols, deliver: @escaping @MainActor (String) -> Void) {
        self.symbols = symbols
        self.deliver = deliver
    }

    func post(_ message: InspectorMessage) {
        queue.async { [self] in send(message) }
    }

    func post(events: [Outgoing]) {
        queue.async { [self] in send(.events(events.map(finish))) }
    }

    /// Waits for everything posted so far to be handed to the main thread (tests).
    func drain() {
        queue.sync {}
    }

    private func send(_ message: InspectorMessage) {
        guard let text = try? InspectorJSON.encode(message) else { return }
        let deliver = self.deliver
        DispatchQueue.main.async {
            MainActor.assumeIsolated { OwnTime.measure { deliver(text) } }
        }
    }

    func finish(_ outgoing: Outgoing) -> InspectorEvent {
        guard case .anim(var event) = outgoing.event, let stack = outgoing.stack else { return outgoing.event }
        if outgoing.withFrames {
            // Once per stack: a withKeyframerAnimation moving three traced values shares one.
            let described = symbols.describe(stack)
            event.stack = described.stack
            event.frames = described.frames
        }
        if outgoing.apiFromStack, let api = Self.api(in: symbols.frames(of: stack)) { event.site.fn = api }
        return .anim(event)
    }

    /// The UIKit API that started an animation, from UIKit's frames near the top of the stack.
    static func api(in frames: StackFrames) -> String? {
        for i in 0..<min(24, frames.count) {
            let f = frames.frame(i)
            guard f.image == "UIKitCore" || f.image == "UIKit" else { continue }
            let s = f.symbol
            if s.contains("UIViewPropertyAnimator") { return "UIViewPropertyAnimator" }
            if s.contains("Keyframe") { return "UIView.animateKeyframes" }
            if s.contains("transitionWithView") || s.contains("transitionFromView") { return "UIView.transition" }
            if s.contains("UIViewAnimationState") || s.contains("UIViewAnimationWithBlocks") || s.contains("animateWithDuration") || s.contains("UIViewAnimationBlockDelegate") {
                return "UIView.animate"
            }
        }
        return nil
    }
}
#endif
