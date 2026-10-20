package dev.keyframer.inspector.compose

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.InfiniteTransition
import androidx.compose.animation.core.Transition
import androidx.compose.animation.core.TwoWayConverter
import dev.keyframer.inspector.KeyframerExtensionApi
import dev.keyframer.inspector.KeyframerExtensions
import dev.keyframer.inspector.core.CallSite
import dev.keyframer.inspector.core.CallSites
import dev.keyframer.inspector.core.InspectorSession
import dev.keyframer.inspector.core.Signal
import dev.keyframer.inspector.core.SignalSite
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/*
 * How tracked Compose animations reach the session. Each tracked call (kfAnimateFloatAsState,
 * rememberKfAnimatable, kfUpdateTransition, rememberKfInfiniteTransition) finds its call site once, from
 * the stack of its first composition (the composable that called it: file, line, and the function as
 * the component), registers signals while it is in the composition, and reports an `anim` event on
 * every start. Everything here runs on the main thread: composition, effects and the session alike.
 */

@OptIn(KeyframerExtensionApi::class)
internal val liveSession: InspectorSession? get() = KeyframerExtensions.session

/** The first app frame of a composition's stack, or null when the inspector is not running. */
@OptIn(KeyframerExtensionApi::class)
internal fun locate(stack: Array<StackTraceElement>): CallSites.Located? {
    if (liveSession == null) return null
    return CallSites.firstAppFrame(stack, KeyframerExtensions.libraryPrefixes)?.let { CallSites.site(it) }
}

/**
 * Several instances of one call (rows of a list) get `#2`, `#3`, as tracked animators do. A screen made
 * again (playback navigating back to it) composes before the old one is disposed: the new composition
 * takes the ids of one whose activity is finishing, so recorded samples still find their values.
 */
internal object SignalIds {
    private val owners = HashMap<String, Tracker>()

    fun acquire(base: String, by: Tracker): String {
        var id = base
        var n = 1
        while (true) {
            val holder = owners[id]
            if (holder == null || holder === by) break
            if (holder.leaving) {
                holder.lost = true
                break
            }
            id = "$base#${++n}"
        }
        owners[id] = by
        return id
    }

    fun release(id: String, by: Tracker) {
        if (owners[id] === by) owners.remove(id)
    }
}

/** The activity a composition belongs to (its LocalContext, unwrapped). */
internal tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}

/** A Compose value as a signal: read every frame while recording, written by playback and capture when it can be. */
internal class ComposeSignal(
    override val site: SignalSite,
    private val reader: () -> Double?,
    private val writer: ((Double) -> Unit)? = null,
    private val onHold: () -> Unit = {},
    private val onRelease: () -> Unit = {},
) : Signal {
    override fun read(): Double? = runCatching { reader() }.getOrNull()?.takeIf { it.isFinite() }
    override fun write(v: Double) {
        runCatching { writer?.invoke(v) }
    }
    override fun hold() {
        runCatching(onHold)
    }
    override fun release() {
        runCatching(onRelease)
    }
}

/** Names for a value's components: none for one number, x and y for an Offset, else their index. */
internal fun componentNames(size: Int, names: List<String>?): List<String> = when {
    size <= 1 -> listOf("")
    names != null && names.size == size -> names
    else -> List(size) { it.toString() }
}

/** The signals and reports of one tracked call, from its composition to its disposal. */
internal abstract class Tracker(val at: CallSites.Located, val stack: Array<StackTraceElement>, val fn: String, val label: String?) {
    /** Its call site, with its label when it has one; `#2`, `#3` for more of the same. */
    var id: String = at.id
        private set
    private val signals = ArrayList<String>()
    private var attached = false
    private var owner: WeakReference<Activity>? = null

    /** Its screen is going away: a new composition of the same call may take its ids. */
    val leaving: Boolean get() = owner?.get()?.let { it.isFinishing || it.isDestroyed } == true

    /** Its ids went to a newer composition: what it registered is that one's now. */
    var lost = false

    fun ownedBy(context: Context): Tracker = also { owner = context.activity()?.let { WeakReference(it) } }

    fun attach() {
        val s = liveSession ?: return
        // The label is part of the id, as a tracked animator's name is: rows that label their values
        // keep ids of their own from run to run.
        id = SignalIds.acquire(label?.let { "${at.id}:$it" } ?: at.id, this)
        attached = true
        for (sig in makeSignals()) {
            signals.add(sig.site.id)
            s.addSignal(sig)
        }
    }

