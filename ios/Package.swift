// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "KeyframerInspector",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "KeyframerInspector", targets: ["KeyframerInspector"]),
    ],
    targets: [
        // The wire protocol and every pure piece (stack parsing, frame meter, key paths, animation
        // descriptions). Foundation and QuartzCore only, so `swift test` runs it on macOS.
        .target(name: "KeyframerInspectorCore"),
        // The UIKit side: connection, swizzles, sampling, playback and scrubbing. Compiles to nothing
        // where UIKit is missing.
        .target(name: "KeyframerInspector", dependencies: ["KeyframerInspectorCore"]),
        .testTarget(
            name: "KeyframerInspectorCoreTests",
            dependencies: ["KeyframerInspectorCore"],
            resources: [.copy("Fixtures")]
        ),
        // Runs on an iOS simulator (xcodebuild test); empty on macOS.
        .testTarget(name: "KeyframerInspectorTests", dependencies: ["KeyframerInspector"]),
    ]
)
