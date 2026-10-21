import { NavigationContainer } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { navigationRef, type RootStackParamList } from './navigation/RootNavigation'
import { Home } from './screens/Home'
import { Profile } from './screens/Profile'

const Stack = createNativeStackNavigator<RootStackParamList>()

export default function App() {
  // Analytics reads the route from the same ref.
  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator>
        <Stack.Screen name="Home" component={Home} />
        <Stack.Screen name="Profile" component={Profile} />
      </Stack.Navigator>
    </NavigationContainer>
  )
}
