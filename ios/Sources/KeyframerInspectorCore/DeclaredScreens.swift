#if DEBUG || KEYFRAMER_INSPECTOR_RELEASE
import Foundation

/// The screens an app names itself (`.keyframerScreen("Settings")` in SwiftUI), in the order they
/// appeared. In a SwiftUI app every screen lives in one hosting controller, so view controllers say
/// nothing about where the app is: the route is the latest named screen still shown, and when it goes,
/// the one under it (a sheet dismissed, a pushed view popped).
public struct DeclaredScreens: Sendable {
    private var shown: [(id: UUID, name: String)] = []

    public init() {}

    /// The route now: the latest named screen still shown.
    public var top: String? { shown.last?.name }

    public var isEmpty: Bool { shown.isEmpty }

    /// A named screen appeared (again): it is the route.
    public mutating func appear(_ id: UUID, name: String) {
        shown.removeAll { $0.id == id }
        shown.append((id, name))
    }

    /// The same screen under a new name (a pager showing another page), in place.
    public mutating func rename(_ id: UUID, to name: String) {
        guard let i = shown.firstIndex(where: { $0.id == id }) else { return }
        shown[i].name = name
    }

    public mutating func disappear(_ id: UUID) {
        shown.removeAll { $0.id == id }
    }
}
#endif
