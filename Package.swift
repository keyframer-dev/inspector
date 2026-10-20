// swift-tools-version:5.9
// The iOS SDK, resolvable from this repository's URL. ios/Package.swift is the same package for
// working inside ios/.
import PackageDescription

let package = Package(
    name: "KeyframerInspector",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "KeyframerInspector", targets: ["KeyframerInspector"]),
        .library(name: "KeyframerInspectorSwiftUI", targets: ["KeyframerInspectorSwiftUI"]),
        // Motion Vitals, the production reporter (MIT); separate from the development inspector.
        .library(name: "KeyframerVitals", targets: ["KeyframerVitals"]),
    ],
    targets: [
        .target(name: "KeyframerInspectorCore", path: "ios/Sources/KeyframerInspectorCore"),
        .target(name: "KeyframerInspector", dependencies: ["KeyframerInspectorCore"], path: "ios/Sources/KeyframerInspector"),
        .target(
            name: "KeyframerInspectorSwiftUI",
            dependencies: ["KeyframerInspector", "KeyframerInspectorCore"],
            path: "ios/Sources/KeyframerInspectorSwiftUI"
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
    ]
)
