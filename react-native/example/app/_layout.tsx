import { isInstrumented, MotionScan } from '@keyframerdev/inspector/scan'
import { shareRecording } from '@keyframerdev/inspector/expo-share'
import { trackNavigation } from '@keyframerdev/inspector/record'
import { Stack, useNavigationContainerRef } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { setNavigation } from '../components/navigation'
import { createReplays, ReplayContext } from '../components/replay'
import { colors } from '../components/ui'
import { startInspector } from '../inspector'
import '../components/scenarios'

// Motion Scan's REC button records the session on the device: a copy lands in .keyframer/recordings
// (with Metro running) and the share sheet offers the file to send.
const recorder = { app: 'Inspector playground', share: shareRecording, shareOnlyWithoutMetro: true }

export default function Layout() {
  // The inspector's Replay re-mounts the screen on top (see components/replay.ts).
  const [replays] = useState(createReplays)
  useEffect(() => startInspector(replays.replay), [replays])
  // Screen changes become markers in a recording.
  const navigation = useNavigationContainerRef()
  useEffect(() => {
    // The scenarios read where the app is from it (components/navigation.ts).
    setNavigation(navigation)
    const off = trackNavigation(navigation)
    return () => {
      off()
      setNavigation(null)
    }
  }, [navigation])

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <MotionScan enabled={isInstrumented()} debug recorder={recorder} corner="bottom-left">
        <ReplayContext.Provider value={replays}>
          <Stack screenOptions={{ headerShadowVisible: false, headerStyle: { backgroundColor: colors.bg }, contentStyle: { backgroundColor: colors.bg } }}>
            <Stack.Screen name="index" options={{ title: 'Inspector playground' }} />
            <Stack.Screen name="welcome" options={{ title: 'Welcome' }} />
            <Stack.Screen name="feed" options={{ headerShown: false }} />
            <Stack.Screen name="sheet" options={{ title: 'Bottom sheet' }} />
            <Stack.Screen name="form" options={{ title: 'Sign up' }} />
            <Stack.Screen name="hold" options={{ title: 'Long press' }} />
            <Stack.Screen name="carousel" options={{ title: 'Carousel' }} />
            <Stack.Screen name="props" options={{ title: 'From props' }} />
            <Stack.Screen name="glitches" options={{ title: 'Glitch lab' }} />
            <Stack.Screen name="checks" options={{ title: 'Motion checks' }} />
          </Stack>
        </ReplayContext.Provider>
      </MotionScan>
      <StatusBar style="dark" />
    </GestureHandlerRootView>
  )
}
