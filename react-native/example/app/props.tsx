import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeOut, LinearTransition, ZoomIn } from 'react-native-reanimated'
import { onBus } from '../components/bus'
import { useReplayKey } from '../components/replay'
import { Button, colors, Note } from '../components/ui'

const pulse = {
  from: { transform: [{ scale: 1 }], opacity: 1 },
  to: { transform: [{ scale: 1.6 }], opacity: 0 },
}

let nextChip = 4

/** Animations that come from props, with no withTiming call: CSS animations and transitions, entering / exiting / layout, and a list scrolled by a plain JS onScroll. */
export default function Props() {
  const run = useReplayKey()
  const [wide, setWide] = useState(false)
  const [chips, setChips] = useState([1, 2, 3])
  const [scrolled, setScrolled] = useState(false)
  const list = useRef<ScrollView>(null)
  useEffect(() => onBus('props:scroll', (y) => list.current?.scrollTo({ y: Number(y), animated: true })), [])
  return (
    <View key={run} style={styles.container}>
      <Note>A live dot pulses with a CSS animation, the button grows with a CSS transition, chips zoom in and fade out, and the list below uses a plain JS onScroll.</Note>
      <View style={styles.row}>
        <View style={styles.live}>
          <Animated.View style={[styles.ring, { animationName: pulse, animationDuration: '1.2s', animationIterationCount: 'infinite' }]} />
          <View style={styles.dot} />
        </View>
        <Text style={styles.label}>Live</Text>
      </View>
      <Animated.View
        style={[styles.bar, { width: wide ? '100%' : '45%', backgroundColor: wide ? colors.green : colors.accent, transitionProperty: ['width', 'backgroundColor'], transitionDuration: 350 }]}
      />
      <View style={styles.row}>
        <Button testID="props-toggle" title={wide ? 'Shrink' : 'Grow'} onPress={() => setWide((w) => !w)} />
        <Button testID="props-add" title="Add chip" onPress={() => setChips((c) => [...c, nextChip++])} />
        <Button testID="props-remove" title="Remove first" onPress={() => setChips((c) => c.slice(1))} />
      </View>
      <View style={styles.chips}>
        {chips.map((n) => (
          <Animated.View key={n} entering={ZoomIn.duration(260)} exiting={FadeOut.duration(200)} layout={LinearTransition} style={styles.chip}>
            <Text style={styles.chipText}>Chip {n}</Text>
          </Animated.View>
        ))}
      </View>
      <View style={[styles.listHeader, scrolled && styles.listHeaderScrolled]}>
        <Text style={styles.label}>{scrolled ? 'Scrolled' : 'At the top'}</Text>
      </View>
      <ScrollView ref={list} testID="props-list" style={styles.list} onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 8)} scrollEventThrottle={16}>
        {Array.from({ length: 30 }, (_, i) => (
          <Text key={i} style={styles.item}>
            Item {i + 1}
          </Text>
        ))}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  live: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 24, height: 24, borderRadius: 12, backgroundColor: colors.red },
  dot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.red },
  label: { fontWeight: '600', color: colors.ink },
  bar: { height: 14, borderRadius: 7 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, minHeight: 36 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  chipText: { color: colors.ink },
  listHeader: { paddingVertical: 8, borderBottomWidth: 1, borderColor: 'transparent' },
  listHeaderScrolled: { borderColor: colors.line },
  list: { flex: 1, backgroundColor: colors.card, borderRadius: 16 },
  item: { paddingHorizontal: 16, paddingVertical: 14, color: colors.ink, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
})
