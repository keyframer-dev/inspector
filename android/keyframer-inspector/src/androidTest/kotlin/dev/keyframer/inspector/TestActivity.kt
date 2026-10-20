package dev.keyframer.inspector

import android.app.Activity
import android.os.Bundle
import android.widget.FrameLayout

/** An empty screen to attach views to. */
class TestActivity : Activity() {
    lateinit var root: FrameLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        setContentView(root)
    }
}
