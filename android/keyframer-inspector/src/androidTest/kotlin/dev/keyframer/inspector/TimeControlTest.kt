package dev.keyframer.inspector

import android.animation.Animator
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.os.Build
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The editor's `time` on real animators: slow motion through the duration scale, pause and step by
 * holding the tracked ones, for a ValueAnimator, an ObjectAnimator, an AnimatorSet and a
 * ViewPropertyAnimator (untracked: it slows with everything else, and is not held).
 */
@RunWith(AndroidJUnit4::class)
class TimeControlTest {
    private val tracked = ArrayList<Animator>()
    private val time = TimeControl({ tracked.filter { it.isRunning } }, { 60f }, { 1f })
    private val started = ArrayList<Animator>()

    private fun <T> main(block: () -> T): T {
        var out: T? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { out = block() }
        @Suppress("UNCHECKED_CAST")
        return out as T
    }

    @After
    fun tearDown() {
        main {
            time.set(1.0, null)
            started.forEach { it.cancel() }
        }
    }

    private fun linear(ms: Long = 10_000): ValueAnimator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = ms
        interpolator = LinearInterpolator()
    }

    private fun start(a: Animator, track: Boolean = true) = main {
        if (track) tracked.add(a)
        started.add(a)
        a.start()
    }

    /** Play time moved over `ms` of real time. */
    private fun advance(a: () -> Long, ms: Long): Long {
        val before = main(a)
        Thread.sleep(ms)
        return main(a) - before
    }

    @Test
    fun valueAnimatorSlowsPausesStepsAndResumes() {
        val a = linear()
        start(a)
        Thread.sleep(200)
        // Its value, linear over 10 s: read between frames, currentPlayTime moves with the wall clock.
        val play = { ((a.animatedValue as Float) * 10_000).toLong() }
        main { time.set(0.25, null) }
        val slow = advance(play, 400)
        assertTrue("a quarter of 400 ms, got $slow", slow in 60..160)
        main { time.set(0.0, null) }
        Thread.sleep(50)
        val held = advance(play, 300)
        assertTrue("held, got $held", held in -2..2)
        main { time.set(0.0, 6) }
        val stepped = advance(play, 400)
        // Six frames at 60 Hz.
        assertTrue("six frames, got $stepped", stepped in 90..110)
        val after = advance(play, 200)
        assertTrue("held again, got $after", after in -2..2)
        val p = main(play)
        main { time.set(1.0, null) }
        Thread.sleep(16)
        val back = main(play)
        assertTrue("no jump when letting go: $p then $back", back - p in -5..60)
        val normal = advance(play, 300)
        assertTrue("normal speed, got $normal", normal in 240..360)
    }

    @Test
    fun objectAnimatorHoldsItsView() {
        val view = main { View(InstrumentationRegistry.getInstrumentation().targetContext) }
        val a = ObjectAnimator.ofFloat(view, View.TRANSLATION_X, 0f, 1000f).apply {
            duration = 2000
            interpolator = LinearInterpolator()
        }
        start(a)
        Thread.sleep(200)
        main { time.set(0.0, null) }
        Thread.sleep(50)
        val x = main { view.translationX }
        Thread.sleep(300)
        assertEquals(x, main { view.translationX }, 1f)
        main { time.set(1.0, null) }
        Thread.sleep(300)
        assertTrue(main { view.translationX } > x + 100)
    }

    @Test
    fun animatorSetIsHeldAsAWhole() {
        assumeTrue("an AnimatorSet drives its children from API 26", Build.VERSION.SDK_INT >= 26)
        val first = linear(1000)
        val second = linear(1000)
        val set = AnimatorSet().apply { playSequentially(first, second) }
        start(set)
        Thread.sleep(300)
        main { time.set(0.0, null) }
        Thread.sleep(50)
        val held = advance({ set.currentPlayTime }, 300)
        assertTrue("held, got $held", held in -2..2)
        val v = main { first.animatedValue as Float }
        Thread.sleep(200)
        assertEquals(v, main { first.animatedValue as Float }, 0.002f)
        main { time.set(0.0, 3) }
        val stepped = advance({ set.currentPlayTime }, 300)
        assertTrue("three frames, got $stepped", stepped in 40..60)
        main { time.set(1.0, null) }
        val normal = advance({ set.currentPlayTime }, 300)
        assertTrue("normal speed, got $normal", normal in 240..360)
    }

    @Test
    fun viewPropertyAnimatorSlowsWithTheDurationScale() {
        assumeTrue("needs the duration scale", DurationScale.canSet)
        ActivityScenario.launch(TestActivity::class.java).use { scenario ->
            lateinit var view: View
            scenario.onActivity { activity ->
                view = View(activity)
                activity.root.addView(view, 100, 100)
                time.set(0.25, null)
                view.animate().translationX(1000f).setDuration(1000).setInterpolator(LinearInterpolator()).start()
            }
            Thread.sleep(400)
            var x = 0f
            scenario.onActivity { x = view.translationX }
            // 400 ms at a quarter speed: a tenth of the way, not four tenths.
            assertTrue("got $x", x in 40f..180f)
        }
    }
}
