package dev.keyframer.vitals.internal

import android.animation.ValueAnimator
import android.app.ActivityManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.net.ConnectivityManager
import android.os.Build
import android.os.PowerManager
import android.view.Display
import kotlin.math.ceil
import kotlin.math.roundToInt

/** Device class from what the platform says (production.md 2.5). Pure, so it is tested off device. */
internal object Tiers {
    /**
     * low: a low-RAM device, 3 GB or less, or fewer than 4 cores. high: Android's media performance
     * class 12 or newer (Build.VERSION.MEDIA_PERFORMANCE_CLASS >= 31), or 8 GB and 8 cores. mid otherwise.
     */
    fun tier(memoryGb: Int, cores: Int, mediaPerformanceClass: Int, lowRam: Boolean): String = when {
        lowRam || memoryGb in 1..3 || cores in 1..3 -> "low"
        mediaPerformanceClass >= 31 || memoryGb >= 8 && cores >= 8 -> "high"
        else -> "mid"
    }

    /** Total memory as the size on the box: 3.6 GiB reported is a 4 GB phone. */
    fun memoryGb(totalBytes: Long): Int = if (totalBytes <= 0) 0 else ceil(totalBytes / (1024.0 * 1024 * 1024)).toInt()

    /** Android's major version from `Build.VERSION.RELEASE` ("14", "8.1.0"), else from the API level. */
    fun osMajor(release: String?, sdkInt: Int): Int =
        release?.takeWhile { it.isDigit() }?.toIntOrNull()?.takeIf { it > 0 } ?: when {
            sdkInt >= 33 -> sdkInt - 20
            sdkInt >= 31 -> 12
            sdkInt >= 30 -> 11
            sdkInt >= 29 -> 10
            sdkInt >= 28 -> 9
            sdkInt >= 26 -> 8
            sdkInt >= 24 -> 7
            else -> 6
        }

    /** PowerManager's thermal status (API 29) as the report's level: 0 nominal … 3 critical. */
    fun thermalLevel(status: Int): Int = when {
        status <= 0 -> 0
        status <= 2 -> 1
        status == 3 -> 2
        else -> 3
    }
}

/** What the reporter reads from the device. Every call is guarded: a probe never breaks the app. */
internal class AndroidDevice(private val context: Context) {
    val packageName: String = context.packageName

    val debuggable: Boolean get() = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    fun versionName(): String? = runCatching {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(packageName, 0).versionName
    }.getOrNull()

    fun versionCode(): String? = runCatching {
        val info = context.packageManager.getPackageInfo(packageName, 0)
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toString() else @Suppress("DEPRECATION") info.versionCode.toString()
    }.getOrNull()

    /**
     * The build id the dev.keyframer.vitals Gradle plugin injects (a string resource, or manifest
     * meta-data for apps that set it themselves): matches the R8 mapping uploaded for this build.
     */
    fun debugId(): String? {
        runCatching {
            @Suppress("DEPRECATION")
            val ai = context.packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            ai.metaData?.getString(META_BUILD_ID)?.takeIf { it.isNotBlank() }?.let { return normalizeId(it) }
        }
        return runCatching {
            val id = context.resources.getIdentifier(RES_BUILD_ID, "string", packageName)
            if (id != 0) context.getString(id).takeIf { it.isNotBlank() }?.let { normalizeId(it) } else null
        }.getOrNull()
    }

    fun device(collectModel: Boolean): DeviceInfo {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val mem = runCatching { ActivityManager.MemoryInfo().also { am?.getMemoryInfo(it) }.totalMem }.getOrDefault(0L)
        val gb = Tiers.memoryGb(mem)
        val cores = Runtime.getRuntime().availableProcessors()
        val mpc = if (Build.VERSION.SDK_INT >= 31) Build.VERSION.MEDIA_PERFORMANCE_CLASS else 0
        val lowRam = runCatching { am?.isLowRamDevice == true }.getOrDefault(false)
        val model = if (collectModel) listOfNotNull(Build.MANUFACTURER, Build.MODEL).joinToString(" ").trim().take(64).ifEmpty { null } else null
        return DeviceInfo(
            osMajor = Tiers.osMajor(Build.VERSION.RELEASE, Build.VERSION.SDK_INT),
            model = model,
            tier = Tiers.tier(gb, cores, mpc, lowRam),
            memoryGb = gb.takeIf { it > 0 },
        )
    }

    /** The default display's refresh rate, and whether it can change it (several rates in its modes). */
    fun display(): Pair<Int, Boolean?> = runCatching {
        val dm = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val d = dm.getDisplay(Display.DEFAULT_DISPLAY)
        val hz = d.refreshRate.roundToInt().takeIf { it in 20..500 } ?: 60
        val adaptive = d.supportedModes.map { it.refreshRate.roundToInt() }.toSet().size > 1
        hz to adaptive
    }.getOrDefault(60 to null)

    fun powerSave(): Boolean = runCatching {
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isPowerSaveMode
    }.getOrDefault(false)

    /** Thermal level 0..3, or -1 before Android 10. */
    fun thermal(): Int = if (Build.VERSION.SDK_INT >= 29) runCatching {
        Tiers.thermalLevel((context.getSystemService(Context.POWER_SERVICE) as PowerManager).currentThermalStatus)
    }.getOrDefault(-1) else -1

    /** "Remove animations" (animator duration scale 0): Android's Reduce Motion. */
    fun animationsOff(): Boolean = if (Build.VERSION.SDK_INT >= 26) !ValueAnimator.areAnimatorsEnabled() else false

    /**
     * Data Saver is on for this app on a metered network: uploads wait for the next unconstrained
     * launch. Without the network-state permission the network is assumed metered.
     */
    fun dataSaver(): Boolean = runCatching {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        if (cm.restrictBackgroundStatus != ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED) return@runCatching false
        val canRead = context.checkCallingOrSelfPermission(android.Manifest.permission.ACCESS_NETWORK_STATE) == PackageManager.PERMISSION_GRANTED
        !canRead || cm.isActiveNetworkMetered
    }.getOrDefault(false)

    companion object {
        const val META_BUILD_ID = "dev.keyframer.vitals.BUILD_ID"
        const val RES_BUILD_ID = "keyframer_vitals_build_id"

        /** Lowercase hex without dashes, as the symbol manifest's debugId. */
        fun normalizeId(id: String): String = id.trim().lowercase().replace("-", "")
    }
}
