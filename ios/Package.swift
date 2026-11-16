// swift-tools-version:6.1
import PackageDescription

// The development inspector (KeyframerInspector, its core and its SwiftUI module) is compiled only into
// Debug builds: Xcode links every package product a target depends on in every configuration, and a
// Release binary kept all of it, inert (about 770 KB of code). A Release build gets the same API doing
// nothing. The `ReleaseBuilds` trait keeps it in Release builds (to measure an optimized build), where it
// starts with `allowInRelease` or `KEYFRAMER_INSPECTOR=1`.
let inspectorSettings: [SwiftSetting] = [.define("KEYFRAMER_INSPECTOR_RELEASE", .when(traits: ["ReleaseBuilds"]))]

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
    traits: [
        .trait(name: "ReleaseBuilds", description: "Keep the development inspector in Release builds (it is compiled out of them otherwise)."),
    ],
    targets: [
        // The wire protocol and every pure piece (stack parsing, frame meter, key paths, animation
        // descriptions, time control, visibility and render hint rules). Foundation and QuartzCore only,
        // so `swift test` runs it on macOS.
        .target(name: "KeyframerInspectorCore", swiftSettings: inspectorSettings),
        // The UIKit side: connection, swizzles, sampling, playback and scrubbing, time control. Compiles
        // to nothing where UIKit is missing.
        .target(name: "KeyframerInspector", dependencies: ["KeyframerInspectorCore"], swiftSettings: inspectorSettings),
        // SwiftUI tracing on top of the UIKit side. Its animation descriptions build on macOS too (for
        // `swift test`); the rest needs UIKit.
        .target(name: "KeyframerInspectorSwiftUI", dependencies: ["KeyframerInspector", "KeyframerInspectorCore"], swiftSettings: inspectorSettings),
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
    ],
    // The sources are written for the Swift 5 language mode (what tools 5.9 gave them).
    swiftLanguageModes: [.v5]
)
