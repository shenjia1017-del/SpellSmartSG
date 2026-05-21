import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Trash2 } from 'lucide-react-native';
import { supabase } from '../../lib/supabase';
import { useChild } from '../lib/childContext';

const DELETE_CONFIRM_TITLE = 'Delete this week?';
const DELETE_CONFIRM_MESSAGE =
  'This will remove all words, dictation results, and flowers earned. This cannot be undone.';

export default function HistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { currentChild } = useChild();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [weekGroups, setWeekGroups] = useState([]);
  const [deletingWeekLabel, setDeletingWeekLabel] = useState(null);

  const loadHistory = useCallback(async () => {
    if (!currentChild?.id) {
      setWeekGroups([]);
      setLoading(false);
      return;
    }

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: wordData, error: wordError } = await supabase
        .from('words')
        .select('week_label, created_at')
        .eq('user_id', user.id)
        .eq('child_id', currentChild.id);

      if (wordError) throw wordError;

      const { data: passageData, error: passageError } = await supabase
        .from('passages')
        .select('week_label, created_at')
        .eq('user_id', user.id)
        .eq('child_id', currentChild.id);

      if (passageError) throw passageError;

      const grouped = new Map();
      (wordData || []).forEach((row) => {
        if (!row.week_label) return;
        const bucket = grouped.get(row.week_label) || {
          weekLabel: row.week_label,
          wordCount: 0,
          passageCount: 0,
          latestCreatedAt: 0,
        };
        bucket.wordCount += 1;
        const ts = row.created_at ? new Date(row.created_at).getTime() : 0;
        if (ts > bucket.latestCreatedAt) bucket.latestCreatedAt = ts;
        grouped.set(row.week_label, bucket);
      });

      (passageData || []).forEach((row) => {
        if (!row.week_label) return;
        const bucket = grouped.get(row.week_label) || {
          weekLabel: row.week_label,
          wordCount: 0,
          passageCount: 0,
          latestCreatedAt: 0,
        };
        bucket.passageCount += 1;
        const ts = row.created_at ? new Date(row.created_at).getTime() : 0;
        if (ts > bucket.latestCreatedAt) bucket.latestCreatedAt = ts;
        grouped.set(row.week_label, bucket);
      });

      const groups = Array.from(grouped.values()).sort(
        (a, b) => b.latestCreatedAt - a.latestCreatedAt,
      );

      setWeekGroups(groups);
    } catch (e) {
      console.log('History load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [currentChild?.id]);

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      loadHistory();
    }, [loadHistory]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    loadHistory();
  };

  const deleteWeek = async (weekLabel) => {
    if (!currentChild?.id) return;

    setDeletingWeekLabel(weekLabel);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        throw new Error('Please log in to delete a week.');
      }

      const wordQuery = supabase
        .from('words')
        .delete()
        .eq('user_id', user.id)
        .eq('child_id', currentChild.id)
        .eq('week_label', weekLabel);

      const passageQuery = supabase
        .from('passages')
        .delete()
        .eq('user_id', user.id)
        .eq('child_id', currentChild.id)
        .eq('week_label', weekLabel);

      const flowerQuery = supabase
        .from('flower_collection')
        .delete()
        .eq('user_id', user.id)
        .eq('week_label', weekLabel);

      const [wordRes, passageRes, flowerRes] = await Promise.all([
        wordQuery,
        passageQuery,
        flowerQuery,
      ]);

      if (wordRes.error) throw wordRes.error;
      if (passageRes.error) throw passageRes.error;
      if (flowerRes.error) throw flowerRes.error;

      await loadHistory();
    } catch (e) {
      Alert.alert('Delete failed', e?.message ?? 'Could not delete this week.');
    } finally {
      setDeletingWeekLabel(null);
    }
  };

  const confirmDeleteWeek = (weekLabel) => {
    Alert.alert(DELETE_CONFIRM_TITLE, DELETE_CONFIRM_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void deleteWeek(weekLabel);
        },
      },
    ]);
  };

  const formatDate = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString('en-SG', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Text style={styles.title}>History</Text>
      <Text style={styles.subtitle}>All imported weeks</Text>

      {loading ? (
        <ActivityIndicator color="#F97316" style={{ marginTop: 40 }} />
      ) : weekGroups.length === 0 ? (
        <Text style={styles.emptyText}>
          No history yet. Import your first word list from Home.
        </Text>
      ) : (
        weekGroups.map((group) => {
          const isDeleting = deletingWeekLabel === group.weekLabel;
          return (
            <View key={group.weekLabel} style={styles.weekCard}>
              <TouchableOpacity
                style={styles.weekCardBody}
                onPress={() =>
                  router.push({
                    pathname: '/week-detail',
                    params: { week: group.weekLabel },
                  })
                }
                activeOpacity={0.7}
                disabled={isDeleting}
              >
                <View style={styles.weekCardLeft}>
                  <Text style={styles.weekLabel}>{group.weekLabel}</Text>
                  <Text style={styles.weekMeta}>
                    {group.wordCount} word{group.wordCount !== 1 ? 's' : ''}
                    {group.passageCount > 0
                      ? ` · ${group.passageCount} passage${group.passageCount > 1 ? 's' : ''}`
                      : ''}
                  </Text>
                  <Text style={styles.weekDate}>{formatDate(group.latestCreatedAt)}</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </TouchableOpacity>

              <Pressable
                style={styles.deleteHitArea}
                onPress={() => confirmDeleteWeek(group.weekLabel)}
                disabled={isDeleting || deletingWeekLabel != null}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${group.weekLabel}`}
              >
                {isDeleting ? (
                  <ActivityIndicator size="small" color="#9CA3AF" />
                ) : (
                  <Trash2 size={20} color="#9CA3AF" strokeWidth={2} />
                )}
              </Pressable>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF8F0' },
  content: { padding: 20, paddingBottom: 60 },
  title: { fontSize: 28, fontWeight: '700', color: '#1F2937', marginBottom: 4 },
  subtitle: { fontSize: 14, color: '#6B7280', marginBottom: 24 },
  weekCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#F3E8D8',
    flexDirection: 'row',
    alignItems: 'center',
  },
  weekCardBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    paddingRight: 8,
  },
  weekCardLeft: { flex: 1 },
  weekLabel: { fontSize: 17, fontWeight: '600', color: '#1F2937', marginBottom: 4 },
  weekMeta: { fontSize: 13, color: '#6B7280', marginBottom: 2 },
  weekDate: { fontSize: 12, color: '#9CA3AF' },
  arrow: { fontSize: 24, color: '#F97316', fontWeight: '300', marginLeft: 8 },
  deleteHitArea: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingRight: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#9CA3AF',
    fontStyle: 'italic',
    textAlign: 'center',
    marginTop: 40,
  },
});
