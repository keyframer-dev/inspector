import { Pressable, Text } from 'react-native';

export function OnboardingStack({ onDone }: { onDone: () => void }) {
  return (
    <Pressable onPress={onDone}>
      <Text>Start</Text>
    </Pressable>
  );
}
