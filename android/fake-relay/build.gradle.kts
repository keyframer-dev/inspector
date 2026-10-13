plugins {
    id("org.jetbrains.kotlin.jvm")
    application
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

dependencies {
    // The relay forwards strings as they are; the scripted editor reads them with the core's JSON.
    implementation(project(":keyframer-inspector-core"))
    implementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

application {
    mainClass.set("dev.keyframer.relay.MainKt")
}

tasks.named<JavaExec>("run") {
    standardInput = System.`in`
}
