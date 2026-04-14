import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  ActivityIndicator, TouchableOpacity
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getWeekMastery, completeWeek } from '../lib/gardenHelpers';
import WeekCompleteModal from '../components/WeekCompleteModal';

const STATUS_EMOJI = {
  soil: null,
  sprout: '🌱',
  bloom: '🌸',
  wilt: '🥀',
};

export default function GardenScreen() {
  const router = useRouter();
  const [weekGroups, setWeekGroups] = useState([]);
  const [selectedWeek, setSelectedWeek] = useState('');
  const [words, setWords] = useState([]);
  const [mastery, setMastery] = useState({});
  const [loading, setLoading] = useState(true);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalFlower, setModalFlower] = useState(null);
  const [modalCreature, setModalCreature] = useState(null);
  const [modalTotalFlowers, setModalTotalFlowers] = useState(0);

  useEffect(() => {
    loadWeeks();
  }, []);

  useEffect(() => {
    if (selectedWeek) loadMastery();
  }, [selectedWeek]);

  async function loadWeeks() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data } = await supabase
      .from('words')
      .select('id, word, week_label')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (!data) return;
    const grouped = {};
    data.forEach(w => {
      if (!grouped[w.week_label]) grouped[w.week_label] = [];
      grouped[w.week_label].push(w);
    });
    const groups = Object.entries(grouped).map(([label, words]) => ({ label, words }));
    setWeekGroups(groups);
    if (groups.length > 0) setSelectedWeek(groups[0].label);
    setLoading(false);
  }

  async function loadMastery() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const masteryData = await getWeekMastery(user.id, selectedWeek);
    const masteryMap = {};
    masteryData.forEach(m => { masteryMap[m.word_id] = m.status; });
    const selectedGroup = weekGroups.find(g => g.label === selectedWeek);
    setWords(selectedGroup?.words || []);
    setMastery(masteryMap);
  }

  async function handleCompleteWeek() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !selectedWeek) return;
    const result = await completeWeek(user.id, selectedWeek);
    if (result) {
      setModalFlower(result.flower);
      setModalCreature(result.newCreature);
      setModalTotalFlowers(result.totalFlowers);
      setModalVisible(true);
    } else {
      alert('This week has already been completed!');
    }
  }

  const bloomCount = Object.values(mastery).filter(s => s === 'bloom').length;
  const total = words.length;
  const progress = total > 0 ? bloomCount / total : 0;

  if (loading) return (
    <LinearGradient colors={['#E3F2FD', '#F1F8FF', '#FFF8F0']} style={styles.container}>
      <ActivityIndicator color="#FFA726" style={{ marginTop: 100 }} />
    </LinearGradient>
  );

  return (
    <LinearGradient colors={['#E3F2FD', '#F1F8FF', '#FFF8F0']} style={styles.container}>
      <View style={styles.bgDecor} pointerEvents="none">
        <View style={[styles.cloud, { top: 38, left: 18, width: 80, height: 36 }]} />
        <View style={[styles.cloud, { top: 28, left: 55, width: 60, height: 28 }]} />
        <View style={[styles.cloud, { top: 52, right: 30, width: 70, height: 30 }]} />
        <View style={styles.sun} />
        <View style={styles.ground} />
        <View style={styles.ground2} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>

        <Text style={styles.title}>My Garden</Text>

        <View style={styles.weekTabs}>
          {weekGroups.map(g => (
            <TouchableOpacity
              key={g.label}
              style={[styles.weekTab, selectedWeek === g.label && styles.weekTabActive]}
              onPress={() => setSelectedWeek(g.label)}
            >
              <Text style={[styles.weekTabText, selectedWeek === g.label && styles.weekTabTextActive]}>
                {g.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.progressRow}>
          <Text style={styles.progressText}>{bloomCount} / {total} blooming</Text>
          <Text style={styles.progressPct}>{total > 0 ? Math.round(progress * 100) : 0}%</Text>
        </View>
        <View style={styles.progressBar}>
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </View>

        <View style={styles.grid}>
          {words.map(w => {
            const status = mastery[w.id] || 'soil';
            return (
              <View key={w.id} style={[
                styles.cell,
                status === 'wilt' && styles.cellWilt,
                status === 'soil' && styles.cellSoil,
              ]}>
                {STATUS_EMOJI[status] ? (
                  <Text style={styles.cellEmoji}>{STATUS_EMOJI[status]}</Text>
                ) : (
                  <View style={styles.soilDot} />
                )}
                <Text style={styles.cellWord} numberOfLines={1}>{w.word}</Text>
              </View>
            );
          })}
        </View>

        {total > 0 && bloomCount === total && (
          <View style={styles.readyBanner}>
            <Text style={styles.readyText}>🎉 Ready for school test!</Text>
          </View>
        )}

        <TouchableOpacity
          style={styles.completeBtn}
          onPress={handleCompleteWeek}
          disabled={!selectedWeek}
        >
          <Text style={styles.completeBtnText}>🌼  Complete this week</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.albumBtn}
          onPress={() => router.push('/album')}
        >
          <Text style={styles.albumBtnText}>🏅  View My Album</Text>
        </TouchableOpacity>

      </ScrollView>

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/home')}>
          <Text style={styles.tabIcon}>🏠</Text>
          <Text style={styles.tabLabel}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem}>
          <Text style={styles.tabIcon}>🌸</Text>
          <Text style={[styles.tabLabel, styles.tabLabelActive]}>Garden</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/album')}>
          <Text style={styles.tabIcon}>🏅</Text>
          <Text style={styles.tabLabel}>Album</Text>
        </TouchableOpacity>
      </View>

      <WeekCompleteModal
        visible={modalVisible}
        flower={modalFlower}
        newCreature={modalCreature}
        totalFlowers={modalTotalFlowers}
        onViewAlbum={() => { setModalVisible(false); router.push('/album'); }}
        onClose={() => setModalVisible(false)}
      />
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  bgDecor: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  cloud: { position: 'absolute', backgroundColor: 'white', borderRadius: 99, opacity: 0.85 },
  sun: { position: 'absolute', top: 32, right: 24, width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFD740', opacity: 0.8 },
  ground: { position: 'absolute', bottom: 60, left: 0, right: 0, height: 60, backgroundColor: '#C8E6C9', borderTopLeftRadius: 80, borderTopRightRadius: 120, opacity: 0.5 },
  ground2: { position: 'absolute', bottom: 40, left: 0, right: 0, height: 40, backgroundColor: '#A5D6A7', opacity: 0.45 },
  content: { paddingTop: 70, paddingHorizontal: 16, paddingBottom: 20 },
  title: { fontSize: 24, fontWeight: '800', color: '#1A237E', marginBottom: 16, textAlign: 'center' },
  weekTabs: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'center', marginBottom: 16 },
  weekTab: { backgroundColor: 'rgba(255,255,255,0.7)', borderRadius: 99, paddingHorizontal: 14, paddingVertical: 6, borderWidth: 1, borderColor: '#E0E0E0' },
  weekTabActive: { backgroundColor: '#FFF3E0', borderColor: '#FFA726' },
  weekTabText: { fontSize: 12, color: '#90A4AE', fontWeight: '600' },
  weekTabTextActive: { color: '#E65100', fontWeight: '700' },
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  progressText: { fontSize: 13, color: '#546E7A' },
  progressPct: { fontSize: 13, color: '#FFA726', fontWeight: '700' },
  progressBar: { height: 8, backgroundColor: 'rgba(255,255,255,0.6)', borderRadius: 99, marginBottom: 16, overflow: 'hidden' },
  progressFill: { height: '100%', backgroundColor: '#FFA726', borderRadius: 99 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  cell: { width: '18%', aspectRatio: 1, borderWidth: 0.5, borderColor: 'rgba(255,255,255,0.8)', borderRadius: 10, alignItems: 'center', justifyContent: 'center', padding: 4, backgroundColor: 'rgba(255,255,255,0.7)' },
  cellWilt: { opacity: 0.5 },
  cellSoil: {
    backgroundColor: 'rgba(200,200,200,0.15)',
    borderColor: 'rgba(200,200,200,0.4)',
  },
  soilDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: '#D0D0D0',
    marginBottom: 4,
  },
  cellEmoji: { fontSize: 20 },
  cellWord: { fontSize: 8, color: '#888', marginTop: 2, textAlign: 'center' },
  readyBanner: { backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 14, padding: 14, alignItems: 'center', marginBottom: 16 },
  readyText: { fontSize: 16, fontWeight: '700', color: '#34c759' },
  completeBtn: { backgroundColor: '#66BB6A', borderRadius: 16, paddingVertical: 14, alignItems: 'center', marginBottom: 10, shadowColor: '#66BB6A', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  completeBtnText: { fontSize: 15, fontWeight: '700', color: 'white' },
  albumBtn: { backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 14, paddingVertical: 12, alignItems: 'center', borderWidth: 1, borderColor: '#E0E0E0' },
  albumBtnText: { fontSize: 14, fontWeight: '600', color: '#546E7A' },
  tabBar: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.92)', borderTopWidth: 0.5, borderTopColor: '#E0E0E0', paddingBottom: 20, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20, marginBottom: 2 },
  tabLabel: { fontSize: 10, color: '#B0BEC5', fontWeight: '500' },
  tabLabelActive: { color: '#FFA726', fontWeight: '700' },
});
