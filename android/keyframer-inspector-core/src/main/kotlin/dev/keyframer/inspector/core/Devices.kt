package dev.keyframer.inspector.core

/**
 * What the hello says about the device, from what the platform can read: Build fields and system
 * properties (`getprop` output on Android). Pure, so the rules are tested on the JVM:
 *
 *   - an emulator is one whose qemu properties say so (`ro.kernel.qemu`, `ro.boot.qemu`), or whose
 *     build looks like the SDK's images (goldfish or ranchu hardware, generic or sdk_gphone builds);
 *   - an emulator sends its AVD name as `id` (`ro.boot.qemu.avd_name`, `ro.kernel.qemu.avd_name` on
 *     older images) and as `name` with spaces, else the emulator's own device name setting;
 *   - a physical device sends its model (with the manufacturer in front when the model leaves it out)
 *     and `simulator: false`, never a name: the one it has is the one its owner gave it.
 */
object Devices {
    /** `[key]: [value]` lines, as `getprop` prints them. */
    fun parseGetprop(text: String): Map<String, String> {
        val out = LinkedHashMap<String, String>()
        for (line in text.lineSequence()) {
            val m = PROP.matchEntire(line.trim()) ?: continue
            out[m.groupValues[1]] = m.groupValues[2]
        }
        return out
    }

    private val PROP = Regex("""\[([^\]]+)\]:\s*\[(.*)\]""")

    fun isEmulator(props: Map<String, String>, fingerprint: String, model: String, hardware: String, product: String): Boolean =
        props["ro.kernel.qemu"] == "1" || props["ro.boot.qemu"] == "1" ||
            hardware.contains("goldfish") || hardware.contains("ranchu") ||
            fingerprint.startsWith("generic") || fingerprint.contains("emulator") || fingerprint.contains("sdk_gphone") ||
            model.contains("Emulator") || model.contains("Android SDK built for") || model.startsWith("sdk_gphone") ||
            product.startsWith("sdk") || product.contains("emulator") || product.contains("simulator")

    /**
     * `emulatorName` is read only for an emulator (Settings.Global.DEVICE_NAME on Android), so a phone's
     * owner-given name is never even asked for.
     */
    fun describe(
        props: Map<String, String>,
        model: String,
        manufacturer: String,
        fingerprint: String,
        hardware: String,
        product: String,
        emulatorName: () -> String?,
    ): DeviceInfo {
        if (!isEmulator(props, fingerprint, model, hardware, product)) {
            return DeviceInfo(model = physicalModel(model, manufacturer), simulator = false)
        }
        val avd = (props["ro.boot.qemu.avd_name"] ?: props["ro.kernel.qemu.avd_name"])?.trim()?.ifEmpty { null }
        val name = avd?.replace('_', ' ') ?: runCatching(emulatorName).getOrNull()?.trim()?.ifEmpty { null }
        return DeviceInfo(name = name, model = model.ifEmpty { null }, id = avd, simulator = true)
    }

    /** "Pixel 8" from Google reads "Google Pixel 8"; "SM-S918B" from samsung, "Samsung SM-S918B". */
    fun physicalModel(model: String, manufacturer: String): String? {
        val m = model.trim()
        val maker = manufacturer.trim().replaceFirstChar { it.uppercaseChar() }
        if (m.isEmpty()) return maker.ifEmpty { null }
        if (maker.isEmpty() || m.startsWith(maker, ignoreCase = true)) return m
        return "$maker $m"
    }
}
