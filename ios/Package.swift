// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "KeyframerInspector",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "KeyframerInspector", targets: ["KeyframerInspector"]),
        // Opt-in: `.keyframerTrace` and `withKeyframerAnimation` for SwiftUI views.
        .library(name: "KeyframerInspectorSwiftUI", targets: ["KeyframerInspectorSwiftUI"]),
        // Motion Vitals: the production slow-frame reporter (MIT). Release-safe and separate from the
        // development inspector: it links none of the targets above.
        .library(name: "KeyframerVitals", targets: ["KeyframerVitals"]),
    ],
    targets: [
        // The wire protocol and every pure piece (stack parsing, frame meter, key paths, animation
        // descriptions, time control, visibility and render hint rules). Foundation and QuartzCore only,
        // so `swift test` runs it on macOS.
        .target(name: "KeyframerInspectorCore"),
        // The UIKit side: connection, swizzles, sampling, playback and scrubbing, time control. Compiles
        // to nothing where UIKit is missing.
        .target(name: "KeyframerInspector", dependencies: ["KeyframerInspectorCore"]),
        // SwiftUI tracing on top of the UIKit side. Its animation descriptions build on macOS too (for
        // `swift test`); the rest needs UIKit.
        .target(name: "KeyframerInspectorSwiftUI", dependencies: ["KeyframerInspector", "KeyframerInspectorCore"]),
        .testTarget(
            name: "KeyframerInspectorCoreTests",
            dependencies: ["KeyframerInspectorCore"],
            resources: [.copy("Fixtures")]
        ),
        // Runs on an iOS simulator (xcodebuild test); empty on macOS.
        .testTarget(name: "KeyframerInspectorTests", dependencies: ["KeyframerInspector"]),
        .testTarget(name: "KeyframerInspectorSwiftUITests", dependencies: ["KeyframerInspectorSwiftUI"]),
        // Foundation, QuartzCore and UIKit only; the UIKit and SwiftUI parts compile to nothing on macOS,
        // so `swift test` runs the counting, sessions, storage, upload and Mach-O math there.
        .target(name: "KeyframerVitals", resources: [.copy("PrivacyInfo.xcprivacy")]),
        // The inspector's core is a test dependency only: the frame meter parity test.
        .testTarget(name: "KeyframerVitalsTests", dependencies: ["KeyframerVitals", "KeyframerInspectorCore"]),
    ]
)
