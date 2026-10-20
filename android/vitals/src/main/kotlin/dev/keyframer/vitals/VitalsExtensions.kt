package dev.keyframer.vitals

import dev.keyframer.vitals.internal.Recorder
import dev.keyframer.vitals.internal.Redact
import dev.keyframer.vitals.internal.StackSites

/**
 * Marks what Keyframer's own add-on modules (dev.keyframer:vitals-compose) use to report animations.
 * Not part of the API apps call: it changes with the SDK.
 */
@RequiresOptIn(
    level = RequiresOptIn.Level.ERROR,
    message = "For Keyframer's own modules (vitals-compose). Apps use KeyframerVitals and kfTrack.",
)
@Retention(AnnotationRetention.BINARY)
@Target(AnnotationTarget.CLASS, AnnotationTarget.FUNCTION, AnnotationTarget.PROPERTY)
annotation class VitalsExtensionApi

/** A tracked call site, found once (from the stack of the call that made it). */
@VitalsExtensionApi
class VitalsSite internal constructor(internal val info: dev.keyframer.vitals.internal.SiteInfo)

/** One run of a tracked animation, from start to end. */
@VitalsExtensionApi
class VitalsRun internal constructor(internal val run: Recorder.Run)

/** How add-on modules report animations the SDK cannot see on its own. Main thread. */
@VitalsExtensionApi
object VitalsExtensions {
    /** start was called and the current session measures: worth finding sites and reporting runs. */
    val measuring: Boolean get() = KeyframerVitals.reporterOrNull()?.measuring == true

    /** start was called (sites are worth finding even before the session measures). */
    val started: Boolean get() = KeyframerVitals.reporterOrNull() != null

    /** The site of a call: `name` when given, else the first app frame of `stack`. */
    fun site(stack: Array<StackTraceElement>, name: String?, fn: String, prop: String? = null): VitalsSite? =
        StackSites.site(stack, name?.let { Redact.maskText(it) }, fn, prop, KeyframerVitals.keepClassNames)?.let { VitalsSite(it) }

    /** A run started; `durationMs` its estimated length, null when it runs until stopped. */
    fun start(site: VitalsSite, durationMs: Double?): VitalsRun? =
        KeyframerVitals.reporterOrNull()?.animationStart(site.info, durationMs)?.let { VitalsRun(it) }

    fun end(run: VitalsRun?) {
        if (run != null) KeyframerVitals.reporterOrNull()?.animationEnd(run.run)
    }

    /** The UI framework reports name ("Compose" once a Compose helper runs). */
    fun setFramework(name: String) {
        KeyframerVitals.reporterOrNull()?.framework = name
    }
}
