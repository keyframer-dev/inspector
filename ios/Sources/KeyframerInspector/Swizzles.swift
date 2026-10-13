#if canImport(UIKit)
import ObjectiveC
import QuartzCore
import UIKit

/// The three choke points, swizzled once per process and pass-through while no inspector runs:
///
/// - `-[CALayer addAnimation:forKey:]`: every Core Animation animation, whoever builds it. UIKit's
///   `UIView.animate` and `UIViewPropertyAnimator` end up here too, while the app's animation block is
///   still on the stack, which is what makes the call site findable.
/// - `-[UIApplication sendEvent:]`: every touch, before any view or gesture recognizer sees it.
/// - `-[UIViewController viewDidAppear:]`: screen changes.
enum Swizzles {
    private static var installed = false

    static func installOnce() {
        guard !installed else { return }
        installed = true
        exchange(CALayer.self, #selector(CALayer.add(_:forKey:)), #selector(CALayer.kf_add(_:forKey:)))
        exchange(UIApplication.self, #selector(UIApplication.sendEvent(_:)), #selector(UIApplication.kf_sendEvent(_:)))
        exchange(UIViewController.self, #selector(UIViewController.viewDidAppear(_:)), #selector(UIViewController.kf_viewDidAppear(_:)))
    }

    private static func exchange(_ cls: AnyClass, _ original: Selector, _ replacement: Selector) {
        guard let o = class_getInstanceMethod(cls, original), let r = class_getInstanceMethod(cls, replacement) else { return }
        // A subclass that inherits the method gets its own copy first, so the parent is untouched.
        if class_addMethod(cls, original, method_getImplementation(r), method_getTypeEncoding(r)) {
            class_replaceMethod(cls, replacement, method_getImplementation(o), method_getTypeEncoding(o))
        } else {
            method_exchangeImplementations(o, r)
        }
    }
}

extension CALayer {
    /// After the exchange, calling `kf_add` runs the original `add(_:forKey:)`.
    @objc func kf_add(_ anim: CAAnimation, forKey key: String?) {
        if let key, key.hasPrefix("kf.") { return kf_add(anim, forKey: key) }
        // The stack is taken here, synchronously: later, the code that started it is gone.
        let replacement = AnimationTap.willAdd(anim, forKey: key, to: self)
        kf_add(replacement ?? anim, forKey: key)
    }
}

extension UIApplication {
    @objc func kf_sendEvent(_ event: UIEvent) {
        Inspector.shared?.handle(event)
        kf_sendEvent(event)
    }
}

extension UIViewController {
    @objc func kf_viewDidAppear(_ animated: Bool) {
        kf_viewDidAppear(animated)
        Inspector.shared?.didAppear(self)
    }
}

/// Carries the edited animation out of `assumeIsolated` (same thread, nothing actually crosses).
private struct Handoff: @unchecked Sendable {
    let value: CAAnimation?
    init(_ value: CAAnimation?) { self.value = value }
}

enum AnimationTap {
    /// Read from any thread before anything costly (the stack) is taken.
    nonisolated(unsafe) static var isActive = false

    /// Returns an edited copy when the panel overrides this call site's parameters.
    static func willAdd(_ anim: CAAnimation, forKey key: String?, to layer: CALayer) -> CAAnimation? {
        guard isActive else { return nil }
        if Thread.isMainThread {
            return MainActor.assumeIsolated {
                guard let inspector = Inspector.shared else { return Handoff(nil) }
                return Handoff(inspector.willAdd(anim, forKey: key, to: layer, symbols: Thread.callStackSymbols))
            }.value
        }
        // Off the main thread (rare): reported, never edited.
        let symbols = Thread.callStackSymbols
        DispatchQueue.main.async {
            _ = Inspector.shared?.willAdd(anim, forKey: key, to: layer, symbols: symbols, editable: false)
        }
        return nil
    }
}
#endif
