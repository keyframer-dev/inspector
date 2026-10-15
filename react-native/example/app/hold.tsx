import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { scheduleOnRN } from 'react-native-worklets'
import { useReplayKey } from '../components/replay'
import { colors, Note } from '../components/ui'

const TILES = ['#f4a261', '#e76f51', '#9d4edd', '#2a9d8f', '#264653', '#c2417b']

/** A photo tile: press shrinks it a little, a long press lifts it and opens its menu (Gesture.LongPress, UI thread). */
function Tile({ color, index }: { color: string; index: number }) {
  const press = useSharedValue(1)
  const lift = useSharedValue(0)
  const hold = Gesture.LongPress()
    .minDuration(450)
    .onBegin(() => {
      press.value = withTiming(0.94, { duration: 450 })
    })
    .onStart(() => {
      press.value = withSpring(1, { damping: 12 })
      lift.value = withSpring(1, { damping: 14, stiffness: 180 })
    })
    .onFinalize(() => {
      press.value = withSpring(1)
      lift.value = withTiming(0, { duration: 220 })
    })
  const tileStyle = useAnimatedStyle(() => ({
    zIndex: lift.value > 0.01 ? 10 : 0,
    transform: [{ scale: press.value * (1 + lift.value * 0.08) }, { translateY: -lift.value * 6 }],
    shadowOpacity: lift.value * 0.25,
  }))
  const menuStyle = useAnimatedStyle(() => ({ opacity: lift.value, transform: [{ translateY: (1 - lift.value) * -8 }] }))
  return (
    <GestureDetector gesture={hold}>
      <Animated.View style={[styles.tile, { backgroundColor: color }, tileStyle]}>
        <Text style={styles.tileText}>Photo {index + 1}</Text>
        <Animated.View pointerEvents="none" style={[styles.menu, menuStyle]}>
          {['Share', 'Favorite', 'Delete'].map((m) => (
            <Text key={m} style={styles.menuItem}>
              {m}
            </Text>
          ))}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  )
}

/** Hold to delete: a Pressable (JS thread) fills a bar while held and removes the row when it completes. */
function HoldToDelete({ onDone }: { onDone: () => void }) {
  const fill = useSharedValue(0)
  const gone = useSharedValue(0)
  const fillStyle = useAnimatedStyle(() => ({ width: `${fill.value * 100}%` }))
  const rowStyle = useAnimatedStyle(() => ({ opacity: 1 - gone.value, transform: [{ scale: 1 - gone.value * 0.1 }] }))
  return (
    <Animated.View style={rowStyle}>
      <Pressable
        onPressIn={() =>
          fill.set(
            withTiming(1, { duration: 900 }, (finished) => {
              if (finished) gone.value = withTiming(1, { duration: 260 }, (f) => f && scheduleOnRN(onDone))
            }),
          )
        }
        onPressOut={() => {
          if (fill.get() < 1) fill.set(withTiming(0, { duration: 180 }))
        }}
        style={styles.holdButton}
        testID="hold-delete"
      >
        <Animated.View style={[styles.holdFill, fillStyle]} />
        <Text style={styles.holdText}>Hold to delete</Text>
      </Pressable>
    </Animated.View>
  )
}

export default function Hold() {
  const run = useReplayKey()
  const [deleted, setDeleted] = useState(0)
  return (
    <View key={run} style={styles.container}>
      <Note>Long press a photo: it shrinks while you hold, then lifts and opens a menu. Hold the button below until the bar fills.</Note>
      <View style={styles.grid}>
        {TILES.map((c, i) => (
          <Tile key={c} color={c} index={i} />
        ))}
      </View>
      <HoldToDelete key={deleted} onDone={() => setDeleted((d) => d + 1)} />
      {deleted > 0 && <Text style={styles.count}>Deleted {deleted}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  tile: { width: '47%', aspectRatio: 1, borderRadius: 18, padding: 12, justifyContent: 'flex-end', shadowColor: '#000', shadowRadius: 16, shadowOffset: { width: 0, height: 8 } },
  tileText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  menu: { position: 'absolute', top: 10, right: 10, padding: 8, gap: 6, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.95)' },
  menuItem: { fontSize: 13, fontWeight: '600', color: colors.ink },
  holdButton: { height: 52, borderRadius: 14, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', backgroundColor: '#f1d9d6' },
  holdFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: colors.red },
  holdText: { fontWeight: '700', color: colors.ink },
  count: { textAlign: 'center', color: colors.muted },
})
