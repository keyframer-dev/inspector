package dev.keyframer.example

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import dev.keyframer.inspector.Keyframer
import dev.keyframer.inspector.kfTrack
import kotlin.math.PI
import kotlin.math.sin

/** An entrance (the title), a loop (the pulse), a drag (the card) and a way to a second screen. */
class MainActivity : Activity() {
    private lateinit var card: View

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#F4F3F8")) }
        setContentView(root)

        val title = label("Keyframer", 34f).apply { id = R.id.title }
        root.addView(title, FrameLayout.LayoutParams(-1, -2, Gravity.TOP).apply { topMargin = dpi(72) })

        val pulse = View(this).apply {
            id = R.id.pulse
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#6750A4"))
            }
        }
        root.addView(pulse, FrameLayout.LayoutParams(dpi(56), dpi(56), Gravity.CENTER_HORIZONTAL or Gravity.TOP).apply { topMargin = dpi(160) })

        card = label("Drag me", 18f, Color.WHITE).apply {
            id = R.id.card
            background = rounded(Color.parseColor("#1D6F5F"), dp(20f))
            elevation = dp(6f)
        }
        root.addView(card, FrameLayout.LayoutParams(dpi(180), dpi(110), Gravity.CENTER))

        root.addView(
            button("Open detail") { startActivity(Intent(this, DetailActivity::class.java)) },
            FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dpi(56) },
        )

        // Entrance: two properties on one animator.
        ObjectAnimator.ofPropertyValuesHolder(
            title,
            PropertyValuesHolder.ofFloat(View.ALPHA, 0f, 1f),
            PropertyValuesHolder.ofFloat(View.TRANSLATION_Y, dp(48f), 0f),
        ).apply {
            duration = 650
            startDelay = 120
            interpolator = DecelerateInterpolator(2f)
        }.kfTrack("title").start()

        // Loop: a plain ValueAnimator driving the view from its update listener.
        ValueAnimator.ofFloat(1f, 1.3f).apply {
            duration = 700
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
            addUpdateListener {
                val s = it.animatedValue as Float
                pulse.scaleX = s
                pulse.scaleY = s
            }
        }.kfTrack("pulse").start()

        // Drag: the offsets are signals, so a recorded drag plays back.
        Keyframer.signal("cardX", read = { card.translationX }, write = { card.translationX = it })
        Keyframer.signal("cardY", read = { card.translationY }, write = { card.translationY = it })
        setUpDrag()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun setUpDrag() {
        var downX = 0f
        var downY = 0f
        var snap: ObjectAnimator? = null
        card.setOnTouchListener { v, ev ->
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    snap?.cancel()
                    downX = ev.rawX - v.translationX
                    downY = ev.rawY - v.translationY
                }
                MotionEvent.ACTION_MOVE -> {
                    v.translationX = ev.rawX - downX
                    v.translationY = ev.rawY - downY
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    snap = ObjectAnimator.ofPropertyValuesHolder(
                        v,
                        PropertyValuesHolder.ofFloat(View.TRANSLATION_X, 0f),
                        PropertyValuesHolder.ofFloat(View.TRANSLATION_Y, 0f),
                    ).apply {
                        duration = 450
                        interpolator = OvershootInterpolator(1.6f)
                    }.kfTrack("snap").also { it.start() }
                }
            }
            true
        }
    }

    /** Drags the card along a curve with real touch events through the window, then lets go. */
    fun dragCard(done: (Throwable?) -> Unit) {
        val handler = Handler(Looper.getMainLooper())
        val at = IntArray(2)
        card.getLocationInWindow(at)
        val x0 = at[0] + card.width / 2f
        val y0 = at[1] + card.height / 2f
        val start = SystemClock.uptimeMillis()
        val steps = 40
        fun send(action: Int, x: Float, y: Float, time: Long) {
            val ev = MotionEvent.obtain(start, time, action, x, y, 0)
            window.callback.dispatchTouchEvent(ev)
            ev.recycle()
        }
        send(MotionEvent.ACTION_DOWN, x0, y0, start)
        for (i in 1..steps) {
            handler.postDelayed({
                val p = i / steps.toFloat()
                val now = SystemClock.uptimeMillis()
                val x = x0 + dp(120f) * sin(p * PI.toFloat())
                val y = y0 + dp(160f) * p
                send(if (i == steps) MotionEvent.ACTION_UP else MotionEvent.ACTION_MOVE, x, y, now)
                if (i == steps) handler.postDelayed({ done(null) }, 500)
            }, i * 16L)
        }
    }
}
