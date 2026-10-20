// Motion Vitals for Jetpack Compose (MIT): Compose's animation calls, named and tracked, and screens from
// Compose navigation.
//   implementation("dev.keyframer:vitals-compose:<version>")   // brings dev.keyframer:vitals
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.vanniktech.maven.publish")
}

android {
    namespace = "dev.keyframer.vitals.compose"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

dependencies {
    api(project(":vitals"))
    // The oldest Compose this works with: an app's newer Compose wins the version resolution.
    api("androidx.compose.animation:animation:1.7.6")
    // KfVitalsNavigation: only for apps that use Navigation (they bring it; nothing here loads it otherwise).
    compileOnly("androidx.navigation:navigation-runtime:2.7.7")

    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
}

tasks.withType<Test>().configureEach {
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
