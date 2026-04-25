import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Settings</Text>
      <TouchableOpacity style={styles.card} onPress={() => router.push('/settings/children')}>
        <Text style={styles.cardTitle}>Children</Text>
        <Text style={styles.cardSub}>Manage child profiles</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF8F0', paddingTop: 0, paddingHorizontal: 16 },
  backBtn: { marginBottom: 16 },
  backText: { color: '#F97316', fontWeight: '700', fontSize: 16 },
  title: { fontSize: 24, fontWeight: '800', color: '#1A1A1A', marginBottom: 16 },
  card: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#F0E8DC',
    borderRadius: 14,
    padding: 14,
  },
  cardTitle: { fontSize: 16, fontWeight: '700', color: '#222' },
  cardSub: { fontSize: 12, color: '#999', marginTop: 4 },
});
