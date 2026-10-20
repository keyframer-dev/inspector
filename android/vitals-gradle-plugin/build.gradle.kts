// The Motion Vitals Gradle plugin, `dev.keyframer.vitals`:
//   plugins { id("dev.keyframer.vitals") version "<version>" }
// For each minified variant it injects a build id the reporter sends as `app.debugId`, and after R8
// runs, turns mapping.txt into the r8 chunks of protocol/vitals.ts and uploads them with the project's
// CI key (KEYFRAMER_VITALS_UPLOAD_KEY). Without a key it uploads nothing.
plugins {
    `java-gradle-plugin`
    id("org.jetbrains.kotlin.jvm")
    id("com.vanniktech.maven.publish")
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)
    }
}

// The Android Gradle plugin the functional test builds an app with (the app's own AGP at run time).
val agp: Configuration by configurations.creating

dependencies {
    // The app's Android Gradle plugin provides these at run time; 8.x's public variant API.
    compileOnly("com.android.tools.build:gradle-api:8.13.2")

    agp("com.android.tools.build:gradle:8.13.2")

    testImplementation(kotlin("test"))
    testImplementation("junit:junit:4.13.2")
    testImplementation(gradleTestKit())
}

gradlePlugin {
    plugins {
        create("vitals") {
            id = "dev.keyframer.vitals"
            implementationClass = "dev.keyframer.vitals.gradle.KeyframerVitalsPlugin"
            displayName = "Keyframer Motion Vitals"
            description = "Build ids and R8 mapping uploads for Motion Vitals (dev.keyframer:vitals)."
        }
    }
}

tasks.named<PluginUnderTestMetadata>("pluginUnderTestMetadata") {
    pluginClasspath.from(agp)
}

// The golden r8 chunks the symbols CLI writes too (inspector/packages/protocol/fixtures/vitals/symbols).
val symbolFixtures = rootProject.layout.projectDirectory.dir("../protocol/fixtures/vitals/symbols")

tasks.test {
    useJUnit()
    systemProperty("keyframer.vitals.symbols", symbolFixtures.asFile.absolutePath)
    // The functional test builds a small app with the Android SDK (skipped without one); -PfunctionalTests=false skips it.
    systemProperty("keyframer.vitals.functional", providers.gradleProperty("functionalTests").getOrElse("true"))
    testLogging {
        events("passed", "failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
