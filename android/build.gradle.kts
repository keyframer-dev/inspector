plugins {
    id("com.android.application") version "8.13.2" apply false
    id("com.android.library") version "8.13.2" apply false
    id("org.jetbrains.kotlin.android") version "2.2.10" apply false
    id("org.jetbrains.kotlin.jvm") version "2.2.10" apply false
    // keyframer-inspector-compose and the example's Compose screen: the Compose compiler ships with
    // Kotlin, so its version is Kotlin's.
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10" apply false
    // Maven Central (dev.keyframer): `./gradlew publishToMavenCentral`. The coordinates and POM are in
    // gradle.properties; credentials and the signing key come from the environment (ORG_GRADLE_PROJECT_*).
    id("com.vanniktech.maven.publish") version "0.37.0" apply false
}
