// swift-tools-version:6.1
// The iOS SDK, resolvable from this repository's URL. ios/Package.swift is the same package for
// working inside ios/.
import PackageDescription

// The development inspector is compiled only into Debug builds (Release builds get the same API doing
// nothing); the `ReleaseBuilds` trait keeps it in Release builds. See ios/Package.swift.
let inspectorSettings: [SwiftSetting] = [.define("KEYFRAMER_INSPECTOR_RELEASE", .when(traits: ["ReleaseBuilds"]))]

let package = Package(
    name: "KeyframerInspector",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "KeyframerInspector", targets: ["KeyframerInspector"]),
        .library(name: "KeyframerInspectorSwiftUI", targets: ["KeyframerInspectorSwiftUI"]),
        // Motion Vitals, the production reporter (MIT); separate from the development inspector.
        .library(name: "KeyframerVitals", targets: ["KeyframerVitals"]),
    ],
    traits: [
        .trait(name: "ReleaseBuilds", description: "Keep the development inspector in Release builds (it is compiled out of them otherwise)."),
    ],
    targets: [
        .target(name: "KeyframerInspectorCore", path: "ios/Sources/KeyframerInspectorCore", swiftSettings: inspectorSettings),
        .target(name: "KeyframerInspector", dependencies: ["KeyframerInspectorCore"], path: "ios/Sources/KeyframerInspector", swiftSettings: inspectorSettings),
        .target(
            name: "KeyframerInspectorSwiftUI",
            dependencies: ["KeyframerInspector", "KeyframerInspectorCore"],
            path: "ios/Sources/KeyframerInspectorSwiftUI",
            swiftSettings: inspectorSettings
        ),
        .testTarget(
            name: "KeyframerInspectorCoreTests",
            dependencies: ["KeyframerInspectorCore"],
            path: "ios/Tests/KeyframerInspectorCoreTests",
            resources: [.copy("Fixtures")]
        ),
        .testTarget(name: "KeyframerInspectorTests", dependencies: ["KeyframerInspector"], path: "ios/Tests/KeyframerInspectorTests"),
        .testTarget(name: "KeyframerInspectorSwiftUITests", dependencies: ["KeyframerInspectorSwiftUI"], path: "ios/Tests/KeyframerInspectorSwiftUITests"),
        .target(name: "KeyframerVitals", path: "ios/Sources/KeyframerVitals", resources: [.copy("PrivacyInfo.xcprivacy")]),
        .testTarget(
            name: "KeyframerVitalsTests",
            dependencies: ["KeyframerVitals", "KeyframerInspectorCore"],
            path: "ios/Tests/KeyframerVitalsTests"
        ),
    ],
    // The sources are written for the Swift 5 language mode (what tools 5.9 gave them).
    swiftLanguageModes: [.v5]
)
