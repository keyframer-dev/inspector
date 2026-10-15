import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native'

export const colors = {
  bg: '#f6f5fb',
  card: '#ffffff',
  ink: '#16151e',
  muted: '#5b5a6e',
  faint: '#9a99ad',
  line: '#e6e4ef',
  accent: '#6d5dfc',
  orange: '#e8622c',
  red: '#d95040',
  green: '#1f9d55',
}

export function Button({
  title,
  onPress,
  tone = 'plain',
  style,
  testID,
}: {
  title: string
  onPress: () => void
  tone?: 'plain' | 'primary' | 'danger'
  style?: StyleProp<ViewStyle>
  testID?: string
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [styles.button, tone === 'primary' && styles.primary, tone === 'danger' && styles.danger, pressed && { opacity: 0.7 }, style]}
    >
      <Text style={[styles.buttonText, tone !== 'plain' && { color: '#fff' }]}>{title}</Text>
    </Pressable>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <Text style={styles.note}>{children}</Text>
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12, backgroundColor: '#e4e8f0', alignItems: 'center' },
  primary: { backgroundColor: colors.accent },
  danger: { backgroundColor: colors.red },
  buttonText: { fontWeight: '600', color: colors.ink },
  note: { fontSize: 13, lineHeight: 18, color: colors.muted },
})
