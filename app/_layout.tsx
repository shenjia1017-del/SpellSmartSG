import { Stack } from 'expo-router';
import React from 'react';
import { ChildProvider } from './lib/childContext';

export default function RootLayout() {
  return (
    <ChildProvider>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen name="review" options={{ headerShown: true, title: 'Review' }} />
      </Stack>
    </ChildProvider>
  );
}
