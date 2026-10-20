package dev.keyframer.example

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.keyframer.inspector.Keyframer
import dev.keyframer.inspector.KeyframerConfig

/**
 * The scenarios an agent or ci runs. Each one leaves the app on the main screen, as it found it: one
 * that opens a screen finishes it when done, and one that needs a screen opens it first. Otherwise a
 * run of checks stacks screens whose loops keep running covered.
 */
class ExampleApp : Application() {
    private val main = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        Keyframer.start(
            this,
            KeyframerConfig(host = BuildConfig.KEYFRAMER_HOST.ifEmpty { null }, port = BuildConfig.KEYFRAMER_PORT),
        )
        // What an agent runs to reproduce a drag: the same touches a finger makes, through the window.
        Keyframer.registerScenario("drag card") { done ->
            show(MainActivity::class.java, done) { main -> main.dragCard(done) }
        }
        Keyframer.registerScenario("open detail") { done ->
            // Done once the sheet is up and the screen closed again.
            show(DetailActivity::class.java, done) { detail -> closeAfter(detail, 900, done) }
        }
        Keyframer.registerScenario("open compose") { done ->
            show(ComposeActivity::class.java, done) { compose -> closeAfter(compose, 900, done) }
        }
        // Expands the Compose card on a fresh Compose screen: a spring, a tween and a transition at once.
        Keyframer.registerScenario("toggle compose card") { done ->
            show(ComposeActivity::class.java, done) { compose ->
                // A frame for the new screen's composition before its card is tapped.
                main.postDelayed({
                    val toggle = ComposeActivity.toggle ?: return@postDelayed done(IllegalStateException("The Compose screen has no card."))
                    toggle()
                    closeAfter(compose, 1200, done)
                }, 300)
            }
        }
    }

    /**
     * `cls` on top, then `then`: the main screen is brought back (the activities above it finish), any
     * other screen is opened. Fails when it does not show up within two seconds.
     */
    private fun <T : Activity> show(cls: Class<T>, done: (Throwable?) -> Unit, then: (T) -> Unit) {
        val from = Keyframer.topActivity
        if (from == null) {
            done(IllegalStateException("No activity on screen."))
            return
        }
        if (cls.isInstance(from)) {
            @Suppress("UNCHECKED_CAST")
            then(from as T)
            return
        }
        from.startActivity(Intent(from, cls).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        val until = SystemClock.uptimeMillis() + 2000
        main.post(object : Runnable {
            override fun run() {
                val top = Keyframer.topActivity
                @Suppress("UNCHECKED_CAST")
                when {
                    cls.isInstance(top) -> main.postDelayed({ then(top as T) }, 300)
                    SystemClock.uptimeMillis() > until -> done(IllegalStateException("${cls.simpleName} did not open."))
                    else -> main.postDelayed(this, 50)
                }
            }
        })
    }

    /** Finishes the screen a scenario opened, `ms` after its entrance, and is done once it closed. */
    private fun closeAfter(activity: Activity, ms: Long, done: (Throwable?) -> Unit) {
        main.postDelayed({
            activity.finish()
            main.postDelayed({ done(null) }, 400)
        }, ms)
    }
}
