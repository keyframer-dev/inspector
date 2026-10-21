import { NavigationContainer, NavigationIndependentTree } from '@react-navigation/native';
import { OnboardingStack } from './OnboardingStack';

export function Onboarding({ onDone }: { onDone: () => void }) {
  return (
    <NavigationIndependentTree>
      <NavigationContainer>
        <OnboardingStack onDone={onDone} />
      </NavigationContainer>
    </NavigationIndependentTree>
  );
}
