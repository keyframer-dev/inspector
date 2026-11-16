#if canImport(UIKit) && !(DEBUG || KEYFRAMER_INSPECTOR_RELEASE)
import SwiftUI

// A Release build compiles the inspector out (unless the package's `ReleaseBuilds` trait is on): the
// same API, as plain SwiftUI. See KeyframerInspector's CompiledOut.swift.

/// `withAnimation`: the inspector is compiled out of this build.
@discardableResult
public func withKeyframerAnimation<Result>(
    _ animation: Animation? = .default, owner: String? = nil,
    file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column,
    _ body: () throws -> Result
) rethrows -> Result {
    try withAnimation(animation, body)
}

extension View {
    /// The view itself: the inspector is compiled out of this build.
    public func keyframerTrace<V: VectorArithmetic>(
        _ name: String, value: V, owner: String? = nil,
        file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column
    ) -> some View {
        self
    }

    @_disfavoredOverload
    public func keyframerTrace<V: Animatable>(
        _ name: String, value: V, owner: String? = nil,
        file: String = #fileID, filePath: String = #filePath, line: Int = #line, column: Int = #column
    ) -> some View {
        self
    }

    public func keyframerScreen(_ name: String) -> some View {
        self
    }
}
#endif
