#if canImport(UIKit) && (DEBUG || KEYFRAMER_INSPECTOR_RELEASE)
import QuartzCore
import UIKit

/// A value the app pushes instead of a layer property: what KeyframerInspectorSwiftUI's traces sample.
/// One per traced view, freed with it, which takes its signals out of the catalog.
@_spi(SwiftUI) public final class KeyframerValueSource {
    /// One scalar per signal (`x`, `y` for a point), the value shown now.
    public var values: [Double]

    public init(values: [Double] = []) {
        self.values = values
    }
}

/// How KeyframerInspectorSwiftUI reports through the running inspector. Not API for apps: it is
/// `@_spi(SwiftUI)`, and changes with the SwiftUI module.
@_spi(SwiftUI) @MainActor public enum SwiftUIBridge {
    public static var isRunning: Bool { Inspector.shared != nil }

    /// The running inspector, as an identity: a trace registered with another one (stopped, started
    /// again) registers again.
    public static var session: AnyObject? { Inspector.shared }

    /// While recording, a stamped call site also carries its stack.
    public static var isRecording: Bool { Inspector.shared?.isRecording ?? false }

    /// The app traces SwiftUI: its hello says `framework: "swiftui"` (sent again when it already said uikit).
    public static func markUsed() {
        guard !Inspector.usesSwiftUI else { return }
        Inspector.usesSwiftUI = true
        Inspector.shared?.frameworkChanged()
    }

    /// `.keyframerScreen`: a named screen appeared (or appeared again).
    public static func screen(_ id: UUID, appeared name: String) {
        Registry.screens.appear(id, name: name)
        Inspector.shared?.screensChanged()
    }

    /// `.keyframerScreen` given another name while shown.
    public static func screen(_ id: UUID, renamed name: String) {
        Registry.screens.rename(id, to: name)
        Inspector.shared?.screensChanged()
    }

    public static func screenDisappeared(_ id: UUID) {
        Registry.screens.disappear(id)
        Inspector.shared?.screensChanged()
    }

    /// withKeyframerAnimation started, while recording: what it moves is watched, as signals of this
    /// call site (`owner`), while it moves.
    public static func animationBegan(_ stamp: AnyObject, file: String, line: Int, column: Int, owner: String) {
        Inspector.shared?.animationBegan(ObjectIdentifier(stamp), site: .init(file: file, line: line, column: column, owner: owner))
    }

    /// The first signal what `stamp` started moved, for its anim event's target.
    public static func movedSignal(of stamp: AnyObject) -> String? {
        Inspector.shared?.movedSignal(of: ObjectIdentifier(stamp))
    }

    /// The editor's speed (the `time` message): 1 normal, 0 paused.
    public static var timeScale: Double { Inspector.shared?.timeScale ?? 1 }

    /// `file` (#fileID) relative to the configured source root when `filePath` is inside it, like
    /// `KeyframerInspector.trace` call sites.
    public static func path(file: String, filePath: String) -> String {
        ExplicitSite(file: file, filePath: filePath, line: 0, column: 0, name: nil).path(under: Inspector.shared?.config.sourceRoot)
    }

    /// Registers the scalars of `source` as signals (`sites[i]` reads `source.values[i]`).
    public static func register(_ source: KeyframerValueSource, sites: [InspectorSignalSite]) {
        Inspector.shared?.track(source: source, sites: sites)
    }

    /// The panel's edits for this call site (`"1.duration"` → value), if any.
    public static func overrides(for siteId: String) -> [String: Double]? {
        Inspector.shared?.overrides(for: siteId)
    }

    /// Reports one SwiftUI animation. `stack`: where it was started, when known (taken inside
    /// withKeyframerAnimation while recording, as return addresses; read off the main thread).
    public static func report(site: InspectorCallSite, args: [JSONValue], durationMs: Double?, stack: CapturedStack?) {
        Inspector.shared?.report(site: site, args: args, durationMs: durationMs, stack: stack)
    }
}
#endif
