package dev.keyframer.vitals.gradle

import com.android.build.api.artifact.SingleArtifact
import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import com.android.build.api.variant.ApplicationVariant
import com.android.build.api.variant.ResValue
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.Optional
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.OutputFile
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Settings, all optional:
 * ```kotlin
 * keyframerVitals {
 *     uploadKey.set(providers.environmentVariable("KEYFRAMER_VITALS_UPLOAD_KEY")) // the default
 *     uploadMapping.set(false) // inject build ids, upload nothing (the CLI can upload later)
 * }
 * ```
 */
abstract class KeyframerVitalsExtension {
    /** The project's CI upload key, `kft_…`. Default: KEYFRAMER_VITALS_UPLOAD_KEY, or the keyframerVitalsUploadKey Gradle property. */
    abstract val uploadKey: Property<String>

    /** The ingest server. Default https://vitals.keyframer.dev. */
    abstract val endpoint: Property<String>

    /** Upload R8 mappings after R8 runs (default true; nothing is uploaded without a key either way). */
    abstract val uploadMapping: Property<Boolean>
}

/**
 * `dev.keyframer.vitals`: for every minified variant of an app, a build id (a random UUID per build)
 * goes into the app as the string resource `keyframer_vitals_build_id`, which `dev.keyframer:vitals`
 * sends as `app.debugId`; after R8, the variant's mapping.txt becomes r8 chunks under
 * build/outputs/keyframer-vitals/<variant>/ and is uploaded with the project's CI key. Without a key it
 * only writes the chunks (`keyframer-vitals symbols upload --mapping … --debug-id …` can send them later).
 */
class KeyframerVitalsPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val ext = project.extensions.create("keyframerVitals", KeyframerVitalsExtension::class.java)
        val providers = project.providers
        ext.uploadKey.convention(
            providers.environmentVariable(KEY_ENV)
                .orElse(providers.gradleProperty("keyframerVitalsUploadKey"))
                .orElse(providers.gradleProperty(KEY_ENV)),
        )
        ext.endpoint.convention(providers.gradleProperty("keyframerVitalsEndpoint").orElse(DEFAULT_ENDPOINT))
        ext.uploadMapping.convention(true)

        project.plugins.withId("com.android.application") {
            val components = project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java)
            components.onVariants { variant -> configure(project, ext, variant) }
        }
    }

    private fun configure(project: Project, ext: KeyframerVitalsExtension, variant: ApplicationVariant) {
        if (!variant.isMinifyEnabled) return
        val name = variant.name.replaceFirstChar { it.uppercase(Locale.ROOT) }
        val buildId = project.tasks.register("generateKeyframerVitalsBuildId$name", GenerateBuildIdTask::class.java) { t ->
            t.group = GROUP
            t.description = "Makes the Motion Vitals build id of the $name build."
            t.buildIdFile.set(project.layout.buildDirectory.file("intermediates/keyframer-vitals/${variant.name}/build-id.txt"))
        }
        variant.resValues.put(
            variant.makeResValueKey("string", RES_NAME),
            buildId.flatMap { it.buildIdFile }.map { ResValue(it.asFile.readText().trim(), "Motion Vitals build id: matches the R8 mapping uploaded for this build") },
        )

        val output = variant.outputs.firstOrNull()
        val upload = project.tasks.register("uploadKeyframerVitalsMapping$name", UploadMappingTask::class.java) { t ->
            t.group = GROUP
            t.description = "Turns the $name R8 mapping into Motion Vitals symbol chunks and uploads them."
            t.mappingFile.set(variant.artifacts.get(SingleArtifact.OBFUSCATION_MAPPING_FILE))
            t.buildIdFile.set(buildId.flatMap { it.buildIdFile })
            t.applicationId.set(variant.applicationId)
            output?.let { o ->
                t.versionName.set(o.versionName)
                t.versionCode.set(o.versionCode.map { it.toString() })
            }
            t.endpoint.set(ext.endpoint)
            t.uploadKey.set(ext.uploadKey)
            t.upload.set(ext.uploadMapping)
            t.outputDir.set(project.layout.buildDirectory.dir("outputs/keyframer-vitals/${variant.name}"))
        }
        // Right after R8: assemble, bundle and install all run it.
        project.tasks.matching { it.name == "minify${name}WithR8" }.configureEach { it.finalizedBy(upload) }
    }

    companion object {
        const val GROUP = "keyframer vitals"
        const val KEY_ENV = "KEYFRAMER_VITALS_UPLOAD_KEY"
        const val DEFAULT_ENDPOINT = "https://vitals.keyframer.dev"
        const val RES_NAME = "keyframer_vitals_build_id"
        const val CLI_NAME = "dev.keyframer.vitals"
        /** Kept in step with VERSION_NAME (gradle.properties). */
        const val VERSION = "0.1.0"
    }
}

