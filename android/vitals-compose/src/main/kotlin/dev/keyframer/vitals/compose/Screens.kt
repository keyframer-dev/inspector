package dev.keyframer.vitals.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.navigation.NavController
import dev.keyframer.vitals.KeyframerVitals

/**
 * Names the screen while this is in the composition: `KfVitalsScreen("checkout")` at the top of a
 * destination. Reports show it after its activity (`MainActivity/checkout`). Pass a pattern, not data.
 */
@Composable
fun KfVitalsScreen(name: String) {
    DisposableEffect(name) {
        KeyframerVitals.setScreen(name)
        onDispose { }
    }
}

/**
 * Screens from Navigation: every destination change names the screen by its route pattern
 * (`product/{id}`, never the id itself), or its label when it has no route. Call it once, next to the
 * NavHost: `KfVitalsNavigation(navController)`.
 */
@Composable
fun KfVitalsNavigation(navController: NavController) {
    DisposableEffect(navController) {
        val listener = NavController.OnDestinationChangedListener { _, destination, _ ->
            val name = destination.route ?: destination.label?.toString() ?: destination.navigatorName
            KeyframerVitals.setScreen(name)
        }
        navController.addOnDestinationChangedListener(listener)
        onDispose { navController.removeOnDestinationChangedListener(listener) }
    }
}
