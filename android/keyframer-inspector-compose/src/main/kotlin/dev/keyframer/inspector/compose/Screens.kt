package dev.keyframer.inspector.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.navigation.NavController
import dev.keyframer.inspector.Keyframer
import dev.keyframer.inspector.KeyframerExtensionApi
import dev.keyframer.inspector.KeyframerExtensions

/**
 * Names the screen while this is in the composition: `KfScreen("Settings")` at the top of a screen's
 * content. Navigation markers then say `Settings` instead of the activity's name. The screen is the
 * most recently composed KfScreen still composed; when it leaves, the one under it names the screen
 * again (the KfScreen before it, else what Keyframer.setRoute set, else the activity). A new `name`
 * renames it in place. One screen leaving as the next one enters, in the same frame, is one navigation
 * marker.
 */
@OptIn(KeyframerExtensionApi::class)
@Composable
fun KfScreen(name: String) {
    val context = LocalContext.current
    val screen = remember { Any() }
    DisposableEffect(screen) {
        KeyframerExtensions.declareScreen(screen, name, context.activity())
        onDispose { KeyframerExtensions.undeclareScreen(screen) }
    }
    // After the effect above on the first composition (a no-op then), and on every new name after it.
    SideEffect { KeyframerExtensions.declareScreen(screen, name, context.activity()) }
}

/**
 * Screens from Navigation: every destination change names the screen by its route pattern
 * (`product/{id}`), or its label when it has no route, through Keyframer.setRoute. Call it once, next to
 * the NavHost: `KfNavigation(navController)`. A KfScreen inside a destination names the screen over it.
 */
@Composable
fun KfNavigation(navController: NavController) {
    DisposableEffect(navController) {
        val listener = NavController.OnDestinationChangedListener { _, destination, _ ->
            Keyframer.setRoute(destination.route ?: destination.label?.toString() ?: destination.navigatorName)
        }
        navController.addOnDestinationChangedListener(listener)
        onDispose { navController.removeOnDestinationChangedListener(listener) }
    }
}
