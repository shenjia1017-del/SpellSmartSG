import { Stack } from 'expo-router';
import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ChildProvider } from './lib/childContext';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ChildProvider>
        <Stack
          screenOptions={{
            headerShown: false,
          }}
        >
          <Stack.Screen name="review" options={{ headerShown: true, title: 'Review' }} />
        </Stack>
      </ChildProvider>
    </SafeAreaProvider>
  );
}
