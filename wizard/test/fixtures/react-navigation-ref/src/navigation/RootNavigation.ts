import { createNavigationContainerRef } from '@react-navigation/native'

export type RootStackParamList = { Home: undefined; Profile: { id: string } }

export const navigationRef = createNavigationContainerRef<RootStackParamList>()

export function navigate(name: keyof RootStackParamList) {
  if (navigationRef.isReady()) navigationRef.navigate(name as never)
}
