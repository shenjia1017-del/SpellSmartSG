import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator
} from 'react-native';
import { supabase } from '../../lib/supabase';
import { getCollection } from '../lib/gardenHelpers';
import { CREATURES } from '../constants/gardenData';

const CATEGORIES = ['Insects', 'Birds', 'Animals', 'Ocean', 'Magic'];

export default function AlbumScreen() {
  const [flowers, setFlowers] = useState([]);
  const [creatures, setCreatures] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadCollection(); }, []);

  async function loadCollection() {
    const { data: { user } } = await supabase.auth.getUser();
    const { flowers, creatures } = await getCollection(user.id);
    setFlowers(flowers);
    setCreatures(creatures);
    setLoading(false);
  }

  const unlockedEmojis = new Set(creatures.map(c => c.creature_emoji));
  const progressPct = Math.round((creatures.length / 50) * 100);

  if (loading) return <ActivityIndicator style={{ flex: 1, marginTop: 60 }} />;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      <Text style={styles.heading}>My album</Text>
      <Text style={styles.sub}>{creatures.length} / 50 creatures · {flowers.length} flowers</Text>

      <View style={styles.progressBar}>
        <View style={[styles.progressFill, { width: `${progressPct}%` }]} />
      </View>

      <Text style={styles.sectionTitle}>Flowers collected</Text>
      {flowers.length === 0 ? (
        <Text style={styles.emptyText}>Complete a week to earn your first flower 🌱</Text>
      ) : (
        <View style={styles.flowerRow}>
          {flowers.map((f, i) => (
            <View key={i} style={styles.flowerItem}>
              <Text style={styles.flowerEmoji}>{f.flower_emoji}</Text>
              <Text style={styles.flowerLabel}>{f.flower_name}</Text>
            </View>
          ))}
        </View>
      )}

      {CATEGORIES.map(cat => {
        const catCreatures = CREATURES.filter(c => c.category === cat);
        const unlockedCount = catCreatures.filter(c => unlockedEmojis.has(c.emoji)).length;
        return (
          <View key={cat}>
            <View style={styles.catHeader}>
              <Text style={styles.sectionTitle}>{cat}</Text>
              <Text style={styles.catCount}>{unlockedCount} / {catCreatures.length}</Text>
            </View>
            <View style={styles.creatureGrid}>
              {catCreatures.map((c, i) => {
                const unlocked = unlockedEmojis.has(c.emoji);
                return (
                  <View key={i} style={[styles.creatureCell, !unlocked && styles.locked]}>
                    <Text style={styles.creatureEmoji}>{unlocked ? c.emoji : '?'}</Text>
                    {unlocked && (
                      <Text style={styles.creatureName} numberOfLines={1}>{c.name}</Text>
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        );
      })}

      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20 },
  heading: { fontSize: 24, fontWeight: '700', color: '#1a1a1a' },
  sub: { fontSize: 13, color: '#888', marginBottom: 10 },
  progressBar: {
    height: 7,
    backgroundColor: '#f0f0f0',
    borderRadius: 99,
    marginBottom: 24,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#34c759',
    borderRadius: 99,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#555',
    marginBottom: 10,
    marginTop: 20,
  },
  emptyText: { fontSize: 13, color: '#bbb', marginBottom: 16 },
  flowerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  flowerItem: { alignItems: 'center' },
  flowerEmoji: { fontSize: 24 },
  flowerLabel: { fontSize: 8, color: '#aaa', marginTop: 2, textAlign: 'center' },
  catHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    marginBottom: 8,
  },
  catCount: { fontSize: 12, color: '#aaa' },
  creatureGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  creatureCell: {
    width: '17%',
    aspectRatio: 1,
    borderWidth: 0.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fafafa',
    padding: 4,
  },
  locked: { backgroundColor: '#f5f5f5' },
  creatureEmoji: { fontSize: 20 },
  creatureName: { fontSize: 8, color: '#888', marginTop: 2, textAlign: 'center' },
});
