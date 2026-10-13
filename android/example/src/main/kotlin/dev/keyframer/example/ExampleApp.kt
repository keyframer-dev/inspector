package dev.keyframer.example

import android.app.Application
import dev.keyframer.inspector.Keyframer
import dev.keyframer.inspector.KeyframerConfig

class ExampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Keyframer.start(
            this,
            KeyframerConfig(host = BuildConfig.KEYFRAMER_HOST.ifEmpty { null }, port = BuildConfig.KEYFRAMER_PORT),
        )
        // What an agent runs to reproduce a drag: the same touches a finger makes, through the window.
        Keyframer.registerScenario("drag card") { done ->
            val main = Keyframer.topActivity as? MainActivity
            if (main == null) done(IllegalStateException("Open the main screen first.")) else main.dragCard(done)
        }
        Keyframer.registerScenario("open detail") { done ->
            val from = Keyframer.topActivity ?: return@registerScenario done(IllegalStateException("No activity on screen."))
            from.startActivity(android.content.Intent(from, DetailActivity::class.java))
            // Done once the sheet is up.
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ done(null) }, 900)
        }
    }
}
