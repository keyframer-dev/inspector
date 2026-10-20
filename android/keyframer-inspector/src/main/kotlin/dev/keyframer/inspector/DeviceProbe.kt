package dev.keyframer.inspector

import android.app.Application
import android.os.Build
import android.provider.Settings
import dev.keyframer.inspector.core.DeviceInfo
import dev.keyframer.inspector.core.Devices
import java.util.concurrent.TimeUnit

/**
 * The device for the hello (see Devices for the rules). System properties come from the `getprop`
 * command, which apps may run, rather than the hidden SystemProperties class; it is run once, off the
 * main thread. Only the qemu properties are used from its output.
 */
internal object DeviceProbe {
    fun read(app: Application): DeviceInfo = Devices.describe(
        props = getprop(),
        model = Build.MODEL.orEmpty(),
        manufacturer = Build.MANUFACTURER.orEmpty(),
        fingerprint = Build.FINGERPRINT.orEmpty(),
        hardware = Build.HARDWARE.orEmpty(),
        product = Build.PRODUCT.orEmpty(),
    ) {
        // Asked only on an emulator: on a phone this is the name its owner gave it.
        if (Build.VERSION.SDK_INT >= 25) Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) else null
    }

    /** Whether the build looks like an emulator's, without running anything (for the default relay host). */
    fun buildLooksLikeEmulator(): Boolean =
        Devices.isEmulator(emptyMap(), Build.FINGERPRINT.orEmpty(), Build.MODEL.orEmpty(), Build.HARDWARE.orEmpty(), Build.PRODUCT.orEmpty())

    private fun getprop(): Map<String, String> = runCatching {
        val p = ProcessBuilder("getprop").redirectErrorStream(true).start()
        try {
            val text = p.inputStream.bufferedReader().use { it.readText() }
            p.waitFor(2, TimeUnit.SECONDS)
            Devices.parseGetprop(text).filterKeys { it.startsWith("ro.kernel.qemu") || it.startsWith("ro.boot.qemu") }
        } finally {
            p.destroy()
        }
    }.getOrDefault(emptyMap())
}
