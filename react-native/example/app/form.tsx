import { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withSpring, withTiming } from 'react-native-reanimated'
import { useReplayKey } from '../components/replay'
import { Button, colors, Note } from '../components/ui'

const isEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)

export default function Form() {
  const run = useReplayKey()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [done, setDone] = useState(false)
  const shake = useSharedValue(0)
  const check = useSharedValue(0)
  const fieldStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }))
  const checkStyle = useAnimatedStyle(() => ({ opacity: check.value, transform: [{ scale: 0.5 + check.value * 0.5 }] }))

  const submit = () => {
    if (!isEmail(email)) {
      console.warn(`Sign up: "${email}" is not an email address`)
      shake.set(withSequence(withTiming(-10, { duration: 50 }), withRepeat(withTiming(10, { duration: 90 }), 4, true), withTiming(0, { duration: 50 })))
      return
    }
    setDone(true)
    check.set(withSpring(1, { damping: 10, stiffness: 160, mass: 4 }))
  }

  return (
    <KeyboardAvoidingView key={run} style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Note>Type a bad email and submit: the field shakes and a warning goes to the log. The keyboard showing and hiding is recorded too.</Note>
        <TextInput testID="form-name" style={styles.input} placeholder="Name" value={name} onChangeText={setName} />
        <Animated.View style={fieldStyle}>
          <TextInput testID="form-email" style={styles.input} placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        </Animated.View>
        <Button testID="form-submit" title="Create account" tone="primary" onPress={submit} />
        {done && (
          <Animated.View style={[styles.done, checkStyle]}>
            <Text style={styles.doneMark}>✓</Text>
            <Text style={styles.doneText}>Welcome, {name || 'friend'}</Text>
          </Animated.View>
        )}
        <View style={{ height: 200 }} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 14 },
  input: { padding: 14, borderRadius: 12, backgroundColor: colors.card, fontSize: 16, borderWidth: 1, borderColor: colors.line },
  done: { alignItems: 'center', gap: 6, padding: 20 },
  doneMark: { fontSize: 44, color: colors.green },
  doneText: { fontSize: 16, fontWeight: '600', color: colors.ink },
})
