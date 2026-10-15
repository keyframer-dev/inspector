import { useEffect, useRef } from 'react'
import { StyleSheet, Text, useWindowDimensions, View, type ScrollView } from 'react-native'
import Animated, { Extrapolation, interpolate, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, type SharedValue } from 'react-native-reanimated'
import { onBus } from '../components/bus'
import { useReplayKey } from '../components/replay'
import { colors, Note } from '../components/ui'

const CARDS = [
  { title: 'Morning', color: '#f4a261' },
  { title: 'Noon', color: '#e76f51' },
  { title: 'Dusk', color: '#9d4edd' },
  { title: 'Night', color: '#264653' },
  { title: 'Dawn', color: '#2a9d8f' },
]

function Card({ index, scrollX, width, title, color }: { index: number; scrollX: SharedValue<number>; width: number; title: string; color: string }) {
  const style = useAnimatedStyle(() => {
    const range = [(index - 1) * width, index * width, (index + 1) * width]
    return {
      opacity: interpolate(scrollX.value, range, [0.5, 1, 0.5], Extrapolation.CLAMP),
      transform: [{ scale: interpolate(scrollX.value, range, [0.85, 1, 0.85], Extrapolation.CLAMP) }],
    }
  })
  return (
    <View style={{ width, alignItems: 'center' }}>
      <Animated.View style={[styles.card, { backgroundColor: color, width: width - 64 }, style]}>
        <Text style={styles.cardTitle}>{title}</Text>
      </Animated.View>
    </View>
  )
}

function Dot({ index, scrollX, width }: { index: number; scrollX: SharedValue<number>; width: number }) {
  const style = useAnimatedStyle(() => {
    const range = [(index - 1) * width, index * width, (index + 1) * width]
    return {
      width: interpolate(scrollX.value, range, [8, 22, 8], Extrapolation.CLAMP),
      opacity: interpolate(scrollX.value, range, [0.35, 1, 0.35], Extrapolation.CLAMP),
    }
  })
  return <Animated.View style={[styles.dot, style]} />
}

export default function Carousel() {
  const run = useReplayKey()
  const { width } = useWindowDimensions()
  const scrollX = useSharedValue(0)
  const onScroll = useAnimatedScrollHandler((e) => {
    scrollX.value = e.contentOffset.x
  })
  // Scenarios page through it (components/scenarios.ts).
  const list = useRef<ScrollView>(null)
  useEffect(() => onBus('carousel:page', (page) => list.current?.scrollTo({ x: Number(page) * width, animated: true })), [width])
  return (
    <View key={run} style={styles.container}>
      <View style={styles.note}>
        <Note>Swipe through the cards: each one scales and fades with the scroll position, all from one shared value.</Note>
      </View>
      <Animated.ScrollView ref={list} testID="carousel" horizontal pagingEnabled showsHorizontalScrollIndicator={false} onScroll={onScroll} scrollEventThrottle={16} style={{ flexGrow: 0 }}>
        {CARDS.map((c, i) => (
          <Card key={c.title} index={i} scrollX={scrollX} width={width} title={c.title} color={c.color} />
        ))}
      </Animated.ScrollView>
      <View style={styles.dots}>
        {CARDS.map((c, i) => (
          <Dot key={c.title} index={i} scrollX={scrollX} width={width} />
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 20, gap: 24 },
  note: { paddingHorizontal: 20 },
  card: { height: 340, borderRadius: 24, justifyContent: 'flex-end', padding: 24 },
  cardTitle: { fontSize: 28, fontWeight: '800', color: '#fff' },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 6 },
  dot: { height: 8, borderRadius: 4, backgroundColor: colors.ink },
})
