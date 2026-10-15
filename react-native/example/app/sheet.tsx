import { StyleSheet, Text, useWindowDimensions, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { Extrapolation, interpolate, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { useReplayKey } from '../components/replay'
import { Button, colors, Note } from '../components/ui'

const SPRING = { damping: 22, stiffness: 220, mass: 0.9 }

export default function Sheet() {
  const run = useReplayKey()
  const { height } = useWindowDimensions()
  // Snap points, as distances from the top of the screen: full, half, closed.
  const full = height * 0.18
  const half = height * 0.55
  const closed = height
  const sheetY = useSharedValue(closed)
  const dragStart = useSharedValue(0)

  const pan = Gesture.Pan()
    .onStart(() => {
      dragStart.value = sheetY.value
    })
    .onUpdate((e) => {
      sheetY.value = Math.max(full - 40, dragStart.value + e.translationY)
    })
    .onEnd((e) => {
      // Throw it: where it would land with its velocity, then the nearest snap point.
      const landing = sheetY.value + e.velocityY * 0.15
      const target = [full, half, closed].reduce((a, b) => (Math.abs(b - landing) < Math.abs(a - landing) ? b : a))
      sheetY.value = withSpring(target, { ...SPRING, velocity: e.velocityY })
    })

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sheetY.value }] }))
  const backdropStyle = useAnimatedStyle(() => ({ opacity: interpolate(sheetY.value, [full, closed], [0.45, 0], Extrapolation.CLAMP) }))

  return (
    <View key={run} style={styles.container}>
      <Note>Open the sheet, then drag or throw it between full, half and closed. The drag and the snap run on the UI thread, from a worklet.</Note>
      <View style={{ gap: 10 }}>
        <Button testID="sheet-open-half" title="Open halfway" tone="primary" onPress={() => sheetY.set(withSpring(half, SPRING))} />
        <Button testID="sheet-open-full" title="Open fully" onPress={() => sheetY.set(withSpring(full, SPRING))} />
      </View>
      <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />
      <GestureDetector gesture={pan}>
        <Animated.View style={[styles.sheet, { height }, sheetStyle]}>
          <View style={styles.handle} />
          <Text style={styles.title}>Filters</Text>
          {['Newest first', 'Only with photos', 'Within 5 km', 'Open now', 'Free delivery'].map((t) => (
            <View key={t} style={styles.option}>
              <Text style={styles.optionText}>{t}</Text>
            </View>
          ))}
          <Button testID="sheet-close" title="Close" onPress={() => sheetY.set(withSpring(closed, SPRING))} style={{ marginTop: 12 }} />
        </Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 20 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: '#000' },
  sheet: { position: 'absolute', left: 0, right: 0, top: 0, padding: 20, gap: 10, borderTopLeftRadius: 24, borderTopRightRadius: 24, backgroundColor: colors.card },
  handle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line, marginBottom: 6 },
  title: { fontSize: 20, fontWeight: '700', color: colors.ink },
  option: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  optionText: { fontSize: 15, color: colors.ink },
})
