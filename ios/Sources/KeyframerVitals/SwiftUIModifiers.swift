#if canImport(UIKit) && canImport(SwiftUI)
import SwiftUI

// SwiftUI runs its animations itself (never through Core Animation's addAnimation:forKey:), so SwiftUI
// screens and animations are named by the app: `.vitalsScreen` where a screen appears, `.vitalsTrace`
// on a value whose changes animate, or `KeyframerVitals.trace` around a `withAnimation`. Without them,
// frames are still counted per hosting controller, with no site.

extension View {
    /// Names the screen this view is: reported from when it appears (`setScreen`).
    ///
    ///     FeedView().vitalsScreen("Feed")
    public func vitalsScreen(_ name: String) -> some View {
        modifier(VitalsScreenModifier(name: name))
    }

    /// Charges a motion window of `duration` seconds (0.5 by default) to `name` each time `value`
    /// changes: put it on the value an animation drives.
    ///
    ///     CardView(expanded: expanded)
    ///         .vitalsTrace("card-expand", value: expanded)
    public func vitalsTrace<V: Equatable>(_ name: String, value: V, duration: TimeInterval? = nil) -> some View {
        modifier(VitalsTraceModifier(name: name, value: value, duration: duration))
    }
}

struct VitalsScreenModifier: ViewModifier {
    let name: String

    func body(content: Content) -> some View {
        content.onAppear {
            MainActor.assumeIsolated {
                VitalsRuntime.shared?.setScreen(name, explicit: true)
            }
        }
    }
}

struct VitalsTraceModifier<V: Equatable>: ViewModifier {
    let name: String
    let value: V
    let duration: TimeInterval?

    func body(content: Content) -> some View {
        content.onChange(of: value) { _ in
            MainActor.assumeIsolated {
                VitalsRuntime.shared?.traced(name, duration: duration)
            }
        }
    }
}
#endif
