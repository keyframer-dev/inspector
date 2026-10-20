package dev.keyframer.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.animateColor
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDp
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.keyframer.inspector.compose.kfAnimateDpAsState
import dev.keyframer.inspector.compose.kfAnimateFloatAsState
import dev.keyframer.inspector.compose.kfAnimateTo
import dev.keyframer.inspector.compose.kfUpdateTransition
import dev.keyframer.inspector.compose.rememberKfAnimatable
import dev.keyframer.inspector.compose.rememberKfInfiniteTransition
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/**
 * The Compose screen: an infinite pulse, a card that expands on tap (animate*AsState and a transition),
 * and a ball dragged sideways that springs back (Animatable). Every one is tracked; release builds link
 * keyframer-inspector-compose-noop, where the same calls are Compose's own.
 */
class ComposeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ComposeScreen() }
    }

    companion object {
        /** What the "toggle compose card" scenario taps. */
        var toggle: (() -> Unit)? = null
    }
}

@Composable
fun ComposeScreen() {
    Column(
        Modifier.fillMaxSize().background(Color(0xFFF4F3F8)).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
        BasicText("Compose", style = TextStyle(fontSize = 34.sp, color = Color(0xFF1B1B1F)), modifier = Modifier.padding(top = 48.dp))
        Pulse()
        ExpandingCard()
        SpringBall()
    }
}

@Composable
fun Pulse() {
    val pulse = rememberKfInfiniteTransition(label = "pulse")
    val scale by pulse.animateFloat(
        initialValue = 1f,
        targetValue = 1.3f,
        animationSpec = infiniteRepeatable(tween(700, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "scale",
    )
    Box(Modifier.size(56.dp).graphicsLayer { scaleX = scale; scaleY = scale }.background(Color(0xFF6750A4), CircleShape))
}

@Composable
fun ExpandingCard() {
    var expanded by remember { mutableStateOf(false) }
    DisposableEffect(Unit) {
        ComposeActivity.toggle = { expanded = !expanded }
        onDispose { ComposeActivity.toggle = null }
    }
    val height by kfAnimateDpAsState(if (expanded) 200.dp else 110.dp, spring(dampingRatio = 0.6f, stiffness = 300f), label = "height")
    val corner by kfAnimateFloatAsState(if (expanded) 32f else 20f, tween(400), label = "corner")
    val transition = kfUpdateTransition(expanded, label = "card")
    val color by transition.animateColor(label = "color") { if (it) Color(0xFF6750A4) else Color(0xFF1D6F5F) }
    val tilt by transition.animateFloat(label = "tilt", transitionSpec = { tween(500) }) { if (it) 0f else -3f }
    val textSize by transition.animateDp(label = "textSize") { if (it) 24.dp else 18.dp }
    Box(
        Modifier
            .fillMaxWidth(0.6f)
            .height(height)
            .graphicsLayer { rotationZ = tilt }
            .clip(RoundedCornerShape(corner.dp))
            .background(color)
            .clickable { expanded = !expanded },
        contentAlignment = Alignment.Center,
    ) {
        BasicText(if (expanded) "Tap to close" else "Tap me", style = TextStyle(fontSize = textSize.value.sp, color = Color.White))
    }
}

@Composable
fun SpringBall() {
    val x = rememberKfAnimatable(0f, label = "ballX")
    val scope = rememberCoroutineScope()
    Box(
        Modifier
            .offset { IntOffset(x.value.roundToInt(), 0) }
            .size(64.dp)
            .background(Color(0xFFB3261E), CircleShape)
            .pointerInput(Unit) {
                detectHorizontalDragGestures(
                    onHorizontalDrag = { _, dx -> scope.launch { x.snapTo(x.value + dx) } },
                    onDragEnd = { scope.launch { x.kfAnimateTo(0f, spring(dampingRatio = 0.35f, stiffness = 200f)) } },
                )
            },
    )
}
