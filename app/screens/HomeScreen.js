import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { supabase } from '../../lib/supabase';
import { completeWeek } from '../lib/gardenHelpers';
import WeekCompleteModal from '../components/WeekCompleteModal';
import LottieView from 'lottie-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useChild } from '../lib/childContext';
import { Colors, Spacing, Radius, FontSize, Shadow } from '../lib/theme';

function isValidWeekLabel(wl) {
  return wl != null && String(wl).trim() !== '';
}

function StepButton3D({ onPress, disabled = false, shadowColor, shadowRadius = Radius.button, style, children }) {
  const translateY = React.useRef(new Animated.Value(0)).current;

  const onPressIn = () => {
    if (disabled) return;
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    Animated.timing(translateY, {
      toValue: 5,
      duration: 80,
      useNativeDriver: true,
    }).start();
  };

  const onPressOut = () => {
    if (disabled) return;
    Animated.timing(translateY, {
      toValue: 0,
      duration: 80,
      useNativeDriver: true,
    }).start();
  };

  return (
    <TouchableWithoutFeedback
      onPress={disabled ? undefined : onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
    >
      <View style={[style, styles.step3DHost]}>
        {!disabled ? (
          <View
            style={[
              styles.stepShadowBase,
              {
                backgroundColor: shadowColor ?? Colors.primaryDark,
                borderRadius: shadowRadius,
              },
            ]}
          />
        ) : null}
        <Animated.View style={{ transform: [{ translateY }] }}>{children}</Animated.View>
      </View>
    </TouchableWithoutFeedback>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { currentChild, children, setCurrentChild } = useChild();
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [weekGroups, setWeekGroups] = useState([]);
  const [selectedWeek, setSelectedWeek] = useState('');
  const [bloomCount, setBloomCount] = useState(0);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalFlower, setModalFlower] = useState(null);
  const [modalCreature, setModalCreature] = useState(null);
  const [modalTotalFlowers, setModalTotalFlowers] = useState(0);
  const [childMenuVisible, setChildMenuVisible] = useState(false);
  const [isJumping, setIsJumping] = useState(false);

  useEffect(() => {
    if (!currentChild && children.length > 0) {
      router.replace('/select-child');
    }
  }, [currentChild, children.length, router]);

  const loadBloomCount = useCallback(async (userId, weekLabel) => {
    if (!userId || !weekLabel) return;
    try {
      const { data } = await supabase
        .from('word_mastery')
        .select('status')
        .eq('user_id', userId)
        .eq('week_label', weekLabel)
        .eq('status', 'bloom');
      setBloomCount(data?.length || 0);
    } catch (e) {
      console.log('bloomCount error:', e.message);
    }
  }, []);

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
            .eq('child_id', currentChild?.id ?? '')
            .order('created_at', { ascending: true });

          if (error) {
            const retry = await supabase
              .from('words')
              .select('id, word, user_id, week_label, created_at, learn_card_json')
              .eq('user_id', userId)
              .eq('child_id', currentChild?.id ?? '')
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
            .eq('child_id', currentChild?.id ?? '')
            .order('created_at', { ascending: true });
          if (passageError) {
            const retryP = await supabase
              .from('passages')
              .select('id, body, week_label, created_at')
              .eq('user_id', userId)
              .eq('child_id', currentChild?.id ?? '')
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
            let nextWeekForBloom = '';
            setWeekGroups(groups);
            setSelectedWeek((prev) => {
              nextWeekForBloom =
                prev && groups.some((g) => g.weekLabel === prev)
                  ? prev
                  : groups.length > 0
                    ? groups[0].weekLabel
                    : '';
              return nextWeekForBloom;
            });
            if (!cancelled && userId && nextWeekForBloom) {
              await loadBloomCount(userId, nextWeekForBloom);
            }
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
    }, [loadBloomCount, currentChild?.id]),
  );

  useEffect(() => {
    const loadBloom = async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id;
      if (uid && selectedWeek) {
        await loadBloomCount(uid, selectedWeek);
      }
    };
    loadBloom();
  }, [selectedWeek, loadBloomCount]);

  const selectedGroup = useMemo(
    () => weekGroups.find((g) => g.weekLabel === selectedWeek) ?? null,
    [weekGroups, selectedWeek],
  );

  const totalCount = useMemo(
    () => weekGroups.reduce((sum, g) => sum + g.words.length, 0),
    [weekGroups],
  );
  const childAvatar = currentChild?.gender === 'girl'
    ? { emoji: '👧', bg: '#FCE7F3' }
    : { emoji: '👦', bg: '#DBEAFE' };

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

  return (
    <LinearGradient
      colors={['#FFF8F0', '#FFF8F0', '#FFF8F0']}
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
        <View style={[styles.heroSection, { paddingTop: insets.top + 12 }]}>
          <View style={styles.heroTopRow}>
            <View style={styles.weekBadge}>
              <Text style={styles.weekBadgeText}>
                {selectedWeek && isValidWeekLabel(selectedWeek) ? selectedWeek.toUpperCase() : 'NO WEEK'}
              </Text>
            </View>
            <View style={styles.heroRight}>
              <Text style={styles.wordCountSmall}>
                {totalCount > 0 ? `${totalCount} words imported` : 'No words yet'}
              </Text>
              <TouchableOpacity
                style={styles.childSwitchBtn}
                onPress={() => setChildMenuVisible(true)}
              >
                <View style={[styles.childSwitchAvatar, { backgroundColor: childAvatar.bg }]}>
                  <Text>{childAvatar.emoji}</Text>
                </View>
                <Text style={styles.childSwitchName}>
                  {String(currentChild?.name ?? 'No child').trim().split(/\s+/)[0]}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
          <View style={styles.mascotRow}>
            <View style={styles.mascotContainer}>
              <Pressable
                onPress={() => {
                  setIsJumping(true);
                  if (Platform.OS === 'ios') {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  }
                }}
              >
                <LottieView
                  source={
                    isJumping
                      ? require('../../assets/animations/Trilo-jump.json')
                      : require('../../assets/animations/Trilo-wave.json')
                  }
                  autoPlay
                  loop={!isJumping}
                  onAnimationFinish={() => {
                    if (isJumping) setIsJumping(false);
                  }}
                  style={styles.mascot}
                />
              </Pressable>
            </View>
            <View style={styles.speechBubble}>
              <Text style={styles.speechMain}>Ready to learn? 💪</Text>
              <Text style={styles.speechSub}>
                {bloomCount > 0 && selectedGroup
                  ? `${selectedGroup.words.length - bloomCount} more words to bloom!`
                  : 'Start learning today!'}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.cardsRow}>
          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>THIS WEEK&apos;S GOAL</Text>
            <View style={styles.ringWrap}>
              <View style={styles.ringOuter}>
                <View style={styles.ringInner}>
                  <Text style={styles.ringNum}>
                    {bloomCount}/{selectedGroup?.words.length ?? 0}
                  </Text>
                  <Text style={styles.ringSubText}>mastered</Text>
                </View>
              </View>
            </View>
            <Text style={styles.ringTip}>
              {selectedGroup && selectedGroup.words.length > 0
                ? `${Math.round((bloomCount / selectedGroup.words.length) * 100)}% complete`
                : 'No words yet'}
            </Text>
          </View>
          <View style={styles.infoCard}>
            <Text style={styles.infoCardTitle}>BLOOMING PROGRESS</Text>
            <View style={styles.flowersRow}>
              {selectedGroup && selectedGroup.words.length > 0
                ? Array.from({ length: Math.min(selectedGroup.words.length, 5) }).map((_, i) => (
                    <Text key={i} style={styles.flowerEmoji}>
                      {i < bloomCount ? '🌸' : '🌱'}
                    </Text>
                  ))
                : <Text style={styles.flowerEmoji}>🌱</Text>}
            </View>
            <Text style={styles.ringTip}>
              {bloomCount} of {selectedGroup?.words.length ?? 0} bloomed
            </Text>
          </View>
        </View>

        {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

        {totalCount === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No words yet!</Text>
            <Text style={styles.emptySubtitle}>Import this week&apos;s word list to get started</Text>
          </View>
        ) : null}

        <View style={styles.stepsContainer}>
          <StepButton3D
            style={styles.step3DWrap}
            onPress={() => router.push('/import')}
            disabled={false}
            shadowColor={totalCount > 0 ? Colors.successDark : Colors.primaryDark}
            shadowRadius={Radius.button}
          >
            <View style={[styles.stepRow, totalCount > 0 && styles.stepRowDone]}>
              <View style={[styles.stepNum, totalCount > 0 && styles.stepNumDone]}>
                <Text style={[styles.stepNumText, totalCount > 0 && styles.stepNumTextDone]}>
                  {totalCount > 0 ? '✓' : '1'}
                </Text>
              </View>
              <Text style={styles.stepIcon}>📷</Text>
              <View style={styles.stepContent}>
                <Text style={styles.stepLabel}>STEP 1</Text>
                <Text style={[styles.stepTitle, totalCount > 0 && styles.stepTitleDone]}>
                  Import / Scan Word List
                </Text>
              </View>
              {totalCount > 0 && <Text style={styles.stepDoneText}>Done</Text>}
            </View>
          </StepButton3D>

          <StepButton3D
            style={styles.step3DWrap}
            onPress={() => {
              const selectedWords = selectedGroup?.words ?? [];
              router.push({
                pathname: '/learn',
                params: {
                  weekLabel: selectedGroup?.weekLabel ?? '',
                  wordsJSON: JSON.stringify(selectedWords),
                },
              });
            }}
            disabled={!selectedWeek || !selectedGroup || selectedGroup.words.length === 0}
            shadowColor={Colors.primaryDark}
            shadowRadius={Radius.large}
          >
            <View
              style={[
                styles.stepMain,
                (!selectedWeek || !selectedGroup || selectedGroup.words.length === 0)
                  && styles.stepMainDisabled,
              ]}
            >
              <Text style={styles.stepMainLabel}>STEP 2</Text>
              <Text style={styles.stepMainTitle}>▶  Start Learning</Text>
            </View>
          </StepButton3D>

          <StepButton3D
            style={styles.step3DWrap}
            onPress={() => {
              const weekLabel = selectedGroup?.weekLabel ?? '';
              router.push({ pathname: '/dictation', params: { weekLabel } });
            }}
            disabled={!selectedWeek || !selectedGroup || selectedGroup.words.length === 0}
            shadowColor={Colors.primaryDark}
            shadowRadius={Radius.large}
          >
            <View
              style={[
                styles.stepSecondary,
                (!selectedWeek || !selectedGroup || selectedGroup.words.length === 0)
                  && styles.stepSecondaryDisabled,
              ]}
            >
              <Text style={styles.stepLabel}>STEP 3</Text>
              <Text style={styles.stepSecondaryTitle}>🎤  Dictation Test</Text>
            </View>
          </StepButton3D>
        </View>

        <View style={styles.weekSection}>
          <Text style={styles.weekSectionTitle}>RECENTLY IMPORTED</Text>
          {loading ? (
            <ActivityIndicator color="#F97316" />
          ) : null}
          {!loading && weekGroups.length === 0 ? (
            <Text style={styles.emptyText}>No words imported yet.</Text>
          ) : null}
          {!loading && weekGroups
            .filter((group) => isValidWeekLabel(group.weekLabel))
            .slice(0, 1)
            .map((group) => {
              const active = group.weekLabel === selectedWeek;
              return (
                <TouchableOpacity
                  key={group.weekLabel}
                  style={[styles.weekChipItem, !active && styles.weekChipItemInactive]}
                  onPress={() => {
                    setSelectedWeek(group.weekLabel);
                    router.push({ pathname: '/week-detail', params: { week: group.weekLabel } });
                  }}
                  activeOpacity={0.7}
                >
                  <View style={styles.weekChipLeft}>
                    <Text style={[styles.weekChipText, !active && styles.weekChipTextInactive]}>
                      {group.weekLabel}
                    </Text>
                    <Text style={styles.weekChipSub}>
                      {group.words.length} words
                      {group.passages?.length > 0
                        ? ` · ${group.passages.length} passage${group.passages.length > 1 ? 's' : ''}`
                        : ''}
                    </Text>
                  </View>
                  <Text style={[styles.weekChipArrow, !active && styles.weekChipArrowInactive]}>›</Text>
                </TouchableOpacity>
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

      <Modal visible={childMenuVisible} transparent animationType="fade" onRequestClose={() => setChildMenuVisible(false)}>
        <Pressable style={styles.childMenuBackdrop} onPress={() => setChildMenuVisible(false)}>
          <View style={styles.childMenuCard}>
            {children.map((child) => {
              const avatar = child.gender === 'girl'
                ? { emoji: '👧', bg: '#FCE7F3' }
                : { emoji: '👦', bg: '#DBEAFE' };
              const active = child.id === currentChild?.id;
              return (
                <TouchableOpacity
                  key={child.id}
                  style={[styles.childMenuRow, active && styles.childMenuRowActive]}
                  onPress={async () => {
                    await setCurrentChild(child);
                    setChildMenuVisible(false);
                  }}
                >
                  <View style={[styles.childMenuAvatar, { backgroundColor: avatar.bg }]}>
                    <Text>{avatar.emoji}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.childMenuName}>{child.name}</Text>
                    {active ? <Text style={styles.childMenuTag}>Currently learning</Text> : null}
                  </View>
                </TouchableOpacity>
              );
            })}
            <TouchableOpacity
              style={styles.childManageBtn}
              onPress={() => {
                setChildMenuVisible(false);
                router.push('/settings/children');
              }}
            >
              <Text style={styles.childManageText}>⚙️ Manage children</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/')}>
          <Text style={styles.tabIcon}>🏠</Text>
          <Text style={[styles.tabLabel, styles.tabLabelActive]}>Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/album')}>
          <Text style={styles.tabIcon}>🏅</Text>
          <Text style={styles.tabLabel}>Album</Text>
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
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollFlex: { flex: 1 },
  bgDecor: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: '#FFF8F0' },
  cloud: { position: 'absolute', backgroundColor: 'white', borderRadius: 99, opacity: 0.85 },
  sun: { position: 'absolute', top: 32, right: 24, width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFD740', opacity: 0.8 },
  ground: { position: 'absolute', bottom: 32, left: 0, right: 0, height: 60, backgroundColor: '#C8E6C9', borderTopLeftRadius: 80, borderTopRightRadius: 120, opacity: 0.5 },
  ground2: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 40, backgroundColor: '#A5D6A7', opacity: 0.45 },
  scrollContent: { alignItems: 'center', paddingTop: 0, paddingHorizontal: 0, paddingBottom: 40, backgroundColor: '#FFF8F0' },

  heroSection: { width: '100%', backgroundColor: '#FFF8F0', paddingHorizontal: 16, paddingTop: 0, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: '#F0E8DC' },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  heroRight: { alignItems: 'flex-end', gap: 6 },
  weekBadge: { backgroundColor: '#F97316', borderRadius: 20, paddingHorizontal: 14, paddingVertical: 4 },
  weekBadgeText: { fontSize: 11, fontWeight: '800', color: 'white', letterSpacing: 0.5 },
  wordCountSmall: { fontSize: 11, color: '#999', fontWeight: '500' },
  childSwitchBtn: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  childSwitchAvatar: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  childSwitchName: { fontSize: 12, color: '#333', fontWeight: '700' },
  mascotRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mascotContainer: {
    alignItems: 'center',
    marginBottom: 4,
    overflow: 'visible',
    paddingBottom: 20,
  },
  mascot: { width: 110, height: 110 },
  speechBubble: { flex: 1, backgroundColor: 'white', borderRadius: 16, borderWidth: 1.5, borderColor: '#F0E0CC', padding: 10 },
  speechMain: { fontSize: 13, fontWeight: '700', color: '#1A1A1A' },
  speechSub: { fontSize: 10, color: '#999', marginTop: 2 },

  cardsRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 14, paddingVertical: 10, width: '100%', maxWidth: 420, alignSelf: 'center', backgroundColor: '#FFF8F0' },
  infoCard: { flex: 1, backgroundColor: '#FFF8F0', borderRadius: 14, padding: 10, borderWidth: 1, borderColor: '#F0E8DC' },
  infoCardTitle: { fontSize: 9, fontWeight: '700', color: '#C45A10', letterSpacing: 0.5, marginBottom: 8 },
  ringWrap: { alignItems: 'center' },
  ringOuter: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#F97316', alignItems: 'center', justifyContent: 'center' },
  ringInner: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#FFF8F0', alignItems: 'center', justifyContent: 'center' },
  ringNum: { fontSize: 13, fontWeight: '800', color: '#1A1A1A' },
  ringSubText: { fontSize: 7, color: '#999', textAlign: 'center' },
  ringTip: { fontSize: 9, color: '#999', textAlign: 'center', marginTop: 5 },
  flowersRow: { flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-end', gap: 2, paddingVertical: 4 },
  flowerEmoji: { fontSize: 18 },

  stepsContainer: { width: '100%', maxWidth: 420, alignSelf: 'center', paddingHorizontal: 14, marginBottom: 20, marginTop: 4 },
  step3DHost: { overflow: 'visible' },
  step3DWrap: { marginBottom: Spacing.sm, paddingBottom: 5 },
  stepShadowBase: {
    position: 'absolute',
    top: 5,
    left: 0,
    right: 0,
    bottom: 0,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.button,
    padding: Spacing.md,
    backgroundColor: Colors.bgWhite,
    borderWidth: 1.5,
    borderColor: Colors.borderLight,
    gap: Spacing.sm,
  },
  stepRowDone: { backgroundColor: Colors.successBg, borderColor: Colors.success },
  stepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#F0E8DC', alignItems: 'center', justifyContent: 'center' },
  stepNumDone: { backgroundColor: Colors.success },
  stepNumText: { fontSize: 10, fontWeight: '800', color: '#C45A10' },
  stepNumTextDone: { color: Colors.bgWhite },
  stepIcon: { fontSize: 18 },
  stepContent: { flex: 1 },
  stepLabel: { fontSize: 8, fontWeight: '700', color: '#bbb', letterSpacing: 0.5, marginBottom: 1 },
  stepTitle: { fontSize: 13, fontWeight: '700', color: '#222' },
  stepTitleDone: { color: '#888' },
  stepDoneText: { fontSize: 11, color: Colors.successDark, fontWeight: '700' },
  stepMain: {
    width: '100%',
    backgroundColor: Colors.primary,
    borderRadius: Radius.large,
    paddingVertical: 15,
    alignItems: 'center',
    ...Shadow.card,
  },
  stepMainDisabled: { backgroundColor: '#E0E0E0', shadowOpacity: 0, elevation: 0 },
  stepMainLabel: { fontSize: 8, fontWeight: '700', color: 'rgba(255,255,255,0.7)', letterSpacing: 0.5, marginBottom: 2 },
  stepMainTitle: { fontSize: FontSize.large, fontWeight: '800', color: Colors.bgWhite },
  stepSecondary: {
    width: '100%',
    backgroundColor: Colors.bgWhite,
    borderRadius: Radius.large,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  stepSecondaryDisabled: {
    borderColor: Colors.primary,
    backgroundColor: Colors.primaryLight,
    opacity: 1,
  },
  stepSecondaryTitle: { fontSize: 14, fontWeight: '700', color: Colors.primaryDark },

  weekSection: { width: '100%', maxWidth: 420, alignSelf: 'center', paddingHorizontal: 14, marginBottom: 12 },
  weekSectionTitle: { fontSize: 9, fontWeight: '700', color: '#bbb', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6 },
  weekChipItem: {
    backgroundColor: '#FFF8F0',
    borderWidth: 1.5,
    borderColor: '#F97316',
    borderRadius: 12,
    padding: 12,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  weekChipItemInactive: {
    backgroundColor: '#FAFAFA',
    borderColor: '#E0E0E0',
  },
  weekChipLeft: {
    flex: 1,
  },
  weekChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#E65100',
  },
  weekChipTextInactive: {
    color: '#999',
  },
  weekChipSub: {
    fontSize: 10,
    color: '#aaa',
    marginTop: 2,
  },
  weekChipArrow: {
    fontSize: 18,
    color: '#F97316',
    fontWeight: '700',
  },
  weekChipArrowInactive: {
    color: '#ccc',
  },

  errorText: { color: '#c00', marginBottom: 8, fontSize: 13 },
  emptyState: { alignItems: 'center', marginBottom: 20, paddingHorizontal: 20 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#1A237E', marginBottom: 6 },
  emptySubtitle: { fontSize: 13, color: '#90A4AE', textAlign: 'center' },
  emptyText: { color: '#888', fontSize: 14, textAlign: 'center', paddingVertical: 12 },
  emptyInline: { color: '#888', fontSize: 14, marginBottom: 4 },
  selectedCard: { width: '100%', maxWidth: 420, borderWidth: 1, borderColor: '#e4e4e4', borderRadius: 16, padding: 12, marginTop: 4, backgroundColor: 'rgba(255,255,255,0.85)', flex: 1 },
  selectedTitle: { fontSize: 16, fontWeight: '700', color: '#333', marginBottom: 8 },
  selectedList: { maxHeight: 160 },
  selectedListContent: { paddingBottom: 10 },
  wordItem: { fontSize: 15, color: '#444', marginBottom: 8 },
  sectionHeading: { fontSize: 14, fontWeight: '800', color: '#555', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 10, marginTop: 2 },
  sectionHeadingAfterWords: { marginTop: 18 },
  selectWeekHint: { color: '#666', fontSize: 14, marginTop: -6, marginBottom: 10 },

  tabBar: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,0.95)', borderTopWidth: 0.5, borderTopColor: '#E0E0E0', paddingBottom: 20, paddingTop: 8 },
  tabItem: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20, marginBottom: 2 },
  tabLabel: { fontSize: 10, color: '#B0BEC5', fontWeight: '500' },
  tabLabelActive: { color: '#F97316', fontWeight: '700' },
  childMenuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingTop: 120,
    paddingHorizontal: 18,
    alignItems: 'flex-end',
  },
  childMenuCard: {
    width: 260,
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#F0E8DC',
    padding: 10,
    gap: 6,
  },
  childMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  childMenuRowActive: {
    backgroundColor: '#FFF3E0',
  },
  childMenuAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  childMenuName: { fontSize: 14, fontWeight: '700', color: '#222' },
  childMenuTag: { fontSize: 11, color: '#F97316', marginTop: 1 },
  childManageBtn: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: '#F0E8DC',
    paddingTop: 8,
  },
  childManageText: { color: '#666', fontSize: 13, fontWeight: '600' },
});