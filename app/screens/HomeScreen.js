import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../../lib/supabase';
import { completeWeek } from '../lib/gardenHelpers';
import WeekCompleteModal from '../components/WeekCompleteModal';
import LottieView from 'lottie-react-native';
import { LinearGradient } from 'expo-linear-gradient';

function isValidWeekLabel(wl) {
  return wl != null && String(wl).trim() !== '';
}

export default function HomeScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [weekGroups, setWeekGroups] = useState([]);
  const [selectedWeek, setSelectedWeek] = useState('');
  const [modalVisible, setModalVisible] = useState(false);
  const [modalFlower, setModalFlower] = useState(null);
  const [modalCreature, setModalCreature] = useState(null);
  const [modalTotalFlowers, setModalTotalFlowers] = useState(0);

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
            const weekLabel = String(row?.week_label ?? '').trim();
            if (!isValidWeekLabel(weekLabel)) continue;
            if (!grouped.has(weekLabel)) {
              grouped.set(weekLabel, { words: [], passages: [], latestCreatedAt: 0 });
            }
            const createdAtMs = row?.created_at ? Date.parse(row.created_at) : 0;
            const bucket = grouped.get(weekLabel);
            bucket.words.push(row);
            bucket.latestCreatedAt = Math.max(bucket.latestCreatedAt, Number.isFinite(createdAtMs) ? createdAtMs : 0);
          }

          let { data: passageData, error: passageError } = await supabase
            .from('passages')
            .select('id, body, week_label, created_at')
            .eq('user_id', userId)
            .order('created_at', { ascending: true });
          if (passageError) {
            const retryP = await supabase
              .from('passages')
              .select('id, body, week_label, created_at')
              .eq('user_id', userId)
              .order('id', { ascending: true });
            passageData = retryP.data;
            passageError = retryP.error;
          }
          if (passageError) throw passageError;

          const passageRows = Array.isArray(passageData) ? passageData : [];
          for (const row of passageRows) {
            const body = String(row?.body ?? '').trim();
            if (!body) continue;
            const weekLabel = String(row?.week_label ?? '').trim();
            if (!isValidWeekLabel(weekLabel)) continue;
            if (!grouped.has(weekLabel)) {
              grouped.set(weekLabel, { words: [], passages: [], latestCreatedAt: 0 });
            }
            const bucket = grouped.get(weekLabel);
            bucket.passages.push(row);
            const createdAtMs = row?.created_at ? Date.parse(row.created_at) : 0;
            bucket.latestCreatedAt = Math.max(
              bucket.latestCreatedAt,
              Number.isFinite(createdAtMs) ? createdAtMs : 0,
            );
          }

          const groups = Array.from(grouped.entries())
            .filter(([weekLabel]) => isValidWeekLabel(weekLabel))
            .map(([weekLabel, bucket]) => ({
              weekLabel,
              words: bucket.words,
              passages: bucket.passages,
              latestCreatedAt: bucket.latestCreatedAt,
            }))
            .sort((a, b) => b.latestCreatedAt - a.latestCreatedAt);

          if (!cancelled) {
            setWeekGroups(groups);
            setSelectedWeek((prev) => {
              if (prev && groups.some((g) => g.weekLabel === prev)) return prev;
              return groups.length > 0 ? groups[0].weekLabel : '';
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

  const performDeleteWeek = async (weekLabel) => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (!userId) {
        setErrorMsg('Please log in to delete.');
        return;
      }
      const { error: wordsError } = await supabase
        .from('words')
        .delete()
        .eq('user_id', userId)
        .eq('week_label', weekLabel);
      if (wordsError) throw wordsError;
      const { error: passagesError } = await supabase
        .from('passages')
        .delete()
        .eq('user_id', userId)
        .eq('week_label', weekLabel);
      if (passagesError) throw passagesError;
      setWeekGroups((prev) => prev.filter((g) => g.weekLabel !== weekLabel));
      setSelectedWeek((prev) => (prev === weekLabel ? '' : prev));
      setErrorMsg('');
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to delete week.');
    }
  };

  const handleCompleteWeek = async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (!userId || !selectedGroup?.weekLabel) return;
      const result = await completeWeek(userId, selectedGroup.weekLabel);
      if (result) {
        setModalFlower(result.flower);
        setModalCreature(result.newCreature);
        setModalTotalFlowers(result.totalFlowers);
        setModalVisible(true);
      }
    } catch (e) {
      console.log('completeWeek error:', e.message);
    }
  };

  const confirmDeleteWeek = (group) => {
    const labelDisplay = group.weekLabel === '' ? '(no label)' : group.weekLabel;
    const count = group.words.length;
    Alert.alert(
      `Delete ${labelDisplay}?`,
      `This will delete all ${count} words in this week. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void performDeleteWeek(group.weekLabel);
          },
        },
      ],
    );
  };

  return (
    <LinearGradient
      colors={['#E3F2FD', '#F1F8FF', '#FFF8F0']}
      style={styles.container}
    >
      <View style={styles.bgDecor} pointerEvents="none">
        <View style={[styles.cloud, { top: 38, left: 18, width: 80, height: 36 }]} />
        <View style={[styles.cloud, { top: 28, left: 55, width: 60, height: 28 }]} />
        <View style={[styles.cloud, { top: 52, right: 30, width: 70, height: 30 }]} />
        <View style={[styles.cloud, { top: 40, right: 55, width: 50, height: 24 }]} />
        <View style={styles.sun} />
        <View style={styles.ground} />
        <View style={styles.ground2} />
      </View>
      <ScrollView
        style={styles.scrollFlex}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.mascotContainer}>
          <LottieView
            source={require('../../assets/animations/Trilo-5.json')}
            autoPlay
            loop
            style={styles.mascot}
          />
        </View>

        <View style={styles.weekChipRow}>
          {selectedWeek && isValidWeekLabel(selectedWeek) ? (
            <View style={styles.weekChip}>
              <Text style={styles.weekChipText}>{selectedWeek}</Text>
            </View>
          ) : null}
          <Text style={styles.wordCount}>
            {totalCount > 0 ? `${totalCount} words imported` : 'No words yet'}
          </Text>
        </View>

        {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

        {totalCount === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No words yet!</Text>
            <Text style={styles.emptySubtitle}>Import this week&apos;s word list to get started</Text>
          </View>
        ) : null}

        <View style={styles.stepsContainer}>
          <TouchableOpacity
            style={[styles.stepRow, styles.stepDone]}
            onPress={() => router.push('/import')}
          >
            <View style={styles.stepCheck}>
              <Text style={styles.stepCheckText}>
                {totalCount > 0 ? '✓' : '1'}
              </Text>
            </View>
            <View style={styles.stepContent}>
              <Text style={styles.stepLabel}>STEP 1</Text>
              <Text style={[styles.stepTitle, totalCount > 0 && styles.stepTitleDone]}>
                ＋ Import Word List
              </Text>
            </View>
            {totalCount > 0 && (
              <Text style={styles.stepDoneText}>Done</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.stepMain,
              (!selectedWeek || !selectedGroup || selectedGroup.words.length === 0)
                && styles.stepMainDisabled
            ]}
            onPress={() => {
              const selectedWords = selectedGroup?.words ?? [];
              console.log(
                '[HomeScreen] words being passed:',
                JSON.stringify(selectedWords[0]),
              );
              router.push({
                pathname: '/learn',
                params: {
                  weekLabel: selectedGroup?.weekLabel ?? '',
                  wordsJSON: JSON.stringify(selectedWords),
                },
              });
            }}
            disabled={!selectedWeek || !selectedGroup || selectedGroup.words.length === 0}
          >
            <Text style={styles.stepMainLabel}>STEP 2</Text>
            <Text style={styles.stepMainTitle}>▶  Start Learning</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.stepSecondary,
              (!selectedWeek || !selectedGroup || selectedGroup.words.length === 0)
                && styles.stepSecondaryDisabled
            ]}
            onPress={() => {
              const weekLabel = selectedGroup?.weekLabel ?? '';
              router.push({ pathname: '/dictation', params: { weekLabel } });
            }}
            disabled={!selectedWeek || !selectedGroup || selectedGroup.words.length === 0}
          >
            <Text style={styles.stepLabel}>STEP 3</Text>
            <Text style={styles.stepSecondaryTitle}>🎤  Dictation Test</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.weekSection}>
          <Text style={styles.weekSectionTitle}>Available Weeks</Text>
          {loading ? (
            <ActivityIndicator color="#FFA726" />
          ) : null}
          {!loading && weekGroups.length === 0 ? (
            <Text style={styles.emptyText}>No words imported yet.</Text>
          ) : null}
          {!loading && weekGroups
            .filter((group) => isValidWeekLabel(group.weekLabel))
            .map((group) => {
              const active = group.weekLabel === selectedWeek;
              return (
                <View
                  key={group.weekLabel}
                  style={[styles.weekRow, active && styles.weekRowActive]}
                >
                  <TouchableOpacity
                    style={styles.weekRowMain}
                    onPress={() => setSelectedWeek(group.weekLabel)}
                    activeOpacity={0.7}
                  >
                    <Text style={[styles.weekRowText, active && styles.weekRowTextActive]}>
                      {group.weekLabel} — {group.words.length} words
                      {group.passages?.length > 0
                        ? ` · ${group.passages.length} passage${group.passages.length > 1 ? 's' : ''}`
                        : ''}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.weekRowDelete}
                    onPress={() => confirmDeleteWeek(group)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.weekRowDeleteText}>🗑</Text>
                  </TouchableOpacity>
                </View>
              );
            })}
        </View>

      </ScrollView>

      <WeekCompleteModal
        visible={modalVisible}
        flower={modalFlower}
        newCreature={modalCreature}
        totalFlowers={modalTotalFlowers}
        onViewAlbum={() => {
          setModalVisible(false);
          router.push('/album');
        }}
        onClose={() => setModalVisible(false)}
      />

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => {}}>
          <Text style={styles.tabIcon}>🏠</Text>
          <Text style={[styles.tabLabel, styles.tabLabelActive]}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/garden')}>
          <Text style={styles.tabIcon}>🌸</Text>
          <Text style={styles.tabLabel}>Garden</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/album')}>
          <Text style={styles.tabIcon}>🏅</Text>
          <Text style={styles.tabLabel}>Album</Text>
        </TouchableOpacity>
      </View>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollFlex: {
    flex: 1,
  },
  bgDecor: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  cloud: {
    position: 'absolute',
    backgroundColor: 'white',
    borderRadius: 99,
    opacity: 0.85,
  },
  sun: {
    position: 'absolute',
    top: 32,
    right: 24,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFD740',
    opacity: 0.8,
  },
  ground: {
    position: 'absolute',
    bottom: 32,
    left: 0,
    right: 0,
    height: 60,
    backgroundColor: '#C8E6C9',
    borderTopLeftRadius: 80,
    borderTopRightRadius: 120,
    opacity: 0.5,
  },
  ground2: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 40,
    backgroundColor: '#A5D6A7',
    opacity: 0.45,
  },
  scrollContent: {
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 16,
    paddingBottom: 40,
  },
  mascotContainer: {
    alignItems: 'center',
    marginBottom: 4,
  },
  mascot: {
    width: 110,
    height: 110,
  },
  weekChipRow: {
    alignItems: 'center',
    marginBottom: 16,
  },
  weekChip: {
    backgroundColor: '#FFF3E0',
    borderRadius: 99,
    paddingHorizontal: 16,
    paddingVertical: 4,
    marginBottom: 4,
  },
  weekChipText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#E65100',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  wordCount: {
    fontSize: 14,
    color: '#546E7A',
  },
  errorText: {
    color: '#c00',
    marginBottom: 8,
    fontSize: 13,
  },
  emptyState: {
    alignItems: 'center',
    marginBottom: 20,
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1A237E',
    marginBottom: 6,
  },
  emptySubtitle: {
    fontSize: 13,
    color: '#90A4AE',
    textAlign: 'center',
  },
  stepsContainer: {
    width: '100%',
    maxWidth: 420,
    marginBottom: 20,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.8)',
    borderWidth: 1,
    borderColor: '#E0E0E0',
  },
  stepDone: {
    opacity: 0.85,
  },
  stepCheck: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#E8F5E9',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  stepCheckText: {
    fontSize: 14,
    color: '#4CAF50',
    fontWeight: '700',
  },
  stepContent: {
    flex: 1,
  },
  stepLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: '#B0BEC5',
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  stepTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#546E7A',
  },
  stepTitleDone: {
    color: '#90A4AE',
  },
  stepDoneText: {
    fontSize: 11,
    color: '#4CAF50',
    fontWeight: '600',
  },
  stepMain: {
    width: '100%',
    backgroundColor: '#FFA726',
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
    shadowColor: '#FFA726',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  stepMainDisabled: {
    backgroundColor: '#E0E0E0',
    shadowOpacity: 0,
    elevation: 0,
  },
  stepMainLabel: {
    fontSize: 8,
    fontWeight: '700',
    color: '#FFF3E0',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  stepMainTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },
  stepSecondary: {
    width: '100%',
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 10,
    borderWidth: 1.5,
    borderColor: '#FFA726',
  },
  stepSecondaryDisabled: {
    borderColor: '#E0E0E0',
    opacity: 0.5,
  },
  stepSecondaryTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#E65100',
  },
  weekSection: {
    width: '100%',
    maxWidth: 420,
    marginBottom: 12,
  },
  weekSectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#90A4AE',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  weekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d8d8d8',
    borderRadius: 12,
    paddingVertical: 6,
    paddingLeft: 12,
    paddingRight: 6,
    backgroundColor: 'rgba(255,255,255,0.8)',
    marginBottom: 6,
  },
  weekRowActive: {
    borderColor: '#FFA726',
    backgroundColor: '#FFF8F0',
  },
  weekRowMain: {
    flex: 1,
    paddingVertical: 8,
    paddingRight: 8,
  },
  weekRowDelete: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  weekRowDeleteText: {
    fontSize: 18,
    color: '#c00',
  },
  weekRowText: {
    color: '#444',
    fontSize: 14,
    fontWeight: '600',
  },
  weekRowTextActive: {
    color: '#E65100',
  },
  selectedCard: {
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: '#e4e4e4',
    borderRadius: 16,
    padding: 12,
    marginTop: 4,
    backgroundColor: 'rgba(255,255,255,0.85)',
    flex: 1,
  },
  selectedTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginBottom: 8,
  },
  selectedList: {
    maxHeight: 160,
  },
  selectedListContent: {
    paddingBottom: 10,
  },
  wordItem: {
    fontSize: 15,
    color: '#444',
    marginBottom: 8,
  },
  emptyInline: {
    color: '#888',
    fontSize: 14,
    marginBottom: 4,
  },
  emptyText: {
    color: '#888',
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 12,
  },
  sectionHeading: {
    fontSize: 14,
    fontWeight: '800',
    color: '#555',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 10,
    marginTop: 2,
  },
  sectionHeadingAfterWords: {
    marginTop: 18,
  },
  selectWeekHint: {
    color: '#666',
    fontSize: 14,
    marginTop: -6,
    marginBottom: 10,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderTopWidth: 0.5,
    borderTopColor: '#E0E0E0',
    paddingBottom: 20,
    paddingTop: 8,
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
  },
  tabIcon: {
    fontSize: 20,
    marginBottom: 2,
  },
  tabLabel: {
    fontSize: 10,
    color: '#B0BEC5',
    fontWeight: '500',
  },
  tabLabelActive: {
    color: '#FFA726',
    fontWeight: '700',
  },
});