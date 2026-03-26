import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React from 'react';

import HomeScreen from './screens/HomeScreen';
import ImportScreen from './screens/ImportScreen';
import LearnScreen from './screens/LearnScreen';
import LoginScreen from './screens/LoginScreen';
import RegisterScreen from './screens/RegisterScreen';

const Stack = createNativeStackNavigator();

export default function RootLayout() {
  return (
    <Stack.Navigator initialRouteName="Login">
      <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      <Stack.Screen name="Register" component={RegisterScreen} options={{ title: 'Register' }} />
      <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Stack.Screen name="Import" component={ImportScreen} options={{ title: 'Import Words' }} />
      <Stack.Screen name="Learn" component={LearnScreen} options={{ title: 'Learn' }} />
    </Stack.Navigator>
  );
}
