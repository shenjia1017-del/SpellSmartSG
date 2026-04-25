import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useEffect } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChild } from './lib/childContext';

function avatarForGender(gender) {
  return gender === 'girl'
    ? { emoji: '👧', bg: '#FCE7F3' }
    : { emoji: '👦', bg: '#DBEAFE' };
}

export default function SelectChildScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { children, setCurrentChild, loading } = useChild();

  useEffect(() => {
    if (!loading && children.length === 0) {
      router.replace('/settings/children');
    }
  }, [children.length, loading, router]);

  return (
    <LinearGradient
      colors={['#E3F2FD', '#F1F8FF', '#FFF8F0']}
      style={[styles.container, { paddingTop: insets.top + 12 }]}
    >
      <View style={styles.bgDecor} pointerEvents="none">
        <View style={[styles.cloud, { top: 38, left: 18, width: 80, height: 36 }]} />
        <View style={[styles.cloud, { top: 28, left: 55, width: 60, height: 28 }]} />
        <View style={[styles.cloud, { top: 52, right: 30, width: 70, height: 30 }]} />
        <View style={styles.sun} />
        <View style={styles.ground} />
      </View>

      <Text style={styles.title}>Who&apos;s learning today?</Text>

      <ScrollView contentContainerStyle={styles.grid}>
        {children.map((child) => {
          const avatar = avatarForGender(child.gender);
          return (
            <TouchableOpacity
              key={child.id}
              style={styles.card}
              onPress={async () => {
                await setCurrentChild(child);
                router.replace('/');
              }}
            >
              <View style={[styles.avatar, { backgroundColor: avatar.bg }]}>
                <Text style={styles.avatarEmoji}>{avatar.emoji}</Text>
              </View>
              <Text style={styles.name}>{child.name}</Text>
              <Text style={styles.weekHint}>Week —</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      <TouchableOpacity style={styles.manageLink} onPress={() => router.push('/settings/children')}>
        <Text style={styles.manageLinkText}>⚙️ Manage children</Text>
      </TouchableOpacity>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 0, paddingHorizontal: 18 },
  bgDecor: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  cloud: { position: 'absolute', backgroundColor: 'white', borderRadius: 99, opacity: 0.85 },
  sun: { position: 'absolute', top: 32, right: 24, width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFD740', opacity: 0.8 },
  ground: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 48, backgroundColor: '#A5D6A7', opacity: 0.4 },
  title: { textAlign: 'center', fontSize: 28, fontWeight: '800', color: '#1A1A1A', marginBottom: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, paddingBottom: 24 },
  card: {
    width: '48%',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#F0E8DC',
    alignItems: 'center',
    paddingVertical: 18,
  },
  avatar: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  avatarEmoji: { fontSize: 34 },
  name: { fontSize: 16, fontWeight: '700', color: '#222' },
  weekHint: { fontSize: 11, color: '#999', marginTop: 4 },
  manageLink: { alignSelf: 'center', marginBottom: 28, marginTop: 'auto' },
  manageLinkText: { color: '#666', fontSize: 14, fontWeight: '600' },
});
