// swift-tools-version:5.9
// The iOS SDK, resolvable from this repository's URL. ios/Package.swift is the same package for
// working inside ios/.
import PackageDescription

let package = Package(
    name: "KeyframerInspector",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "KeyframerInspector", targets: ["KeyframerInspector"]),
    ],
    targets: [
        .target(name: "KeyframerInspectorCore", path: "ios/Sources/KeyframerInspectorCore"),
        .target(name: "KeyframerInspector", dependencies: ["KeyframerInspectorCore"], path: "ios/Sources/KeyframerInspector"),
        .testTarget(
            name: "KeyframerInspectorCoreTests",
            dependencies: ["KeyframerInspectorCore"],
            path: "ios/Tests/KeyframerInspectorCoreTests",
            resources: [.copy("Fixtures")]
        ),
        .testTarget(name: "KeyframerInspectorTests", dependencies: ["KeyframerInspector"], path: "ios/Tests/KeyframerInspectorTests"),
    ]
)
