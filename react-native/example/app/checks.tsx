import { router, useIsFocused } from 'expo-router'
import { useEffect } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useReplayKey } from '../components/replay'
import { Button, colors, Note } from '../components/ui'

/**
 * Motion that works and still is a mistake, for the inspector's detectors to find: an animation that
 * ignores Reduce Motion, a loop that keeps running under another screen, two animations fighting over
 * one value, and drawing that costs more than it needs to (a shadow without a background, a width
 * animated instead of a transform).
 */

/** Two pulses: one ignores Reduce Motion, the other follows it (Reanimated's default). */
function Pulses() {
  const ignores = useSharedValue(1)
  const follows = useSharedValue(1)
  // Only while this screen is on top: these two are not the loop under another screen (below).
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    // withRepeat has its own reduceMotion (the system's by default): both must say Never to ignore it.
    ignores.value = withRepeat(withTiming(1.35, { duration: 700, reduceMotion: ReduceMotion.Never }), -1, true, undefined, ReduceMotion.Never)
    follows.value = withRepeat(withTiming(1.35, { duration: 700 }), -1, true)
    return () => {
      cancelAnimation(ignores)
      cancelAnimation(follows)
    }
  }, [ignores, follows, focused])
  const ignoresStyle = useAnimatedStyle(() => ({ transform: [{ scale: ignores.value }] }))
  const followsStyle = useAnimatedStyle(() => ({ transform: [{ scale: follows.value }] }))
  return (
    <View style={styles.row}>
      <View style={styles.pulseCell}>
        <Animated.View style={[styles.dot, { backgroundColor: colors.red }, ignoresStyle]} />
        <Text style={styles.caption}>Ignores Reduce Motion</Text>
      </View>
      <View style={styles.pulseCell}>
        <Animated.View style={[styles.dot, { backgroundColor: colors.green }, followsStyle]} />
        <Text style={styles.caption}>Follows it</Text>
      </View>
    </View>
  )
}

/** A spinner that never checks whether its screen is on top: it keeps turning under the next one. */
function Underneath() {
  const turn = useSharedValue(0)
  useEffect(() => {
    turn.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(turn)
  }, [turn])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }))
  return <Animated.View style={[styles.spinner, style]} />
}

/** A press starts a timing on `x`, and a reaction to the same press starts a spring on it: the spring wins. */
function Tug() {
  const x = useSharedValue(0)
  const kick = useSharedValue(0)
  useAnimatedReaction(
    () => kick.value,
    (now, previous) => {
      if (previous !== null && now !== previous) x.value = withSpring(0, { damping: 6 })
    },
  )
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))
  return (
    <View style={{ gap: 10 }}>
      <View style={styles.lane}>
        <Animated.View style={[styles.box, style]} />
      </View>
      <Button
        testID="checks-tug"
        title="Move it (two animations at once)"
        onPress={() => {
          kick.set(kick.get() + 1)
          x.set(withTiming(160, { duration: 800 }))
        }}
      />
    </View>
  )
}

/** A glow whose radius animates on a view without an opaque background, and a bar that animates its width. */
function Costly() {
  const glow = useSharedValue(4)
  const fill = useSharedValue(0)
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    glow.value = withRepeat(withTiming(18, { duration: 900 }), -1, true)
    fill.value = withRepeat(withTiming(1, { duration: 1400 }), -1, true)
    return () => {
      cancelAnimation(glow)
      cancelAnimation(fill)
    }
  }, [glow, fill, focused])
  const glowStyle = useAnimatedStyle(() => ({ shadowRadius: glow.value }))
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }))
  return (
    <View style={{ gap: 16 }}>
      <Animated.View style={[styles.glow, glowStyle]}>
        <Text style={styles.caption}>A glow on a see-through card</Text>
      </Animated.View>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, fillStyle]} />
      </View>
    </View>
  )
}

export default function Checks() {
  const run = useReplayKey()
  const reduceMotion = useReducedMotion()
  return (
    <ScrollView key={run} contentContainerStyle={styles.container}>
      <Note>
        Record, then use this screen: the inspector should find each of these. Reduce Motion is {reduceMotion ? 'on' : 'off'} on this device
        (Settings, Accessibility, Motion); turn it on to see the first one flagged.
      </Note>

      <Text style={styles.section}>Reduce Motion</Text>
      <Pulses />

      <Text style={styles.section}>A loop under another screen</Text>
      <View style={styles.row}>
        <Underneath />
        <Text style={[styles.caption, { flex: 1 }]}>Keeps turning while another screen covers this one. The glitch lab's spinner stops (useIsFocused).</Text>
      </View>
      <Button testID="checks-cover" title="Open a screen on top" onPress={() => router.push('/welcome')} />

      <Text style={styles.section}>Two animations, one value</Text>
      <Tug />

      <Text style={styles.section}>Drawing cost</Text>
      <Costly />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12, paddingBottom: 60 },
  section: { marginTop: 12, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: colors.faint },
  row: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 16, borderRadius: 16, backgroundColor: colors.card },
  pulseCell: { flex: 1, alignItems: 'center', gap: 10 },
  dot: { width: 28, height: 28, borderRadius: 14 },
  caption: { fontSize: 12, color: colors.muted },
  spinner: { width: 36, height: 36, borderRadius: 10, borderWidth: 4, borderColor: colors.orange, borderTopColor: 'transparent' },
  lane: { height: 56, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 16, backgroundColor: colors.card },
  box: { width: 40, height: 40, borderRadius: 10, backgroundColor: colors.accent },
  // No backgroundColor: on iOS the shadow cannot get a path, and is drawn from the view's pixels.
  glow: {
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowOffset: { width: 0, height: 0 },
  },
  track: { height: 12, borderRadius: 6, backgroundColor: colors.line, overflow: 'hidden' },
  fill: { height: 12, borderRadius: 6, backgroundColor: colors.orange },
})
