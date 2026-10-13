pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "keyframer-inspector-android"

// Pure Kotlin (JVM): protocol, JSON, call sites, frame meter, the session. Tests run without Android.
include(":keyframer-inspector-core")
// The Android library apps add: animators, Choreographer, touches, activities, screenshots.
include(":keyframer-inspector")
// What release builds link instead: the same API, doing nothing, no dependencies.
include(":keyframer-inspector-noop")
// A Views app to try it on: an entrance, a loop, a drag and a second screen.
include(":example")
// A stand-in for the desktop relay (ws://127.0.0.1:8790), with a scripted editor for checks.
include(":fake-relay")
