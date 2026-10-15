import { useIsFocused } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated'
import { scheduleOnUI } from 'react-native-worklets'
import { useReplayKey } from '../components/replay'
import { Button, colors, Note } from '../components/ui'

/** Holds the JS thread for `ms`. */
function blockJs(ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {}
}

/** A spinner driven on the UI thread: it keeps turning while JS is blocked. */
function UiSpinner() {
  const turn = useSharedValue(0)
  // Only while this screen is on top: a pushed screen stays mounted under the next one, and a loop
  // there would show up in every other screen's measurements.
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    turn.value = withRepeat(withTiming(1, { duration: 1200, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(turn)
  }, [turn, focused])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.value * 360}deg` }] }))
  return <Animated.View style={[styles.spinner, style]} />
}

/** A bar moved with setState every frame: it freezes whenever JS is busy. */
function JsBar() {
  const [x, setX] = useState(0)
  // Re-renders every frame on purpose, so only while this screen is on top (see UiSpinner).
  const focused = useIsFocused()
  useEffect(() => {
    if (!focused) return
    let raf = 0
    const start = Date.now()
    const tick = () => {
      setX(((Date.now() - start) / 1500) % 1)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [focused])
  return (
    <View style={styles.track}>
      <View style={[styles.bar, { left: `${x * 80}%` }]} />
    </View>
  )
}

/** Many views re-rendered at once: a slow React commit. */
function Storm({ tick }: { tick: number }) {
  return (
    <View style={styles.storm}>
      {Array.from({ length: 400 }, (_, i) => (
        <View key={i} style={[styles.cell, { opacity: ((i + tick) % 10) / 10 + 0.1 }]} />
      ))}
    </View>
  )
}

export default function Glitches() {
  const run = useReplayKey()
  const [storm, setStorm] = useState(0)
  const storming = useRef(false)
  const pulse = useSharedValue(1)
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }] }))

  const renderStorm = () => {
    if (storming.current) return
    storming.current = true
    let n = 0
    const step = () => {
      setStorm((s) => s + 1)
      if (++n < 40) requestAnimationFrame(step)
      else storming.current = false
    }
    requestAnimationFrame(step)
  }

  return (
    <ScrollView key={run} contentContainerStyle={styles.container}>
      <Note>Record, then press these. Each one drops frames a different way, and the trace should say which.</Note>
      <View style={styles.live}>
        <UiSpinner />
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={styles.label}>UI thread spinner and a JS-driven bar</Text>
          <JsBar />
        </View>
      </View>

      <Text style={styles.section}>JS thread</Text>
      <Button testID="glitch-block-js" title="Block the JS thread for 300 ms" onPress={() => blockJs(300)} />
      <Button
        testID="glitch-anim-then-block"
        title="Start an animation, then block JS"
        onPress={() => {
          pulse.set(withTiming(pulse.get() > 1 ? 1 : 1.25, { duration: 400 }))
          blockJs(200)
        }}
      />
      <Button testID="glitch-storm" title="Render storm (40 slow renders)" onPress={renderStorm} />
      <Animated.View style={[styles.pulse, pulseStyle]} />

      <Text style={styles.section}>UI thread</Text>
      <Button
        testID="glitch-block-ui"
        title="Block the UI thread for 150 ms"
        onPress={() =>
          scheduleOnUI(() => {
            'worklet'
            const end = Date.now() + 150
            while (Date.now() < end) {}
          })
        }
      />

      <Text style={styles.section}>Logs</Text>
      <Button testID="glitch-warn" title="Log a warning" onPress={() => console.warn('Glitch lab: the cache is stale, refetching')} />
      <Button testID="glitch-error" tone="danger" title="Log an error with a stack" onPress={() => console.error(new Error('Glitch lab: could not load the profile'))} />

      {storm > 0 && <Storm tick={storm} />}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12, paddingBottom: 60 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 16, padding: 16, borderRadius: 16, backgroundColor: colors.card },
  spinner: { width: 36, height: 36, borderRadius: 10, borderWidth: 4, borderColor: colors.accent, borderTopColor: 'transparent' },
  label: { fontSize: 12, color: colors.muted },
  track: { height: 10, borderRadius: 5, backgroundColor: colors.line, overflow: 'hidden' },
  bar: { position: 'absolute', top: 0, bottom: 0, width: '20%', borderRadius: 5, backgroundColor: colors.orange },
  section: { marginTop: 12, fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', color: colors.faint },
  pulse: { alignSelf: 'center', width: 40, height: 40, borderRadius: 20, backgroundColor: colors.accent, marginVertical: 6 },
  storm: { flexDirection: 'row', flexWrap: 'wrap', gap: 2, marginTop: 12 },
  cell: { width: 14, height: 14, borderRadius: 3, backgroundColor: colors.accent },
})
