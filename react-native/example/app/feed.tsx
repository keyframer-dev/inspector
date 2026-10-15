import { router } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import type { FlatList } from 'react-native'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReplayKey } from '../components/replay'
import { onBus } from '../components/bus'
import { colors } from '../components/ui'

const ITEMS = Array.from({ length: 60 }, (_, i) => ({ id: String(i), title: `Post ${i + 1}`, body: 'A row that fades in as it appears. Like it to see the heart pop.' }))
const HEADER_MAX = 150
const HEADER_MIN = 64

/** Burns `ms` of the JS thread: what a heavy row render does to a scroll. */
function busy(ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {}
}

function Row({ index, title, body, slow }: { index: number; title: string; body: string; slow: boolean }) {
  if (slow) busy(8)
  const appear = useSharedValue(0)
  const heart = useSharedValue(1)
  const [liked, setLiked] = useState(false)
  useEffect(() => {
    appear.value = withDelay((index % 8) * 40, withTiming(1, { duration: 300 }))
  }, [appear, index])
  const rowStyle = useAnimatedStyle(() => ({ opacity: appear.value, transform: [{ translateY: (1 - appear.value) * 16 }] }))
  const heartStyle = useAnimatedStyle(() => ({ transform: [{ scale: heart.value }] }))
  return (
    <Animated.View style={[styles.row, rowStyle]}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        <Text style={styles.rowBody}>{body}</Text>
      </View>
      <Pressable
        hitSlop={12}
        onPress={() => {
          setLiked((l) => !l)
          heart.set(withSequence(withTiming(1.5, { duration: 110 }), withSpring(1, { damping: 6 })))
        }}
      >
        <Animated.Text style={[styles.heart, heartStyle, liked && { color: colors.red }]}>{liked ? '♥' : '♡'}</Animated.Text>
      </Pressable>
    </Animated.View>
  )
}

export default function Feed() {
  const run = useReplayKey()
  const insets = useSafeAreaInsets()
  const [slow, setSlow] = useState(false)
  // Scenarios scroll the list (components/scenarios.ts).
  const list = useRef<FlatList<(typeof ITEMS)[number]>>(null)
  useEffect(() => onBus('feed:scroll', (offset) => list.current?.scrollToOffset({ offset: Number(offset), animated: true })), [])
  const scrollY = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y
  })
  const headerStyle = useAnimatedStyle(() => ({
    height: interpolate(scrollY.value, [0, HEADER_MAX - HEADER_MIN], [HEADER_MAX, HEADER_MIN], Extrapolation.CLAMP) + insets.top,
  }))
  const titleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(scrollY.value, [0, HEADER_MAX - HEADER_MIN], [1, 0.7], Extrapolation.CLAMP) }],
  }))
  const subtitleStyle = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.value, [0, 50], [1, 0], Extrapolation.CLAMP) }))

  return (
    <View key={run} style={{ flex: 1 }}>
      <Animated.FlatList
        ref={list}
        data={ITEMS}
        keyExtractor={(i) => i.id}
        renderItem={({ item, index }) => <Row index={index} title={item.title} body={item.body} slow={slow} />}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ paddingTop: HEADER_MAX + insets.top + 12, paddingHorizontal: 16, paddingBottom: 40, gap: 10 }}
        extraData={slow}
      />
      <Animated.View style={[styles.header, { paddingTop: insets.top }, headerStyle]}>
        <View style={[styles.headerRow, { top: insets.top + 6 }]}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
          <View style={styles.toggle}>
            <Text style={styles.toggleText}>Slow rows</Text>
            <Switch testID="feed-slow" value={slow} onValueChange={setSlow} />
          </View>
        </View>
        <Animated.Text style={[styles.headerTitle, titleStyle]}>Feed</Animated.Text>
        <Animated.Text style={[styles.headerSub, subtitleStyle]}>Scroll: the header collapses on the UI thread. Turn on slow rows to make the JS thread drop frames.</Animated.Text>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  header: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 16, backgroundColor: colors.bg, justifyContent: 'flex-end', paddingBottom: 10, overflow: 'hidden' },
  headerRow: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  back: { fontSize: 17, color: colors.accent },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  toggleText: { fontSize: 13, color: colors.muted },
  headerTitle: { fontSize: 32, fontWeight: '800', color: colors.ink, transformOrigin: 'left' },
  headerSub: { fontSize: 13, color: colors.muted, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 16, borderRadius: 14, backgroundColor: colors.card },
  rowTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  rowBody: { fontSize: 13, color: colors.muted },
  heart: { fontSize: 24, color: colors.faint },
})
