import { Link, type Href } from 'expo-router'
import { useEffect } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated'
import { useReplayKey } from '../components/replay'
import { colors, Note } from '../components/ui'

const FLOWS: { href: Href; title: string; body: string; color: string }[] = [
  { href: '/welcome', title: 'Welcome', body: 'Entrance springs, a badge sequence, a repeating shimmer and a card to drag.', color: colors.orange },
  { href: '/feed', title: 'Feed', body: 'A header that collapses as you scroll, rows that fade in, a like button that pops.', color: colors.accent },
  { href: '/sheet', title: 'Bottom sheet', body: 'A pan gesture with snap points, driven on the UI thread.', color: '#0f8f8a' },
  { href: '/form', title: 'Sign up', body: 'The keyboard, a shake on a bad email and a warning in the log.', color: '#c98a00' },
  { href: '/hold', title: 'Long press', body: 'Photo tiles that lift on a long press, and a hold-to-delete button that fills while held.', color: '#2a9d8f' },
  { href: '/props', title: 'From props', body: 'A CSS pulse, a CSS transition, chips that zoom in and fade out, and a list with a plain JS onScroll.', color: '#3a86ff' },
  { href: '/carousel', title: 'Carousel', body: 'Paging cards that scale and fade with the scroll position.', color: '#c2417b' },
  { href: '/glitches', title: 'Glitch lab', body: 'Drops frames on purpose: a blocked JS thread, a render storm, a busy UI thread, errors.', color: colors.red },
]

function FlowCard({ index, flow }: { index: number; flow: (typeof FLOWS)[number] }) {
  const enter = useSharedValue(0)
  const press = useSharedValue(1)
  useEffect(() => {
    enter.value = withDelay(index * 70, withTiming(1, { duration: 360 }))
  }, [enter, index])
  const style = useAnimatedStyle(() => ({
    opacity: enter.value,
    transform: [{ translateY: (1 - enter.value) * 24 }, { scale: press.value }],
  }))
  return (
    <Link href={flow.href} asChild>
      <Pressable onPressIn={() => press.set(withSpring(0.97))} onPressOut={() => press.set(withSpring(1))}>
        <Animated.View style={[styles.card, style]}>
          <View style={[styles.dot, { backgroundColor: flow.color }]} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.title}>{flow.title}</Text>
            <Text style={styles.body}>{flow.body}</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Animated.View>
      </Pressable>
    </Link>
  )
}

export default function Home() {
  const run = useReplayKey()
  return (
    <ScrollView key={run} contentContainerStyle={styles.list}>
      <Note>
        Each flow exercises something the inspector should catch. Tap REC (bottom left) before you start to record a session; it is saved in
        .keyframer/recordings.
      </Note>
      {FLOWS.map((f, i) => (
        <FlowCard key={f.title} index={i} flow={f} />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  list: { padding: 16, gap: 12 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 16, backgroundColor: colors.card },
  dot: { width: 14, height: 14, borderRadius: 7 },
  title: { fontSize: 16, fontWeight: '700', color: colors.ink },
  body: { fontSize: 13, lineHeight: 18, color: colors.muted },
  chevron: { fontSize: 24, color: colors.faint },
})
