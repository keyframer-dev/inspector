package dev.keyframer.example

import android.animation.ObjectAnimator
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.LinearLayout
import dev.keyframer.inspector.kfTrack

/** The second screen: a sheet that slides up when it opens. */
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

        ObjectAnimator.ofFloat(sheet, View.TRANSLATION_Y, dp(360f), 0f).apply {
            duration = 520
            interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
        }.kfTrack("sheet").start()
    }
}
