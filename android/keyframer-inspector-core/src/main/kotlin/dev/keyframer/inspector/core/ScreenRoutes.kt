package dev.keyframer.inspector.core

import java.util.WeakHashMap

/**
 * Which screen each activity (any owner) is on, as navigation markers name it. In order: the screens
 * it declares while they are composed (KfScreen: the most recently declared one still declared, and
 * the one under it again when that one goes), else the route the app set for it (Keyframer.setRoute),
 * else the activity's own name. The app's route is kept per activity, so an activity that comes back
 * (from the background, or from behind a permission dialog) keeps the name the app gave it instead of
 * its class name replacing it.
 *
 * Declared screens change in bursts: one leaving as the next enters, in the same frame. `changed` runs
 * once per burst, on the scheduler's next turn, so a swap is one marker, not a flicker through the
 * activity's name. Owners are held weakly. Single threaded.
 */
class ScreenRoutes(private val scheduler: Scheduler, private val changed: () -> Unit) {
    data class Route(val name: String, val params: Map<String, Any?>? = null)

    private class Declared(val token: Any, var name: String)

    private class Screens {
        /** Oldest first: the last one is the screen. */
        val declared = ArrayList<Declared>()
        var set: Route? = null
    }

    private val owners = WeakHashMap<Any, Screens>()
    private var pending: Cancellable? = null

    /** What `owner` is called now: its newest declared screen, else the route set for it, else `ownName`. */
    fun routeOf(owner: Any, ownName: String): Route {
        val s = owners[owner] ?: return Route(ownName)
        s.declared.lastOrNull()?.let { return Route(it.name) }
        return s.set ?: Route(ownName)
    }

    /** The route the app set for `owner`, what it is called while it declares no screen. */
    fun set(owner: Any, name: String, params: Map<String, Any?>?) {
        owners.getOrPut(owner) { Screens() }.set = Route(name, params)
    }

    /** A screen `token` declares in `owner`, on top of the ones before it. Declared again, it is renamed in place. */
    fun declare(owner: Any, token: Any, name: String) {
        val s = owners.getOrPut(owner) { Screens() }
        val existing = s.declared.firstOrNull { it.token === token }
        if (existing == null) {
            s.declared.add(Declared(token, name))
        } else {
            if (existing.name == name) return
            existing.name = name
        }
        changedSoon()
    }

    /** The screen `token` declared went away: the one under it is the screen again. */
    fun undeclare(token: Any) {
        for (s in owners.values) {
            if (s.declared.removeAll { it.token === token }) {
                changedSoon()
                return
            }
        }
    }

    /** The activity went away, and what it was called with it. */
    fun forget(owner: Any) {
        owners.remove(owner)
    }

    fun dispose() {
        pending?.cancel()
        pending = null
    }

    private fun changedSoon() {
        if (pending != null) return
        pending = scheduler.post(0) {
            pending = null
            changed()
        }
    }
}
