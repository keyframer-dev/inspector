import { NavigationContainer } from '@react-navigation/native';
import { useState } from 'react';
import { MainStack } from './MainStack';
import { Onboarding } from './Onboarding';

export default function App() {
  const [onboarded, setOnboarded] = useState(false);
  if (!onboarded) return <Onboarding onDone={() => setOnboarded(true)} />;
  return (
    <NavigationContainer>
      <MainStack />
    </NavigationContainer>
  );
}
