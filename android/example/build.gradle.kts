plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val relayHost = (findProperty("keyframer.host") as String?).orEmpty()
val relayPort = (findProperty("keyframer.port") as String?)?.toIntOrNull() ?: 8790

android {
    namespace = "dev.keyframer.example"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.keyframer.example"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1"
        // Empty: the SDK picks 10.0.2.2 on the emulator and 127.0.0.1 (adb reverse) on a device.
        buildConfigField("String", "KEYFRAMER_HOST", "\"$relayHost\"")
        buildConfigField("int", "KEYFRAMER_PORT", "$relayPort")
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

dependencies {
    debugImplementation(project(":keyframer-inspector"))
    // Release builds link the no-op: the same API, nothing running, no OkHttp.
    releaseImplementation(project(":keyframer-inspector-noop"))
    // The Compose screen: tracked animations in debug, Compose's own in release.
    debugImplementation(project(":keyframer-inspector-compose"))
    releaseImplementation(project(":keyframer-inspector-compose-noop"))
    implementation("androidx.activity:activity-compose:1.10.1")
    implementation("androidx.compose.foundation:foundation:1.7.6")
}
