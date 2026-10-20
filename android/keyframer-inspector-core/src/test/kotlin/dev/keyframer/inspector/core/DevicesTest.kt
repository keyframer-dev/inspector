package dev.keyframer.inspector.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DevicesTest {
    // What getprop prints, trimmed to the lines that matter (and one that does not).
    private val emulatorProps = Devices.parseGetprop(
        """
        [dalvik.vm.heapsize]: [512m]
        [ro.boot.qemu]: [1]
        [ro.boot.qemu.avd_name]: [Pixel_4_API_35]
        [ro.kernel.qemu.gles]: [1]
        """.trimIndent(),
    )

    @Test
    fun `getprop output is read line by line`() {
        assertEquals("Pixel_4_API_35", emulatorProps["ro.boot.qemu.avd_name"])
        assertEquals("512m", emulatorProps["dalvik.vm.heapsize"])
        assertEquals(mapOf("a.b" to ""), Devices.parseGetprop("[a.b]: []\nnot a property"))
    }

    @Test
    fun `an emulator says its AVD, readable, and its model`() {
        val d = Devices.describe(emulatorProps, "sdk_gphone64_arm64", "Google", "google/sdk_gphone64_arm64/emu64a:15/x", "ranchu", "sdk_gphone64_arm64") { "never asked" }
        assertEquals(DeviceInfo(name = "Pixel 4 API 35", model = "sdk_gphone64_arm64", id = "Pixel_4_API_35", simulator = true), d)
        // Older images name the AVD under ro.kernel.
        val old = Devices.describe(mapOf("ro.kernel.qemu" to "1", "ro.kernel.qemu.avd_name" to "Nexus_5"), "Android SDK built for x86", "unknown", "generic/sdk/x", "goldfish", "sdk") { null }
        assertEquals("Nexus_5", old.id)
        assertEquals("Nexus 5", old.name)
    }

    @Test
    fun `an emulator without its AVD name falls back to its device name setting`() {
        val d = Devices.describe(emptyMap(), "sdk_gphone64_arm64", "Google", "google/sdk_gphone64_arm64/x", "ranchu", "sdk_gphone64_arm64") { "sdk_gphone64_arm64" }
        assertEquals(DeviceInfo(name = "sdk_gphone64_arm64", model = "sdk_gphone64_arm64", id = null, simulator = true), d)
    }

    @Test
    fun `a phone sends its model only, and its owner-given name is never asked for`() {
        var asked = false
        val d = Devices.describe(emptyMap(), "Pixel 8", "Google", "google/shiba/shiba:15/AP4A/x:user/release-keys", "shiba", "shiba") { asked = true; "Catalin's Pixel" }
        assertEquals(DeviceInfo(model = "Google Pixel 8", simulator = false), d)
        assertFalse(asked)
        assertNull(d.name)
        assertNull(d.id)
        assertEquals("""{"model":"Google Pixel 8","simulator":false}""", Json.encode(d))
    }

    @Test
    fun `emulators are told apart by their properties or their build`() {
        val phone = listOf("google/shiba/shiba:15/x", "Pixel 8", "shiba", "shiba")
        assertFalse(Devices.isEmulator(emptyMap(), phone[0], phone[1], phone[2], phone[3]))
        assertTrue(Devices.isEmulator(mapOf("ro.kernel.qemu" to "1"), phone[0], phone[1], phone[2], phone[3]))
        assertTrue(Devices.isEmulator(emptyMap(), "x", "x", "ranchu", "x"))
        assertTrue(Devices.isEmulator(emptyMap(), "x", "x", "goldfish_arm64", "x"))
        assertTrue(Devices.isEmulator(emptyMap(), "generic/sdk_phone_x86/x", "x", "x", "x"))
        assertTrue(Devices.isEmulator(emptyMap(), "x", "sdk_gphone64_arm64", "x", "x"))
    }

    @Test
    fun `the manufacturer goes in front when the model leaves it out`() {
        assertEquals("Samsung SM-S918B", Devices.physicalModel("SM-S918B", "samsung"))
        assertEquals("Pixel 8", Devices.physicalModel("Pixel 8", ""))
        assertEquals("OnePlus CPH2449", Devices.physicalModel("CPH2449", "OnePlus"))
        // A model that does not start with its maker gets the maker in front, even when it names a brand.
        assertEquals("HMD Global Nokia G21", Devices.physicalModel("Nokia G21", "HMD Global"))
        assertEquals("Samsung", Devices.physicalModel("", "samsung"))
    }
}