    fun detach() {
        if (!attached) return
        attached = false
        if (!lost) liveSession?.let { s -> signals.forEach { s.removeSignal(it) } }
        signals.clear()
        SignalIds.release(id, this)
    }

    /** Signals that join later (a transition's children compose after it). */
    protected fun addSignal(sig: Signal) {
        if (!attached || lost) return
        val s = liveSession ?: return
        signals.add(sig.site.id)
        s.addSignal(sig)
    }

    protected abstract fun makeSignals(): List<Signal>

    protected fun site(sid: String, name: String?, writable: Boolean, kind: String? = null) =
        SignalSite(sid, at.file, at.line, at.component, name, column = 0, writable = if (writable) null else false, kind = kind)

    protected fun report(spec: AnimationSpec<*>?, args: Map<String, Any?>, durationMs: Long?, target: String? = label, prop: String? = null) {
        val s = liveSession ?: return
        val site = CallSite(at.id, at.file, at.line, 0, fn, at.component, target, prop, spec?.let { Specs.params(it) }.orEmpty())
        s.reportAnim(site, listOf(args), stack, durationMs)
    }

    /** The panel's live edits for this call site. */
    protected fun overrides(): Map<String, Double>? = liveSession?.overrides?.get(at.id)
}

/**
 * A value animated by an Animatable: kfAnimate*AsState's own, or one made with rememberKfAnimatable.
 * Its components are signals playback can write (snapTo); holding one stops its animation, and
 * releasing it puts the value back and lets the app's target take over again.
 */
internal class ValueTracker<T, V : AnimationVector>(
    at: CallSites.Located,
    stack: Array<StackTraceElement>,
    fn: String,
    label: String?,
    private val animatable: Animatable<T, V>,
    private val names: List<String>?,
    private val scope: CoroutineScope,
) : Tracker(at, stack, fn, label) {
    /** While playback or capture holds the value, the app's own targets wait. */
    var held = false
        private set
    private var holds = 0
    private var before: T? = null
    private var pending: FloatArray? = null
    /** What kfAnimate*AsState does when let go: animate to its latest target. */
    var onRelease: (() -> Unit)? = null

    override fun makeSignals(): List<Signal> {
        val size = Specs.components(animatable.typeConverter, animatable.value).size
        val n = componentNames(size, names)
        return n.mapIndexed { i, c ->
            val sid = if (c.isEmpty()) id else "$id:$c"
            ComposeSignal(
                site(sid, listOfNotNull(label, c.ifEmpty { null }).joinToString(".").ifEmpty { null }, writable = true),
                reader = { Specs.components(animatable.typeConverter, animatable.value).getOrNull(i)?.toDouble() },
                writer = { v -> write(i, v.toFloat()) },
                onHold = { hold() },
                onRelease = { release() },
            )
        }
    }

    private fun hold() {
        if (holds++ > 0) return
        held = true
        before = animatable.value
        scope.launch(start = CoroutineStart.UNDISPATCHED) { animatable.stop() }
    }

    private fun release() {
        if (holds == 0 || --holds > 0) return
        held = false
        pending = null
        val back = before
        before = null
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            @Suppress("UNCHECKED_CAST")
            if (back != null) animatable.snapTo(back as T)
            onRelease?.invoke()
        }
    }

    /** One component from playback; the others keep the value they have. */
    private fun write(i: Int, v: Float) {
        val converter = animatable.typeConverter
        val like = converter.convertToVector(animatable.value)
        val now = pending ?: Specs.floats(like).also { pending = it }
        if (i !in now.indices) return
        now[i] = v
        val value = converter.convertFromVector(Specs.vector(like, now))
        scope.launch(start = CoroutineStart.UNDISPATCHED) { animatable.snapTo(value) }
    }

    /** An animation to `target` starts: reported, with the panel's edits applied to the spec it runs. */
    fun started(target: T, spec: AnimationSpec<T>): AnimationSpec<T> {
        val effective = Specs.withOverrides(spec, overrides())
        val from = animatable.value
        val args = Specs.describe(effective)
        args["values"] = values(from, target)
        report(effective, args, Specs.durationMs(effective, animatable.typeConverter, from, target, animatable.velocityVector))
        return effective
    }

    private fun values(from: T, to: T): Map<String, List<Float>> {
        val a = Specs.components(animatable.typeConverter, from)
        val b = Specs.components(animatable.typeConverter, to)
        val n = componentNames(a.size, names)
        val out = LinkedHashMap<String, List<Float>>()
        for (i in a.indices) {
            val key = listOfNotNull(label, n[i].ifEmpty { null }).joinToString(".").ifEmpty { "value" }
            out[key] = listOf(a[i], b.getOrElse(i) { a[i] })
        }
        return out
    }

    companion object {
        /** Trackers of Animatables made with rememberKfAnimatable, for kfAnimateTo. */
        val byAnimatable = WeakHashMap<Animatable<*, *>, ValueTracker<*, *>>()
    }
}

