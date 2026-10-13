// The release-build stand-in for keyframer-inspector: the same API, doing nothing, with no dependencies.
//   debugImplementation("dev.keyframer:keyframer-inspector:<version>")
//   releaseImplementation("dev.keyframer:keyframer-inspector-noop:<version>")
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "dev.keyframer.inspector.noop"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
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
