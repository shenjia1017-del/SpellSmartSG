import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../../lib/supabase';
import { getCollection } from '../lib/gardenHelpers';
import { CREATURES } from '../constants/gardenData';

export default function AlbumScreen() {
  const [flowers, setFlowers] = useState([]);
  const [creatures, setCreatures] = useState([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  useEffect(() => { loadCollection(); }, []);

  async function loadCollection() {
    const { data: { user } } = await supabase.auth.getUser();
    const { flowers, creatures } = await getCollection(user.id);
    setFlowers(flowers);
    setCreatures(creatures);
    setLoading(false);
  }

  const unlockedEmojis = new Set(creatures.map(c => c.creature_emoji));

  if (loading) return <ActivityIndicator style={{ flex: 1, marginTop: 60 }} />;

  const flowerCollection = flowers.map((f) => ({
    emoji: f.flower_emoji,
    name: f.flower_name,
    count: Number(f.count ?? 1),
  }));
  const creatureCollection = creatures.map((c) => ({
    category: String(c.category ?? '').toLowerCase(),
    index: Number(c.index ?? -1),
    emoji: c.creature_emoji ?? c.emoji ?? '',
  }));

  return (
    <View style={styles.container}>
      <View style={[styles.pageHeader, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.pageTitle}>My Album</Text>
        <Text style={styles.pageSubtitle}>Keep learning to unlock more! 🌟</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>

        <Text style={styles.sectionTitle}>FLOWERS COLLECTED 🌸</Text>
        <View style={styles.flowersGrid}>
          {flowerCollection && flowerCollection.length > 0 ? (
            flowerCollection.map((flower, index) => (
              <View key={index} style={styles.flowerItem}>
                <View style={styles.flowerBadgeWrap}>
                  <View style={styles.flowerBox}>
                    <Text style={styles.flowerEmoji}>{flower.emoji || '🌸'}</Text>
                  </View>
                  {flower.count > 1 && (
                    <View style={styles.flowerCount}>
                      <Text style={styles.flowerCountText}>×{flower.count}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.flowerName}>{flower.name || 'Flower'}</Text>
              </View>
            ))
          ) : (
            <View style={styles.emptyFlowers}>
              <Text style={styles.emptyFlowersText}>🌱 Complete your first dictation to earn a flower!</Text>
            </View>
          )}
          {[...Array(Math.max(0, 4 - (flowerCollection?.length || 0)))].map((_, i) => (
            <View key={`empty-${i}`} style={styles.flowerItem}>
              <View style={[styles.flowerBox, styles.flowerBoxLocked]}>
                <Text style={styles.flowerEmoji}>❓</Text>
              </View>
              <Text style={styles.flowerNameLocked}>???</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>CREATURES 🦋</Text>
        {(!creatureCollection || creatureCollection.length === 0) && (
          <View style={styles.creaturesHint}>
            <Text style={styles.creaturesHintText}>Complete a full week to unlock your first creature!</Text>
          </View>
        )}

        <Text style={styles.subSectionTitle}>Insects</Text>
        <View style={styles.creaturesGrid}>
          {[...Array(10)].map((_, i) => {
            const creature = creatureCollection?.find(c => c.category === 'insect' && c.index === i);
            return (
              <View key={i} style={[styles.creatureBox, creature && styles.creatureBoxUnlocked]}>
                <Text style={styles.creatureEmoji}>{creature ? creature.emoji : '?'}</Text>
              </View>
            );
          })}
        </View>

        <Text style={styles.subSectionTitle}>Birds</Text>
        <View style={styles.creaturesGrid}>
          {[...Array(10)].map((_, i) => {
            const creature = creatureCollection?.find(c => c.category === 'bird' && c.index === i);
            return (
              <View key={i} style={[styles.creatureBox, creature && styles.creatureBoxUnlocked]}>
                <Text style={styles.creatureEmoji}>{creature ? creature.emoji : '?'}</Text>
              </View>
            );
          })}
        </View>

        <Text style={styles.subSectionTitle}>Animals</Text>
        <View style={styles.creaturesGrid}>
          {[...Array(10)].map((_, i) => {
            const creature = creatureCollection?.find(c => c.category === 'animal' && c.index === i);
            return (
              <View key={i} style={[styles.creatureBox, creature && styles.creatureBoxUnlocked]}>
                <Text style={styles.creatureEmoji}>{creature ? creature.emoji : '?'}</Text>
              </View>
            );
          })}
        </View>

      </ScrollView>

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/')}>
          <Text style={styles.tabIcon}>🏠</Text>
          <Text style={styles.tabLabel}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem}>
          <Text style={styles.tabIcon}>🏅</Text>
          <Text style={[styles.tabLabel, styles.tabLabelActive]}>Album</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/history')}>
          <Text style={styles.tabIcon}>📊</Text>
          <Text style={styles.tabLabel}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/settings')}>
          <Text style={styles.tabIcon}>⚙️</Text>
          <Text style={styles.tabLabel}>Settings</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF8F0' },
  pageHeader: { backgroundColor: '#FFF8F0', paddingHorizontal: 16, paddingTop: 0, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#F0E8DC' },
  pageTitle: { fontSize: 20, fontWeight: '900', color: '#1A1A1A' },
  pageSubtitle: { fontSize: 11, color: '#F97316', fontWeight: '600', marginTop: 3 },
  scroll: { flex: 1 },
  scrollContent: { padding: 14, paddingBottom: 30 },
  sectionTitle: { fontSize: 9, fontWeight: '700', color: '#bbb', letterSpacing: 1, marginBottom: 10, marginTop: 10 },
  subSectionTitle: { fontSize: 10, fontWeight: '700', color: '#ccc', marginBottom: 6, marginTop: 10 },
  flowersGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 8 },
  flowerItem: { alignItems: 'center', width: 60 },
  flowerBadgeWrap: { position: 'relative' },
  flowerBox: { width: 52, height: 52, backgroundColor: '#FFF3E0', borderRadius: 14, borderWidth: 1.5, borderColor: '#F97316', alignItems: 'center', justifyContent: 'center' },
  flowerBoxLocked: { backgroundColor: '#F5F0EA', borderColor: '#E0D8CC', opacity: 0.35 },
  flowerEmoji: { fontSize: 28 },
  flowerCount: { position: 'absolute', top: -6, right: -6, backgroundColor: '#F97316', borderRadius: 10, paddingHorizontal: 5, paddingVertical: 1 },
  flowerCountText: { fontSize: 8, fontWeight: '800', color: 'white' },
  flowerName: { fontSize: 8, color: '#E65100', fontWeight: '600', marginTop: 4, textAlign: 'center' },
  flowerNameLocked: { fontSize: 8, color: '#ccc', marginTop: 4 },
  emptyFlowers: { backgroundColor: '#FFF8F0', borderRadius: 12, padding: 14, width: '100%', marginBottom: 6 },
  emptyFlowersText: { fontSize: 12, color: '#F97316', fontWeight: '600', textAlign: 'center' },
  creaturesHint: { backgroundColor: '#FFF8F0', borderRadius: 12, padding: 12, marginBottom: 8 },
  creaturesHintText: { fontSize: 11, color: '#F97316', fontWeight: '600', textAlign: 'center' },
  creaturesGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  creatureBox: { width: 44, height: 44, backgroundColor: '#F5F0EA', borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  creatureBoxUnlocked: { backgroundColor: '#FFF3E0', borderWidth: 1.5, borderColor: '#F97316' },
  creatureEmoji: { fontSize: 10, color: '#ccc', fontWeight: '700' },
  tabBar: { flexDirection: 'row', backgroundColor: 'white', borderTopWidth: 0.5, borderTopColor: '#F0EAE0', paddingBottom: 20, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20, marginBottom: 2 },
  tabLabel: { fontSize: 9, color: '#B0BEC5', fontWeight: '600' },
  tabLabelActive: { color: '#F97316' },
});