/** A new build id per build: a random UUID, lowercase hex without dashes. */
abstract class GenerateBuildIdTask : DefaultTask() {
    @get:OutputFile
    abstract val buildIdFile: RegularFileProperty

    init {
        // Every build gets its own: its R8 mapping is its own too.
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun generate() {
        buildIdFile.get().asFile.apply {
            parentFile.mkdirs()
            writeText(UUID.randomUUID().toString().replace("-", "").lowercase(Locale.ROOT))
        }
    }
}

abstract class UploadMappingTask : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val mappingFile: RegularFileProperty

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val buildIdFile: RegularFileProperty

    @get:Input
    @get:Optional
    abstract val applicationId: Property<String>

    @get:Input
    @get:Optional
    abstract val versionName: Property<String>

    @get:Input
    @get:Optional
    abstract val versionCode: Property<String>

    @get:Input
    abstract val endpoint: Property<String>

    /** A secret: not a task input (never in build caches or scans). */
    @get:Internal
    abstract val uploadKey: Property<String>

    @get:Input
    abstract val upload: Property<Boolean>

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    init {
        outputs.upToDateWhen { false }
    }

    @TaskAction
    fun run() {
        val id = buildIdFile.get().asFile.readText().trim()
        val mapping = mappingFile.get().asFile
        if (!mapping.exists()) {
            logger.lifecycle("Motion Vitals: no R8 mapping for this build, nothing to upload.")
            return
        }
        val set = R8Symbols.build(
            mapping = mapping.readText(),
            debugId = id,
            appId = applicationId.orNull,
            appVersion = versionName.orNull,
            appBuild = versionCode.orNull,
            createdAt = isoNow(),
            cliName = KeyframerVitalsPlugin.CLI_NAME,
            cliVersion = KeyframerVitalsPlugin.VERSION,
        )
        val dir = outputDir.get().asFile.resolve("r8/${set.debugId}")
        dir.deleteRecursively()
        dir.mkdirs()
        for ((file, json) in set.chunks) dir.resolve(file).writeText(json)
        dir.resolve("manifest.json").writeText(set.manifestJson)

        val key = uploadKey.orNull?.trim().orEmpty()
        when {
            !upload.get() -> logger.lifecycle("Motion Vitals: build id ${set.debugId}; mapping upload is off (keyframerVitals.uploadMapping), chunks in $dir.")
            key.isEmpty() -> logger.lifecycle("Motion Vitals: build id ${set.debugId}; no upload key (${KeyframerVitalsPlugin.KEY_ENV}), so the R8 mapping was not uploaded. Chunks in $dir.")
            !key.startsWith("kft_") -> throw GradleException("Motion Vitals: the upload key must be the project's CI key (kft_…), not a field key or another kind.")
            else -> {
                try {
                    SymbolUpload(endpoint.get(), key, log = { logger.lifecycle(it) }).upload(set)
                } catch (e: SymbolUpload.Failure) {
                    throw GradleException("Motion Vitals: ${e.message}")
                }
                logger.lifecycle("Motion Vitals: uploaded the R8 mapping of build ${set.debugId} (${set.chunks.size} chunk${if (set.chunks.size == 1) "" else "s"}).")
            }
        }
    }

    private fun isoNow(): String {
        val epoch = System.getenv("SOURCE_DATE_EPOCH")?.toLongOrNull()
        val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return f.format(Date(epoch?.let { it * 1000 } ?: System.currentTimeMillis()))
    }
}
