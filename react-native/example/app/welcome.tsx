import { useIsFocused } from 'expo-router'
import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { cancelAnimation, interpolate, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated'
import { useReplayKey } from '../components/replay'
import { Button, colors } from '../components/ui'

function WelcomeHero() {
  const logoScale = useSharedValue(0.6)
  const cardY = useSharedValue(60)
  const cardOpacity = useSharedValue(0)

  useEffect(() => {
    logoScale.value = withSpring(1, { damping: 20, stiffness: 180, mass: 4 })
    cardY.value = withDelay(150, withTiming(0, { duration: 420 }))
    cardOpacity.value = withDelay(150, withTiming(1, { duration: 300 }))
  }, [logoScale, cardY, cardOpacity])

  const logoStyle = useAnimatedStyle(() => ({ transform: [{ scale: logoScale.value }] }))
  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ translateY: cardY.value }],
  }))

  return (
    <View style={styles.hero}>
      <Animated.View style={[styles.logo, logoStyle]} />
      <Animated.View style={[styles.card, cardStyle]}>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.body}>Every animation on this screen shows up in the Inspector.</Text>
      </Animated.View>
    </View>
  )
}

function ShimmerBar() {
  const shimmer = useSharedValue(0)
  // Loops only while this screen is on top: it stays mounted under the screens pushed after it.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    shimmer.value = withRepeat(withTiming(1, { duration: 810 }), -1, true)
    return () => cancelAnimation(shimmer)
  }, [shimmer, focused])
  const style = useAnimatedStyle(() => ({ opacity: interpolate(shimmer.value, [0, 1], [0.35, 1]) }))
  return <Animated.View style={[styles.shimmer, style]} />
}

function SwipeCard() {
  const dragX = useSharedValue(0)
  const pan = Gesture.Pan()
    .onChange((e) => {
      dragX.value += e.changeX
    })
    .onEnd(() => {
      dragX.value = withSpring(0, { damping: 14, stiffness: 160, mass: 4 })
    })
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: dragX.value }, { rotate: `${dragX.value / 20}deg` }],
  }))
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.swipe, style]}>
        <Text style={styles.swipeText}>Drag me</Text>
      </Animated.View>
    </GestureDetector>
  )
}

function NotificationBadge() {
  const badge = useSharedValue(0)
  useEffect(() => {
    badge.value = withDelay(400, withSequence(withTiming(1.2, { duration: 630 }), withSpring(1.33, { damping: 11, mass: 4 })))
  }, [badge])
  const style = useAnimatedStyle(() => ({ transform: [{ scale: badge.value }] }))
  return (
    <Animated.View style={[styles.badge, style]}>
      <Text style={styles.badgeText}>3</Text>
    </Animated.View>
  )
}

export default function Welcome() {
  // The inspector's Replay, or the button below, re-mounts the screen so every entrance runs again.
  const replay = useReplayKey()
  const [run, setRun] = useState(0)
  return (
    <View key={`${replay}-${run}`} style={styles.container}>
      <NotificationBadge />
      <WelcomeHero />
      <ShimmerBar />
      <SwipeCard />
      <Button testID="welcome-replay" title="Replay" onPress={() => setRun((r) => r + 1)} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 28, padding: 24 },
  hero: { alignItems: 'center', gap: 20 },
  logo: { width: 72, height: 72, borderRadius: 20, backgroundColor: colors.orange },
  card: { width: 280, padding: 18, borderRadius: 16, backgroundColor: colors.card, gap: 6 },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink },
  body: { fontSize: 14, color: colors.muted },
  shimmer: { width: 280, height: 12, borderRadius: 6, backgroundColor: '#7c74d8' },
  swipe: { width: 200, height: 120, borderRadius: 16, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  swipeText: { color: '#fff', fontWeight: '600' },
  badge: { position: 'absolute', top: 40, right: 40, width: 32, height: 32, borderRadius: 16, backgroundColor: colors.red, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontWeight: '700' },
})
