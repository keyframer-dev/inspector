package dev.keyframer.inspector.core

import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals

class ScreenRoutesTest {
    private lateinit var p: TestPlatform
    private lateinit var routes: ScreenRoutes
    /** What the host would show after each burst: the route of `main`, the activity on top. */
    private val shown = ArrayList<String>()
    private val main = Any()
    private val detail = Any()

    @BeforeTest
    fun setUp() {
        p = TestPlatform()
        routes = ScreenRoutes(p) { shown.add(routes.routeOf(main, "MainActivity").name) }
    }

    private fun route(owner: Any = main) = routes.routeOf(owner, if (owner === main) "MainActivity" else "DetailActivity")

    @Test
    fun `an activity is its own name until the app names it, and keeps the name the app set`() {
        assertEquals(ScreenRoutes.Route("MainActivity"), route())
        routes.set(main, "feed", mapOf("tab" to "home"))
        assertEquals(ScreenRoutes.Route("feed", mapOf("tab" to "home")), route())
        // Each activity keeps its own: coming back to it (a resume) names it as the app did.
        assertEquals(ScreenRoutes.Route("DetailActivity"), route(detail))
        routes.forget(main)
        assertEquals(ScreenRoutes.Route("MainActivity"), route())
    }

    @Test
    fun `the newest declared screen still composed is the route, and the one under it comes back`() {
        val a = Any()
        val b = Any()
        routes.set(main, "feed", null)
        routes.declare(main, a, "Home")
        routes.declare(main, b, "Settings")
        assertEquals("Settings", route().name)
        routes.undeclare(b)
        assertEquals("Home", route().name)
        routes.undeclare(a)
        // No declared screen left: the route the app set, else the activity.
        assertEquals("feed", route().name)
        // Screens are per activity.
        routes.declare(detail, Any(), "Sheet")
        assertEquals("feed", route().name)
        assertEquals("Sheet", route(detail).name)
    }

    @Test
    fun `a new name renames in place`() {
        val a = Any()
        val b = Any()
        routes.declare(main, a, "Home")
        routes.declare(main, b, "Settings")
        routes.declare(main, a, "Home 2")
        // Still under Settings: renaming does not move it to the top.
        assertEquals("Settings", route().name)
        routes.undeclare(b)
        assertEquals("Home 2", route().name)
        routes.declare(main, a, "Home 3")
        assertEquals("Home 3", route().name)
    }

    @Test
    fun `a swap in one frame shows once, with the new screen`() {
        val a = Any()
        val b = Any()
        routes.declare(main, a, "Home")
        p.runDue()
        assertEquals(listOf("Home"), shown)
        // The old screen leaves as the new one enters: never the activity's name in between.
        routes.undeclare(a)
        routes.declare(main, b, "Settings")
        p.runDue()
        assertEquals(listOf("Home", "Settings"), shown)
        // The same name again is no change at all.
        routes.declare(main, b, "Settings")
        p.runDue()
        assertEquals(2, shown.size)
        routes.undeclare(b)
        p.runDue()
        assertEquals(listOf("Home", "Settings", "MainActivity"), shown)
    }

    @Test
    fun `dispose drops a burst not shown yet`() {
        routes.declare(main, Any(), "Home")
        routes.dispose()
        p.runDue()
        assertEquals(emptyList(), shown)
    }
}
