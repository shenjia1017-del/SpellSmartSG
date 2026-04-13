import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, TouchableOpacity
} from 'react-native';
import { supabase } from '../../lib/supabase';
import { getWeekMastery } from '../lib/gardenHelpers';

const STATUS_EMOJI = {
  soil: '⬜',
  sprout: '🌱',
  bloom: '🌸',
  wilt: '🥀',
};

export default function GardenScreen({ weekLabel }) {
  const [words, setWords] = useState([]);
  const [mastery, setMastery] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (weekLabel) loadData();
  }, [weekLabel]);

  async function loadData() {
    setLoading(true);
    const { data: { user } } = await supabase.auth.getUser();

    const { data: wordData } = await supabase
      .from('words')
      .select('id, word')
      .eq('user_id', user.id)
      .eq('week_label', weekLabel);

    const masteryData = await getWeekMastery(user.id, weekLabel);
    const masteryMap = {};
    masteryData.forEach(m => { masteryMap[m.word_id] = m.status; });

    setWords(wordData || []);
    setMastery(masteryMap);
    setLoading(false);
  }

  const bloomCount = Object.values(mastery).filter(s => s === 'bloom').length;
  const total = words.length;
  const allBlooming = total > 0 && bloomCount === total;

  if (loading) return <ActivityIndicator style={{ flex: 1, marginTop: 60 }} />;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{weekLabel}</Text>
      <Text style={styles.subtitle}>{bloomCount} / {total} blooming</Text>

      <View style={styles.progressBar}>
        <View style={[
          styles.progressFill,
          { width: total ? `${(bloomCount / total) * 100}%` : '0%' }
        ]} />
      </View>

      <View style={styles.grid}>
        {words.map(w => {
          const status = mastery[w.id] || 'soil';
          return (
            <View key={w.id} style={[styles.cell, status === 'wilt' && styles.cellWilt]}>
              <Text style={styles.cellEmoji}>{STATUS_EMOJI[status]}</Text>
              <Text style={styles.cellWord} numberOfLines={1}>{w.word}</Text>
            </View>
          );
        })}
      </View>

      {allBlooming && (
        <View style={styles.readyBanner}>
          <Text style={styles.readyText}>🎉 Ready for school test!</Text>
        </View>
      )}

      {!allBlooming && total > 0 && (
        <View style={styles.hintBox}>
          <Text style={styles.hintText}>
            Complete your dictation practice to make flowers bloom 🌸
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 40 },
  title: { fontSize: 22, fontWeight: '700', color: '#1a1a1a', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#888', marginBottom: 10 },
  progressBar: {
    height: 8,
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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  cell: {
    width: '18%',
    aspectRatio: 1,
    borderWidth: 0.5,
    borderColor: '#e0e0e0',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 4,
    backgroundColor: '#fafafa',
  },
  cellWilt: { opacity: 0.5 },
  cellEmoji: { fontSize: 22 },
  cellWord: { fontSize: 9, color: '#888', marginTop: 2, textAlign: 'center' },
  readyBanner: {
    marginTop: 28,
    backgroundColor: '#f0fff4',
    borderRadius: 14,
    padding: 18,
    alignItems: 'center',
  },
  readyText: { fontSize: 17, fontWeight: '600', color: '#34c759' },
  hintBox: {
    marginTop: 28,
    backgroundColor: '#fafafa',
    borderRadius: 14,
    padding: 16,
    alignItems: 'center',
  },
  hintText: { fontSize: 13, color: '#aaa', textAlign: 'center', lineHeight: 20 },
});
