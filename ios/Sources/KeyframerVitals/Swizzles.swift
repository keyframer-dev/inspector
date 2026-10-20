#if canImport(UIKit)
import Foundation
import ObjectiveC
import QuartzCore
import UIKit

/// The choke points the development inspector uses (KeyframerInspector's Swizzles.swift), with their
/// own selectors so both can be installed in a debug build:
///
/// - `-[CALayer addAnimation:forKey:]`: every Core Animation animation; `UIView.animate` and
///   `UIViewPropertyAnimator` end up here while the app's code is still on the stack.
/// - `-[UIApplication sendEvent:]`: touches, for touch and scroll windows.
/// - `-[UIViewController viewWillAppear:]` / `viewDidAppear:`: navigation (`screen-mount`) and screens.
///
/// Installed the first time a session is sampled; pass-through (one flag read) whenever no sampled
/// session runs. Never `Thread.callStackSymbols`: return addresses only (`backtrace`, 32 frames).
enum VitalsSwizzles {
    @MainActor private static var installed = false

    @MainActor static func installOnce() {
        guard !installed else { return }
        installed = true
        exchange(CALayer.self, #selector(CALayer.add(_:forKey:)), #selector(CALayer.kfv_add(_:forKey:)))
        exchange(UIApplication.self, #selector(UIApplication.sendEvent(_:)), #selector(UIApplication.kfv_sendEvent(_:)))
        exchange(UIViewController.self, #selector(UIViewController.viewWillAppear(_:)), #selector(UIViewController.kfv_viewWillAppear(_:)))
        exchange(UIViewController.self, #selector(UIViewController.viewDidAppear(_:)), #selector(UIViewController.kfv_viewDidAppear(_:)))
    }

    private static func exchange(_ cls: AnyClass, _ original: Selector, _ replacement: Selector) {
        guard let o = class_getInstanceMethod(cls, original), let r = class_getInstanceMethod(cls, replacement) else { return }
        if class_addMethod(cls, original, method_getImplementation(r), method_getTypeEncoding(r)) {
            class_replaceMethod(cls, replacement, method_getImplementation(o), method_getTypeEncoding(o))
        } else {
            method_exchangeImplementations(o, r)
        }
    }
}

extension CALayer {
    /// After the exchange, calling `kfv_add` runs the original `add(_:forKey:)`.
    @objc func kfv_add(_ anim: CAAnimation, forKey key: String?) {
        if VitalsTap.isActive || VitalsTap.calibrating || VitalsTap.probe != nil { VitalsTap.willAdd(anim, forKey: key, to: self) }
        kfv_add(anim, forKey: key)
    }
}

extension UIApplication {
    @objc func kfv_sendEvent(_ event: UIEvent) {
        if VitalsTap.isActive, Thread.isMainThread {
            MainActor.assumeIsolated { VitalsRuntime.shared?.handle(event) }
        }
        kfv_sendEvent(event)
    }
}

extension UIViewController {
    @objc func kfv_viewWillAppear(_ animated: Bool) {
        kfv_viewWillAppear(animated)
        if VitalsTap.isActive { MainActor.assumeIsolated { VitalsRuntime.shared?.willAppear(self) } }
    }

    @objc func kfv_viewDidAppear(_ animated: Bool) {
        kfv_viewDidAppear(animated)
        if VitalsTap.isActive { MainActor.assumeIsolated { VitalsRuntime.shared?.didAppear(self) } }
    }
}

enum VitalsTap {
    /// Read from any thread before anything costly is done: a sampled session runs.
    nonisolated(unsafe) static var isActive = false
    nonisolated(unsafe) static var calibrating = false
    /// Return addresses at the top of the stack that belong to the reporter itself (and to any other
    /// swizzle of addAnimation:forKey: in between), measured by `calibrate`.
    nonisolated(unsafe) static var skip = 3
    nonisolated(unsafe) private static var calibration: [UInt] = []
    /// Tests only: receives the captured stack instead of the reporter.
    nonisolated(unsafe) static var probe: (([UInt]) -> Void)?
    private static let privateKeyPaths: Set<String> = ["uiFractionalProgress"]

    /// Measures how many frames sit between `-addAnimation:forKey:`'s caller and the stack capture: a
    /// known function adds an animation to a detached layer, and the capture finds that function's
    /// frame. The count holds for every later call, because the path from the caller to the capture is
    /// the same code (and stays right if another swizzle, the development inspector's, was installed
    /// in between, since it runs again at each sampled session).
    @MainActor static func calibrate() {
        calibrating = true
        let marker = calibrationCall()
        calibrating = false
        if let i = calibration.firstIndex(where: { $0 >= marker.lowerBound && $0 < marker.upperBound }) {
            skip = i
        }
        calibration = []
    }

    /// Adds a throwaway animation between two return-address markers: the add's own return address
    /// lies strictly between them, inside this function's code, and no other function's does.
    @inline(never) @MainActor private static func calibrationCall() -> Range<UInt> {
        let layer = CALayer()
        let animation = CABasicAnimation(keyPath: "opacity")
        let before = vitalsReturnAddresses(max: 2).first ?? 0
        layer.add(animation, forKey: "kfv.calibrate")
        let after = vitalsReturnAddresses(max: 2).first ?? 0
        return before < after ? (before + 1)..<after : 0..<0
    }

    /// Called synchronously from `-[CALayer addAnimation:forKey:]`. The stack is taken first, before
    /// anything else, so the frame count above the caller is the calibrated one.
    @inline(never)
    static func willAdd(_ anim: CAAnimation, forKey key: String?, to layer: CALayer) {
        let frames = vitalsReturnAddresses()
        if calibrating {
            if key == "kfv.calibrate" { calibration = frames }
            return
        }
        if let probe { return probe(frames) }
        // Off the main thread (rare): not measured.
        guard Thread.isMainThread else { return }
        if let key, key.hasPrefix("kf.") || key.hasPrefix("kfv.") { return }
        let keyPath = (anim as? CAPropertyAnimation)?.keyPath
        if let keyPath, privateKeyPaths.contains(keyPath) { return }
        MainActor.assumeIsolated {
            guard let runtime = VitalsRuntime.shared else { return }
            let duration = durationMs(of: anim, on: layer)
            let type = viewType(of: layer)
            let inBlock = UIView.inheritedAnimationDuration > 0
            let fn = inBlock ? "UIView.animate" : String(describing: Swift.type(of: anim))
            let info: SiteInfo?
            if let name = runtime.traceForStart() {
                info = SiteInfo(ref: .name(name, type: type), fn: fn, prop: keyPath, component: nil)
            } else if let site = runtime.images.callSite(frames, skip: skip, inBlock: inBlock) {
                info = SiteInfo(ref: .native(image: site.image.image, offset: site.offset, type: type), fn: fn, prop: keyPath, component: nil)
            } else {
                // Nothing of the app's on the stack (a system animation, a transaction flushed by the
                // run loop): it opens a motion window, attributed to no site.
                info = nil
            }
            runtime.animationStarted(info, durationMs: duration)
        }
    }

    /// The app's view class that owns the layer, when it is the app's own (`CardView`), else nil.
    @MainActor static func viewType(of layer: CALayer) -> String? {
        guard let view = layer.delegate as? UIView else { return nil }
        let cls: AnyClass = type(of: view)
        guard AppClasses.isApp(cls) else { return nil }
        return VitalsRuntime.cut(String(describing: cls))
    }

    /// How long it runs, delay included: delay + duration x repeats (twice when it autoreverses), at its
    /// speed (AnimationInfo.durationMs in the inspector). Nil when it repeats forever.
    static func durationMs(of anim: CAAnimation, on layer: CALayer) -> Double? {
        var seconds = anim.duration
        if anim.repeatDuration > 0 {
            guard anim.repeatDuration.isFinite else { return nil }
            seconds = anim.repeatDuration
        } else if anim.repeatCount > 0 {
            guard anim.repeatCount.isFinite, anim.repeatCount < 1e6 else { return nil }
            seconds *= Double(anim.repeatCount)
        }
        if anim.autoreverses { seconds *= 2 }
        if anim.speed > 0 { seconds /= Double(anim.speed) }
        // UIKit's delays are "relative" begin times (a delay after the commit); otherwise a beginTime
        // in the layer's local time.
        var delay = 0.0
        if (anim.value(forKey: "beginTimeMode") as? String) == "relative" {
            delay = anim.beginTime
        } else if anim.beginTime > 0 {
            delay = anim.beginTime - layer.convertTime(CACurrentMediaTime(), from: nil)
        }
        return (max(0, delay) + max(0, seconds)) * 1000
    }
}
#endif
