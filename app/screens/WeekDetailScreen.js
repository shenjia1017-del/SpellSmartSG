import { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { useChild } from '../lib/childContext';

export default function WeekDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const weekLabel = params.week;
  const { currentChild } = useChild();
  const [loading, setLoading] = useState(true);
  const [words, setWords] = useState([]);
  const [passage, setPassage] = useState('');

  useEffect(() => {
    loadData();
  }, [weekLabel, currentChild?.id]);

  const loadData = async () => {
    if (!weekLabel || !currentChild?.id) return;
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: wordData, error: wordError } = await supabase
        .from('words')
        .select('id, word, created_at')
        .eq('user_id', user.id)
        .eq('child_id', currentChild.id)
        .eq('week_label', weekLabel)
        .order('created_at', { ascending: true });

      if (wordError) throw wordError;
      setWords(wordData || []);

      const { data: passageData, error: passageError } = await supabase
        .from('passages')
        .select('body')
        .eq('user_id', user.id)
        .eq('child_id', currentChild.id)
        .eq('week_label', weekLabel)
        .order('created_at', { ascending: false })
        .limit(1);

      if (passageError) throw passageError;
      setPassage(passageData?.[0]?.body || '');
    } catch (e) {
      Alert.alert('Error', e?.message || 'Failed to load week data');
    } finally {
      setLoading(false);
    }
  };

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <TouchableOpacity onPress={handleBack} style={styles.backBtn}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>

      <Text style={styles.title}>{weekLabel}</Text>
      <Text style={styles.subtitle}>
        {words.length} word{words.length !== 1 ? 's' : ''}
        {passage ? ' · 1 passage' : ''}
      </Text>

      {loading ? (
        <ActivityIndicator color="#F97316" style={{ marginTop: 40 }} />
      ) : (
        <>
          <Text style={styles.sectionTitle}>Spelling words & phrases</Text>
          {words.length === 0 ? (
            <Text style={styles.emptyText}>No words in this week.</Text>
          ) : (
            words.map((w) => (
              <View key={w.id} style={styles.wordCard}>
                <Text style={styles.wordText}>{w.word}</Text>
              </View>
            ))
          )}

          {passage ? (
            <>
              <Text style={styles.sectionTitle}>Dictation passage</Text>
              <View style={styles.passageCard}>
                <Text style={styles.passageText}>{passage}</Text>
              </View>
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF8F0' },
  content: { padding: 20, paddingBottom: 60 },
  backBtn: { marginBottom: 16 },
  backText: { fontSize: 16, color: '#F97316', fontWeight: '600' },
  title: { fontSize: 28, fontWeight: '700', color: '#1F2937', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6B7280', marginBottom: 24 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1F2937',
    marginTop: 20,
    marginBottom: 12,
  },
  wordCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#F3E8D8',
  },
  wordText: { fontSize: 16, color: '#1F2937' },
  passageCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#F3E8D8',
  },
  passageText: { fontSize: 15, color: '#1F2937', lineHeight: 24 },
  emptyText: { fontSize: 14, color: '#9CA3AF', fontStyle: 'italic' },
});
