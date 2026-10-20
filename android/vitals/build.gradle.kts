// Motion Vitals for Android (MIT): slow frames from production, in release builds.
//   implementation("dev.keyframer:vitals:<version>")
// Apart from the inspector on purpose: it is a production dependency, small, with no OkHttp and no
// WorkManager. Frames come from JankStats (FrameMetrics), passively.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "dev.keyframer.vitals"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
        buildConfigField("String", "SDK_VERSION", "\"${project.property("VERSION_NAME")}\"")
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    testOptions {
        // The reporter's logic is plain Kotlin; the few Android calls it makes return defaults in unit tests.
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

dependencies {
    // JankStats: every frame the app draws, from FrameMetrics (API 24+), with the deadline on API 31+.
    implementation("androidx.metrics:metrics-performance:1.0.0")
    // ProcessLifecycleOwner: the app going to the background closes and sends the window.
    implementation("androidx.lifecycle:lifecycle-process:2.8.3")

    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}

// The golden report every SDK matches (written by the React Native reporter's tests).
val vitalsFixtures = rootProject.layout.projectDirectory.dir("../protocol/fixtures/vitals")

tasks.withType<Test>().configureEach {
    systemProperty("keyframer.vitals.fixtures", vitalsFixtures.asFile.absolutePath)
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
