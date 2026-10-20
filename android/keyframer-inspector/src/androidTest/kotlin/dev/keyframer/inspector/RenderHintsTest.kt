package dev.keyframer.inspector

import android.graphics.Color
import android.graphics.Outline
import android.graphics.Path
import android.os.Build
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RenderHintsTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun card() = FrameLayout(context).apply {
        setBackgroundColor(Color.RED)
        addView(View(context))
        layout(0, 0, 200, 200)
    }

    private fun hints(view: View, vararg props: String) = RenderHints.check(view, props.toList(), null).map { it.hint to it.property }

    @Test
    fun alphaOnOverlappingContentWithoutALayer() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val v = card()
            assertEquals(listOf("layer-alpha" to "alpha"), hints(v, "alpha", "translationY"))
            v.setLayerType(View.LAYER_TYPE_HARDWARE, null)
            assertEquals(emptyList<Pair<String, String?>>(), hints(v, "alpha"))
            // A view that says it does not overlap draws straight to the screen.
            v.setLayerType(View.LAYER_TYPE_NONE, null)
            v.forceHasOverlappingRendering(false)
            assertEquals(emptyList<Pair<String, String?>>(), hints(v, "alpha"))
        }
    }

    @Test
    fun elevationAnimating() {
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            assertEquals(listOf("elevation" to "translationZ"), hints(card(), "translationZ"))
            assertEquals(listOf("elevation" to "elevation"), hints(card(), "elevation", "z"))
        }
    }

    @Test
    fun pathClipAboveMovingContent() {
        assumeTrue("paths clip from API 33", Build.VERSION.SDK_INT >= 33)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val clipper = card()
            val moving = clipper.getChildAt(0)
            clipper.outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setPath(Path().apply { moveTo(0f, 0f); lineTo(200f, 100f); lineTo(0f, 200f); close() })
                }
            }
            clipper.clipToOutline = true
            assertEquals(listOf("mask" to null), hints(moving, "translationX"))
            // A round rect clips cheaply: not a hint.
            clipper.outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) = outline.setRoundRect(0, 0, 200, 200, 24f)
            }
            assertEquals(emptyList<Pair<String, String?>>(), hints(moving, "translationX"))
        }
    }
}
