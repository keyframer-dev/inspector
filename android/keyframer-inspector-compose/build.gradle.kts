// Jetpack Compose for the inspector, in debug builds:
//   debugImplementation("dev.keyframer:keyframer-inspector-compose:<version>")
//   releaseImplementation("dev.keyframer:keyframer-inspector-compose-noop:<version>")
// Each brings its base module (keyframer-inspector, or the no-op), so these two lines are all an app needs.
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "dev.keyframer.inspector.compose"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    buildFeatures {
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
    api(project(":keyframer-inspector"))
    // The oldest Compose this works with: an app's newer Compose wins the version resolution.
    api("androidx.compose.animation:animation:1.7.6")
    implementation("androidx.compose.ui:ui:1.7.6")
}
