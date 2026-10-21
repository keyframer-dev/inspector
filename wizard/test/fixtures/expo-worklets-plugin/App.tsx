import Animated, { FadeIn } from 'react-native-reanimated';
import { Text } from 'react-native';

export default function App() {
  return (
    <Animated.View entering={FadeIn} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <Text>Hello</Text>
    </Animated.View>
  );
}