/** A Transition's children as signals (and its play time), and one report per change of state. */
internal class TransitionTracker<S>(
    at: CallSites.Located,
    stack: Array<StackTraceElement>,
    label: String?,
    private val transition: Transition<S>,
) : Tracker(at, stack, "updateTransition", label) {
    private val seen = HashSet<Any>()
    private var lastTarget: Any? = transition.targetState

    override fun makeSignals(): List<Signal> = listOf(
        // The transition's play time: a track, not a value on screen.
        ComposeSignal(site("$id:time", listOfNotNull(label, "time").joinToString(" "), writable = false, kind = "time"), { transition.playTimeNanos / 1e6 }),
    )

    /** Children compose after the transition: picked up after each composition. */
    fun syncChildren() {
        for (child in transition.animations) {
            if (!seen.add(child)) continue
            for (sig in childSignals(child.label, child.typeConverter, { child.value })) addSignal(sig)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T, V : AnimationVector> childSignals(childLabel: String, converter: TwoWayConverter<T, V>, value: () -> Any?): List<Signal> {
        val size = Specs.components(converter, value() as T).size
        return componentNames(size, null).mapIndexed { i, c ->
            val name = listOf(childLabel) + listOfNotNull(c.ifEmpty { null })
            ComposeSignal(
                site("$id:${name.joinToString(".")}", name.joinToString("."), writable = false),
                { Specs.components(converter, value() as T).getOrNull(i)?.toDouble() },
            )
        }
    }

    /** After a composition that changed the target: the children have their new targets and specs. */
    fun targetChanged() {
        val target = transition.targetState
        if (target == lastTarget) return
        val from = lastTarget
        lastTarget = target
        val children = LinkedHashMap<String, Any?>()
        for (child in transition.animations) children[child.label] = Specs.describe(child.animationSpec)
        val total = transition.totalDurationNanos
        val ms = if (total in 0 until Long.MAX_VALUE / 4) (total + 500_000) / 1_000_000 else null
        val args = linkedMapOf<String, Any?>("from" to from.toString(), "to" to target.toString(), "duration" to ms, "animations" to children)
        report(null, args, ms)
    }
}

/** An InfiniteTransition's children as signals, each reported once when it starts. */
internal class InfiniteTracker(
    at: CallSites.Located,
    stack: Array<StackTraceElement>,
    label: String?,
    private val transition: InfiniteTransition,
) : Tracker(at, stack, "rememberInfiniteTransition", label) {
    private val seen = HashSet<Any>()

    override fun makeSignals(): List<Signal> = emptyList()

    fun syncChildren() {
        for (child in transition.animations) {
            if (!seen.add(child)) continue
            add(child)
        }
    }

    private fun <T, V : AnimationVector> add(child: InfiniteTransition.TransitionAnimationState<T, V>) {
        val converter = child.typeConverter
        val childLabel = child.label
        val size = Specs.components(converter, child.value).size
        componentNames(size, null).forEachIndexed { i, c ->
            val name = listOf(childLabel) + listOfNotNull(c.ifEmpty { null })
            addSignal(
                ComposeSignal(
                    site("$id:${name.joinToString(".")}", name.joinToString("."), writable = false),
                    { Specs.components(converter, child.value).getOrNull(i)?.toDouble() },
                ),
            )
        }
        val spec = child.animationSpec
        val args = Specs.describe(spec)
        val a = Specs.components(converter, child.animation.initialValue)
        val b = Specs.components(converter, child.animation.targetValue)
        args["values"] = componentNames(a.size, null).mapIndexed { i, c ->
            listOf(childLabel).plus(listOfNotNull(c.ifEmpty { null })).joinToString(".") to listOf(a[i], b.getOrElse(i) { a[i] })
        }.toMap(LinkedHashMap())
        report(spec, args, null, target = childLabel)
    }
}
