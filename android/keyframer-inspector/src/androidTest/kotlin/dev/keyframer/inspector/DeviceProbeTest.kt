package dev.keyframer.inspector

import android.app.Application
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DeviceProbeTest {
    @Test
    fun anEmulatorNamesItsAvdAndAPhoneOnlyItsModel() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
        val d = DeviceProbe.read(app)
        android.util.Log.i("DeviceProbeTest", d.toString())
        if (d.simulator == true) {
            // getprop worked without hidden API: the AVD name is the id, readable as the name.
            val id = d.id
            assertNotNull(id)
            assertEquals(id!!.replace('_', ' '), d.name)
            assertEquals(Build.MODEL, d.model)
        } else {
            assertEquals(false, d.simulator)
            assertNull(d.name)
            assertNull(d.id)
            assertNotNull(d.model)
        }
    }
}
