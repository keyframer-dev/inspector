package dev.keyframer.example

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.widget.Button
import android.widget.TextView

internal fun Context.dp(v: Float) = v * resources.displayMetrics.density
internal fun Context.dpi(v: Int) = (v * resources.displayMetrics.density).toInt()

internal fun rounded(color: Int, radius: Float) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = radius
}

internal fun Context.label(text: String, size: Float, color: Int = Color.parseColor("#1B1B1F")) = TextView(this).apply {
    this.text = text
    textSize = size
    setTextColor(color)
    gravity = Gravity.CENTER
}

internal fun Context.button(text: String, onClick: () -> Unit) = Button(this).apply {
    this.text = text
    isAllCaps = false
    setOnClickListener { onClick() }
}
