import { Stack } from 'expo-router';
import React from 'react';

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
      }}
    >
      <Stack.Screen name="review" options={{ headerShown: true, title: 'Review' }} />
    </Stack>
  );
}
