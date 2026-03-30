import React, { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';

export default function HomeScreen({ navigation }) {
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [weekGroups, setWeekGroups] = useState([]);
  const [selectedWeek, setSelectedWeek] = useState('');

  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      (async () => {
        setLoading(true);
        setErrorMsg('');
        try {
          const { data: sessionData } = await supabase.auth.getSession();
          const userId = sessionData?.session?.user?.id;
          if (!userId) {
            if (!cancelled) {
              setWeekGroups([]);
              setSelectedWeek('');
              setErrorMsg('Please log in to view your weekly word lists.');
            }
            return;
          }

          let { data, error } = await supabase
            .from('words')
            .select('id, word, user_id, week_label, created_at, learn_card_json')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });

          if (error) {
            const retry = await supabase
              .from('words')
              .select('id, word, user_id, week_label, created_at, learn_card_json')
              .eq('user_id', userId)
              .order('id', { ascending: true });
            data = retry.data;
            error = retry.error;
          }
          if (error) throw error;

          const rows = Array.isArray(data) ? data : [];
          const grouped = new Map();
          for (const row of rows) {
            if (row?.word == null || row.word === '') continue;
            const weekLabel = String(row?.week_label ?? '');
            if (!grouped.has(weekLabel)) {
              grouped.set(weekLabel, { words: [], latestCreatedAt: 0 });
            }
            const createdAtMs = row?.created_at ? Date.parse(row.created_at) : 0;
            const bucket = grouped.get(weekLabel);
            bucket.words.push(row);
            bucket.latestCreatedAt = Math.max(bucket.latestCreatedAt, Number.isFinite(createdAtMs) ? createdAtMs : 0);
          }

          const groups = Array.from(grouped.entries())
            .map(([weekLabel, bucket]) => ({
              weekLabel,
              words: bucket.words,
              latestCreatedAt: bucket.latestCreatedAt,
            }))
            .sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);

          if (!cancelled) {
            setWeekGroups(groups);
            setSelectedWeek((prev) => {
              if (prev && groups.some((g) => g.weekLabel === prev)) return prev;
              return '';
            });
          }
        } catch (e) {
          if (!cancelled) {
            setWeekGroups([]);
            setSelectedWeek('');
            setErrorMsg(e?.message ?? 'Failed to load weekly words.');
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const selectedGroup = useMemo(
    () => weekGroups.find((g) => g.weekLabel === selectedWeek) ?? null,
    [weekGroups, selectedWeek],
  );

  const totalCount = useMemo(
    () => weekGroups.reduce((sum, g) => sum + g.words.length, 0),
    [weekGroups],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>This Week's Words</Text>
      <Text style={styles.subtitle}>{totalCount} words imported</Text>

      <TouchableOpacity
        style={styles.button}
        onPress={() => navigation.navigate('Import')}
      >
        <Text style={styles.buttonText}>Import Word List</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.button,
          styles.secondButton,
          (!selectedWeek || !selectedGroup || selectedGroup.words.length === 0) && styles.buttonDisabled,
        ]}
        onPress={() => {
          const selectedWords = selectedGroup?.words ?? [];
          console.log(
            '[HomeScreen] words being passed:',
            JSON.stringify(selectedWords[0]),
          );
          navigation.navigate('Learn', {
            weekLabel: selectedGroup?.weekLabel ?? '',
            words: selectedWords,
          });
        }}
        disabled={!selectedWeek || !selectedGroup || selectedGroup.words.length === 0}
      >
        <Text style={styles.buttonText}>Start Learning</Text>
      </TouchableOpacity>
      {!selectedWeek ? <Text style={styles.selectWeekHint}>Please select a week first</Text> : null}

      <View style={styles.weekCard}>
        <Text style={styles.weekTitle}>Available Weeks</Text>
        {loading ? <ActivityIndicator color="#4A90E2" /> : null}
        {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

        {!loading && !errorMsg ? (
          <ScrollView style={styles.weekList} contentContainerStyle={styles.weekListContent}>
            {weekGroups.map((group) => {
              const active = group.weekLabel === selectedWeek;
              return (
                <TouchableOpacity
                  key={group.weekLabel}
                  style={[styles.weekRow, active && styles.weekRowActive]}
                  onPress={() => setSelectedWeek(group.weekLabel)}
                >
                  <Text style={[styles.weekRowText, active && styles.weekRowTextActive]}>
                    {group.weekLabel} — {group.words.length} words
                  </Text>
                </TouchableOpacity>
              );
            })}
            {weekGroups.length === 0 ? <Text style={styles.emptyText}>No words imported yet.</Text> : null}
          </ScrollView>
        ) : null}
      </View>

      <View style={styles.selectedCard}>
        <Text style={styles.selectedTitle}>
          {selectedGroup ? `${selectedGroup.weekLabel} Words` : 'Select a Week'}
        </Text>
        <ScrollView style={styles.selectedList} contentContainerStyle={styles.selectedListContent}>
          {selectedGroup?.words?.map((row, idx) => {
            const word = typeof row === 'string' ? row : row?.word ?? '';
            return (
              <Text key={`${String(word)}-${idx}`} style={styles.wordItem}>
                {idx + 1}. {word}
              </Text>
            );
          })}
          {selectedGroup && selectedGroup.words.length === 0 ? (
            <Text style={styles.emptyText}>No words in this week.</Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingTop: 70,
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#4A90E2',
    paddingHorizontal: 40,
    paddingVertical: 15,
    borderRadius: 25,
    marginBottom: 15,
    width: 250,
    alignItems: 'center',
  },
  secondButton: {
    backgroundColor: '#7ED321',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  selectWeekHint: {
    color: '#666',
    fontSize: 14,
    marginTop: -6,
    marginBottom: 10,
  },
  weekCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: '#e4e4e4',
    borderRadius: 12,
    padding: 12,
    marginTop: 8,
    backgroundColor: '#fafafa',
  },
  weekTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
  },
  weekList: {
    maxHeight: 160,
  },
  weekListContent: {
    gap: 8,
    paddingBottom: 4,
  },
  weekRow: {
    borderWidth: 1,
    borderColor: '#d8d8d8',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
  },
  weekRowActive: {
    borderColor: '#4A90E2',
    backgroundColor: '#E8F4FD',
  },
  weekRowText: {
    color: '#444',
    fontSize: 15,
    fontWeight: '600',
  },
  weekRowTextActive: {
    color: '#1f5f9f',
  },
  selectedCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: '#e4e4e4',
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    backgroundColor: '#fff',
    flex: 1,
  },
  selectedTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
  },
  selectedList: {
    flex: 1,
  },
  selectedListContent: {
    paddingBottom: 10,
  },
  wordItem: {
    fontSize: 15,
    color: '#444',
    marginBottom: 8,
  },
  emptyText: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 12,
  },
  errorText: {
    color: '#c00',
    marginBottom: 8,
  },
});