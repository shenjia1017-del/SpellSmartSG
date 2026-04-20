import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Alert, ActivityIndicator
} from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';

export default function HistoryScreen() {
  const router = useRouter();
  const [weekGroups, setWeekGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedChild, setSelectedChild] = useState('All');

  const loadWeeks = async () => {
    setLoading(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data, error } = await supabase
        .from('words')
        .select('week_label')
        .eq('user_id', user.id);
      if (error) throw error;
      const labels = [...new Set(data.map(w => w.week_label))].sort().reverse();
      setWeekGroups(labels);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useFocusEffect(useCallback(() => { loadWeeks(); }, []));

  const confirmDelete = (weekLabel) => {
    Alert.alert(
      'Delete Week',
      `Delete all words for ${weekLabel}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteWeek(weekLabel) }
      ]
    );
  };

  const deleteWeek = async (weekLabel) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      await supabase.from('words').delete().eq('user_id', user.id).eq('week_label', weekLabel);
      await supabase.from('passages').delete().eq('user_id', user.id).eq('week_label', weekLabel);
      loadWeeks();
    } catch (e) {
      console.error(e);
    }
  };

  const currentWeek = weekGroups[0];
  const pastWeeks = weekGroups.slice(1);

  return (
    <View style={styles.container}>
      <View style={styles.pageHeader}>
        <Text style={styles.pageTitle}>Achievement History</Text>
        <Text style={styles.pageSubtitle}>All your spelling weeks</Text>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {loading ? (
          <ActivityIndicator color="#F97316" style={{ marginTop: 40 }} />
        ) : weekGroups.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyEmoji}>📭</Text>
            <Text style={styles.emptyTitle}>No weeks yet</Text>
            <Text style={styles.emptySub}>Import your first word list to get started!</Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/import')}>
              <Text style={styles.emptyBtnText}>+ Import Word List</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {currentWeek && (
              <>
                <Text style={styles.sectionTitle}>CURRENT WEEK</Text>
                <View style={styles.currentCard}>
                  <View style={styles.cardTopRow}>
                    <Text style={styles.currentCardTitle}>{currentWeek}</Text>
                    <View style={styles.currentBadge}>
                      <Text style={styles.currentBadgeText}>CURRENT</Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    style={styles.goBtn}
                    onPress={() => router.push('/')}
                  >
                    <Text style={styles.goBtnText}>Go to this week →</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {pastWeeks.length > 0 && (
              <>
                <Text style={styles.sectionTitle}>PAST WEEKS</Text>
                {pastWeeks.map((weekLabel) => (
                  <View key={weekLabel} style={styles.pastCard}>
                    <View style={styles.cardTopRow}>
                      <Text style={styles.pastCardTitle}>{weekLabel}</Text>
                      <Text style={styles.stars}>⭐⭐⭐</Text>
                    </View>
                    <View style={styles.cardBottomRow}>
                      <TouchableOpacity
                        onPress={() => router.push('/')}
                      >
                        <Text style={styles.reviewText}>Review →</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => confirmDelete(weekLabel)}>
                        <Text style={styles.deleteText}>🗑 Delete</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/')}>
          <Text style={styles.tabIcon}>🏠</Text>
          <Text style={styles.tabLabel}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/album')}>
          <Text style={styles.tabIcon}>🏅</Text>
          <Text style={styles.tabLabel}>Album</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem}>
          <Text style={styles.tabIcon}>📊</Text>
          <Text style={[styles.tabLabel, styles.tabLabelActive]}>History</Text>
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
  pageHeader: { backgroundColor: '#FFF8F0', paddingHorizontal: 16, paddingTop: 56, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#F0E8DC' },
  pageTitle: { fontSize: 20, fontWeight: '900', color: '#1A1A1A' },
  pageSubtitle: { fontSize: 10, color: '#999', marginTop: 2 },
  scroll: { flex: 1 },
  scrollContent: { padding: 14, paddingBottom: 20 },
  sectionTitle: { fontSize: 9, fontWeight: '700', color: '#bbb', letterSpacing: 1, marginBottom: 6, marginTop: 10 },
  currentCard: { backgroundColor: '#FFF8F0', borderRadius: 14, borderWidth: 1.5, borderColor: '#F97316', padding: 14, marginBottom: 6 },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  currentCardTitle: { fontSize: 16, fontWeight: '800', color: '#E65100' },
  currentBadge: { backgroundColor: '#F97316', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  currentBadgeText: { fontSize: 8, fontWeight: '800', color: 'white', letterSpacing: 0.5 },
  goBtn: { backgroundColor: '#F97316', borderRadius: 10, padding: 10, alignItems: 'center' },
  goBtnText: { fontSize: 12, fontWeight: '700', color: 'white' },
  pastCard: { backgroundColor: 'white', borderRadius: 14, borderWidth: 1.5, borderColor: '#F0E8DC', padding: 14, marginBottom: 7 },
  pastCardTitle: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  stars: { fontSize: 12 },
  cardBottomRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#F5F0EA' },
  reviewText: { fontSize: 11, color: '#F97316', fontWeight: '700' },
  deleteText: { fontSize: 11, color: '#E57373', fontWeight: '600' },
  emptyState: { alignItems: 'center', paddingTop: 60 },
  emptyEmoji: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: '800', color: '#1A1A1A', marginBottom: 6 },
  emptySub: { fontSize: 13, color: '#999', textAlign: 'center', marginBottom: 20 },
  emptyBtn: { backgroundColor: '#F97316', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 24 },
  emptyBtnText: { fontSize: 14, fontWeight: '700', color: 'white' },
  tabBar: { flexDirection: 'row', backgroundColor: 'white', borderTopWidth: 0.5, borderTopColor: '#F0EAE0', paddingBottom: 20, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20, marginBottom: 2 },
  tabLabel: { fontSize: 9, color: '#B0BEC5', fontWeight: '600' },
  tabLabelActive: { color: '#F97316' },
});
