package dev.keyframer.inspector

import android.graphics.Outline
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.Window
import android.view.WindowManager

/**
 * What the SDK can see about how an animated view is drawn that costs RenderThread or the GPU more than
 * it needs to, as `renderHint` keys the problems engine words fixes for:
 *
 *   layer-alpha  alpha animates on a view with overlapping rendering and no hardware layer: every frame
 *                draws it into an offscreen buffer first (fix: a hardware layer for the animation, as
 *                ViewPropertyAnimator.withLayer() does, or hasOverlappingRendering() returning false).
 *   elevation    elevation or translationZ animates: the shadow is drawn again every frame (fix: animate
 *                scale or translation and leave the elevation fixed, or keep the outline a simple shape).
 *   mask         the view, or a parent, clips to a path outline (clipToOutline with Outline.setPath, API
 *                33+): the clip is rasterized again as the content moves (rect and round rect clips are
 *                cheap and not reported).
 *   blur         the view's window, or a window above it, blurs what is behind it (FLAG_BLUR_BEHIND, API
 *                31+): moving content under a blur makes the compositor blur again every frame. A
 *                View's own RenderEffect has no getter, so it cannot be seen.
 *
 * Read once per animation start, on its first frame (after the app's own start listeners ran, which may
 * add a layer). Main thread.
 */
internal object RenderHints {
    data class Found(val hint: String, val property: String?, val detail: String)

    /** `properties`: what the animator animates on `view` (PropertyValuesHolder names: alpha, elevation). */
    fun check(view: View, properties: Collection<String>, windowAbove: Window?): List<Found> {
        val out = ArrayList<Found>()
        val name = view.javaClass.simpleName.ifEmpty { "View" }
        if ("alpha" in properties && view.getHasOverlappingRendering() && view.layerType != View.LAYER_TYPE_HARDWARE) {
            out.add(Found("layer-alpha", "alpha", "alpha animates on $name, which has overlapping rendering and no hardware layer"))
        }
        for (p in properties) {
            if (p == "elevation" || p == "translationZ" || p == "z") {
                out.add(Found("elevation", p, "$p animates on $name, so its shadow is drawn again every frame"))
                break
            }
        }
        pathClip(view)?.let { clipper ->
            val who = if (clipper === view) "$name clips" else "${clipper.javaClass.simpleName.ifEmpty { "A parent" }} clips $name"
            out.add(Found("mask", null, "$who to a path outline (clipToOutline)"))
        }
        blur(view, windowAbove)?.let { out.add(Found("blur", null, it)) }
        return out
    }

    /** The view or the nearest parent that clips to a path outline, or null. Paths clip only from API 33. */
    private fun pathClip(view: View): View? {
        if (Build.VERSION.SDK_INT < 33) return null
        val outline = Outline()
        val rect = Rect()
        var v: View? = view
        var depth = 0
        while (v != null && depth++ < 64) {
            if (v.clipToOutline) {
                val clips = runCatching {
                    outline.setEmpty()
                    v!!.outlineProvider?.getOutline(v, outline)
                    // getRect is false for a path: neither a rect nor a round rect.
                    !outline.isEmpty && outline.canClip() && !outline.getRect(rect)
                }.getOrDefault(false)
                if (clips) return v
            }
            v = v.parent as? View
        }
        return null
    }

    private fun blur(view: View, windowAbove: Window?): String? {
        if (Build.VERSION.SDK_INT < 31) return null
        val own = view.rootView?.layoutParams as? WindowManager.LayoutParams
        if (own != null && blursBehind(own)) return "its window blurs what is behind it (blurBehindRadius ${own.blurBehindRadius})"
        val above = windowAbove?.attributes
        if (above != null && above !== own && blursBehind(above)) {
            return "a window above it blurs what is behind it (blurBehindRadius ${above.blurBehindRadius}), so its moves are blurred again every frame"
        }
        return null
    }

    private fun blursBehind(p: WindowManager.LayoutParams): Boolean =
        Build.VERSION.SDK_INT >= 31 && p.flags and WindowManager.LayoutParams.FLAG_BLUR_BEHIND != 0 && p.blurBehindRadius > 0
}
