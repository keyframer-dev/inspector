package dev.keyframer.example

import android.animation.ObjectAnimator
import android.animation.PropertyValuesHolder
import android.animation.ValueAnimator
import android.app.Activity
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Path
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import dev.keyframer.inspector.kfTrack

/**
 * The second screen: a sheet that slides and fades in when it opens (a LinearLayout with a background
 * and children fading without a hardware layer: a "layer-alpha" render hint), and on API 33+ a dot
 * moving inside a star-shaped clip (clipToOutline with a path: a "mask" hint).
 */
class DetailActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#2B2930")) }
        setContentView(root)

        val sheet = LinearLayout(this).apply {
            id = R.id.sheet
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = rounded(Color.WHITE, dp(28f))
            setPadding(dpi(24), dpi(32), dpi(24), dpi(48))
            addView(label("Detail", 26f))
            addView(button("Back") { finish() })
        }
        root.addView(sheet, FrameLayout.LayoutParams(-1, dpi(360), Gravity.BOTTOM))

        ObjectAnimator.ofPropertyValuesHolder(
            sheet,
            PropertyValuesHolder.ofFloat(View.TRANSLATION_Y, dp(360f), 0f),
            PropertyValuesHolder.ofFloat(View.ALPHA, 0f, 1f),
        ).apply {
            duration = 520
            interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
        }.kfTrack("sheet").start()

        if (Build.VERSION.SDK_INT >= 33) addMaskedDot(root)
    }

    private fun addMaskedDot(root: FrameLayout) {
        val size = dpi(120)
        val star = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#4A4458"))
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setPath(starPath(view.width.toFloat(), view.height.toFloat()))
                }
            }
            clipToOutline = true
        }
        val dot = View(this).apply {
            id = R.id.dot
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#D0BCFF"))
            }
        }
        star.addView(dot, FrameLayout.LayoutParams(dpi(36), dpi(36), Gravity.CENTER_VERTICAL))
        root.addView(star, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dpi(96) })
        ObjectAnimator.ofFloat(dot, View.TRANSLATION_X, 0f, (size - dpi(36)).toFloat()).apply {
            duration = 900
            repeatCount = ValueAnimator.INFINITE
            repeatMode = ValueAnimator.REVERSE
        }.kfTrack("dot").start()
    }

    private fun starPath(w: Float, h: Float) = Path().apply {
        val cx = w / 2
        val cy = h / 2
        for (i in 0 until 10) {
            val r = if (i % 2 == 0) minOf(w, h) / 2 else minOf(w, h) / 4.5f
            val a = Math.PI * i / 5 - Math.PI / 2
            val x = cx + r * Math.cos(a).toFloat()
            val y = cy + r * Math.sin(a).toFloat()
            if (i == 0) moveTo(x, y) else lineTo(x, y)
        }
        close()
    }
}
