package dev.keyframer.vitals.gradle

import com.sun.net.httpserver.HttpServer
import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.net.InetSocketAddress
import java.nio.file.Files
import java.util.Collections
import java.util.zip.GZIPInputStream

/**
 * A minified app built with the plugin (Gradle TestKit, the Android Gradle plugin 8.13): the build id
 * goes into the app's resources, R8's mapping becomes chunks keyed by that id, and they are uploaded
 * (chunks, then the manifest) with the CI key; without a key nothing is sent. Needs the Android SDK
 * (ANDROID_HOME); skipped without one, or with -PfunctionalTests=false.
 */
class PluginFunctionalTest {
    private val sdk: File? = listOfNotNull(System.getenv("ANDROID_HOME"), System.getenv("ANDROID_SDK_ROOT"), System.getProperty("user.home") + "/Library/Android/sdk")
        .map { File(it) }.firstOrNull { it.resolve("platforms").isDirectory }

    private fun project(port: Int): File {
        val dir = Files.createTempDirectory("vitals-plugin").toFile()
        dir.resolve("local.properties").writeText("sdk.dir=${sdk!!.absolutePath}\n")
        dir.resolve("gradle.properties").writeText("android.useAndroidX=true\norg.gradle.jvmargs=-Xmx1536m\n")
        dir.resolve("settings.gradle.kts").writeText(
            """
            pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }
            dependencyResolutionManagement { repositories { google(); mavenCentral() } }
            rootProject.name = "fixture"
            """.trimIndent(),
        )
        dir.resolve("build.gradle.kts").writeText(
            """
            plugins {
                id("com.android.application")
                id("dev.keyframer.vitals")
            }
            android {
                namespace = "com.acme.fixture"
                compileSdk = 35
                defaultConfig {
                    applicationId = "com.acme.fixture"
                    minSdk = 24
                    targetSdk = 35
                    versionCode = 7
                    versionName = "2.1.0"
                }
                buildTypes {
                    release {
                        isMinifyEnabled = true
                        proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
                    }
                }
            }
            keyframerVitals {
                endpoint.set("http://127.0.0.1:$port")
            }
            """.trimIndent(),
        )
        val src = dir.resolve("src/main/java/com/acme/fixture").apply { mkdirs() }
        src.resolve("MainActivity.java").writeText(
            """
            package com.acme.fixture;
            public class MainActivity extends android.app.Activity {
                @Override protected void onCreate(android.os.Bundle b) { super.onCreate(b); helper(b); }
                private void helper(android.os.Bundle b) { if (b != null) android.util.Log.i("fixture", "again"); }
            }
            """.trimIndent(),
        )
        dir.resolve("src/main/AndroidManifest.xml").writeText(
            """
            <manifest xmlns:android="http://schemas.android.com/apk/res/android">
                <application android:label="fixture">
                    <activity android:name=".MainActivity" android:exported="true">
                        <intent-filter>
                            <action android:name="android.intent.action.MAIN" />
                            <category android:name="android.intent.category.LAUNCHER" />
                        </intent-filter>
                    </activity>
                </application>
            </manifest>
            """.trimIndent(),
        )
        return dir
    }

    private class Seen(val method: String, val path: String, val auth: String?, val body: String)

    @Test
    fun buildIdAndMappingUpload() {
        assumeTrue("no Android SDK", sdk != null)
        assumeTrue("functional tests turned off", System.getProperty("keyframer.vitals.functional") != "false")
        val seen = Collections.synchronizedList(ArrayList<Seen>())
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val raw = ex.requestBody.readBytes()
            val body = if (ex.requestHeaders.getFirst("Content-Encoding") == "gzip") GZIPInputStream(raw.inputStream()).readBytes() else raw
            seen.add(Seen(ex.requestMethod, ex.requestURI.rawPath, ex.requestHeaders.getFirst("Authorization"), body.toString(Charsets.UTF_8)))
            ex.sendResponseHeaders(200, -1)
            ex.close()
        }
        server.start()
        val dir = project(server.address.port)
        try {
            // Gradle's own user home, so the Android Gradle plugin's downloads are shared with this build.
            fun runner(vararg args: String) = GradleRunner.create()
                .withProjectDir(dir)
                .withTestKitDir(File(System.getProperty("user.home"), ".gradle"))
                .withPluginClasspath()
                .withArguments(*args, "--stacktrace")
                .forwardOutput()

            val result = runner("assembleRelease", "-PkeyframerVitalsUploadKey=kft_test0123456789").build()
            assertTrue(result.output.contains("Motion Vitals: uploaded the R8 mapping"))

            val id = dir.resolve("build/intermediates/keyframer-vitals/release/build-id.txt").readText().trim()
            assertTrue(Regex("^[0-9a-f]{32}$").matches(id))
            // In the app's resources, where dev.keyframer:vitals reads it.
            val resValues = dir.resolve("build/generated").walkTopDown().filter { it.isFile && it.name.endsWith(".xml") }.map { it.readText() }
                .firstOrNull { it.contains("keyframer_vitals_build_id") }
            assertTrue("the build id resource", resValues?.contains(">$id<") == true)

            assertEquals(listOf("PUT", "POST"), seen.map { it.method })
            assertEquals(listOf("/v1/symbols/r8/$id/0000.json", "/v1/symbols/r8/$id/manifest"), seen.map { it.path })
            assertTrue(seen.all { it.auth == "Bearer kft_test0123456789" })
            assertTrue(seen[0].body.contains("\"name\":\"com.acme.fixture.MainActivity\""))
            assertTrue(seen[1].body.contains("\"debugId\":\"$id\""))
            assertTrue(seen[1].body.contains("\"app\":{\"id\":\"com.acme.fixture\",\"version\":\"2.1.0\",\"build\":\"7\"}"))
            val written = dir.resolve("build/outputs/keyframer-vitals/release/r8/$id/manifest.json").readText()
            assertEquals(seen[1].body, written)

            // No key: chunks are written, nothing is sent; and each build has its own id.
            seen.clear()
            val quiet = runner("assembleRelease").build()
            assertTrue(quiet.output.contains("no upload key"))
            assertTrue(seen.isEmpty())
            val next = dir.resolve("build/intermediates/keyframer-vitals/release/build-id.txt").readText().trim()
            assertTrue(next != id)
            // Debug builds are not minified: no build id task at all.
            assertTrue(runner("tasks", "--all").build().output.let { !it.contains("generateKeyframerVitalsBuildIdDebug") && it.contains("generateKeyframerVitalsBuildIdRelease") })
        } finally {
            server.stop(0)
            dir.deleteRecursively()
        }
    }
}
