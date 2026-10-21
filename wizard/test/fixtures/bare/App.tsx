import {SafeAreaView, StatusBar, Text, useColorScheme} from 'react-native';

function App(): React.JSX.Element {
  const isDarkMode = useColorScheme() === 'dark';
  return (
    <SafeAreaView style={{flex: 1}}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Text>Bare</Text>
    </SafeAreaView>
  );
}

export default App;
