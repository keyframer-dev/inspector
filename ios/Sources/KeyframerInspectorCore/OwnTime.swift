#if DEBUG || KEYFRAMER_INSPECTOR_RELEASE
import Foundation

/// The inspector's own time on the main thread, for the frame meter's `inspectorMs`. Each of the
/// inspector's entry points there (a swizzled `addAnimation:forKey:`, a SwiftUI stamp or trace, the
/// per-frame sampling, the editor's messages, the batches going out) runs inside `measure`; only the
/// outermost one is timed when they nest, and the app code an entry point calls back into (a replay,
/// the original `addAnimation:forKey:`) is left out with `notOurs`. The meter takes what built up over
/// each frame with `take`. Main thread only: work elsewhere does not hold a frame up, and is not timed.
public enum OwnTime {
    nonisolated(unsafe) private static var depth = 0
    nonisolated(unsafe) private static var started: UInt64 = 0
    nonisolated(unsafe) private static var excluded: UInt64 = 0
    nonisolated(unsafe) private static var total: UInt64 = 0

    @inline(__always) private static func now() -> UInt64 {
        clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
    }

    /// Runs `body`, counting its time as the inspector's when it runs on the main thread.
    @inline(__always) public static func measure<T>(_ body: () throws -> T) rethrows -> T {
        guard pthread_main_np() != 0 else { return try body() }
        if depth == 0 {
            started = now()
            excluded = 0
        }
        depth += 1
        defer {
            depth -= 1
            if depth == 0 {
                let spent = now() &- started
                total &+= spent > excluded ? spent - excluded : 0
            }
        }
        return try body()
    }

    /// Runs `body`, the app's code called from inside `measure`, without counting it.
    @inline(__always) public static func notOurs<T>(_ body: () throws -> T) rethrows -> T {
        guard depth > 0, pthread_main_np() != 0 else { return try body() }
        let start = now()
        defer { excluded &+= now() &- start }
        return try body()
    }

    /// The inspector's time since the last call, in ms.
    public static func take() -> Double {
        guard pthread_main_np() != 0 else { return 0 }
        let ns = total
        total = 0
        return Double(ns) / 1_000_000
    }
}
#endif
