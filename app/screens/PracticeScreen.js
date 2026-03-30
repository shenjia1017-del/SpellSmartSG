import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from 'react-native';

import {
  fetchOpenAITtsAudio,
  graphemeToStoragePath,
  PHONEME_BUCKET,
  PHONEME_TTS_SPEED,
  resolvePhonicsTtsInput,
  splitPhonicsToSyllables,
  TTS_VOICE_PHONEME,
} from '../../lib/phonics';
import { supabase } from '../../lib/supabase';

const BLUE = '#4A90E2';
const GRAY = '#999';
const GRAY_LIGHT = '#e8e8e8';
const DARK_GRAY = '#444';

const KBD_ROW_1 = 'qwertyuiop';
const KBD_ROW_2 = 'asdfghjkl';
const KBD_ROW_3 = 'zxcvbnm';

/** Fallback distractors when the user has fewer than 3 other words in Supabase. */
const FILL_DISTRACTOR_FALLBACK = [
  'happy',
  'quick',
  'little',
  'bright',
  'clever',
  'gentle',
  'family',
  'morning',
];

function blankExampleSentence(example, word) {
  const ex = String(example ?? '').trim();
  const w = String(word ?? '').trim();
  if (!w) return ex || '______';
  if (!ex || ex === '—') {
    return '______';
  }
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'gi');
  const replaced = ex.replace(re, '______');
  if (replaced === ex) {
    return `${ex} ______`;
  }
  return replaced;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

const SUCCESS_SOUND_URI =
  'https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3';

export default function PracticeScreen({ navigation, route }) {
  const word = String(route.params?.word ?? '').trim();
  const practiceWord = String(route.params?.practiceWord ?? word).trim();
  /** Syllable/rhythm splits — Syllables tab ONLY. */
  const practicePhonics = String(route.params?.practicePhonics ?? '').trim();
  /** Phonics sound units — Phonics tab ONLY (never use practicePhonics here). */
  const practiceGraphemes = String(route.params?.practiceGraphemes ?? '').trim();
  const definitions = Array.isArray(route.params?.definitions) ? route.params.definitions : [];
  const exampleSentence = String(
    route.params?.exampleSentence ?? route.params?.example ?? '',
  ).trim();
  const graphemesPronunciation = useMemo(() => {
    const gp = route.params?.graphemesPronunciation;
    if (gp && typeof gp === 'object' && !Array.isArray(gp)) return gp;
    return {};
  }, [route.params?.graphemesPronunciation]);

  const [tab, setTab] = useState('sound');
  const [ttsBusy, setTtsBusy] = useState(false);

  const soundRef = useRef(null);
  const phonemeSoundRef = useRef(null);
  const lastTtsAt = useRef(0);
  const spellingAdvanceTimerRef = useRef(null);
  const fillAdvanceTimerRef = useRef(null);
  /** index (number) → Supabase public URL for phoneme mp3 */
  const phonemeCacheRef = useRef({});

  const sylShake = useRef(new Animated.Value(0)).current;
  const phShake = useRef(new Animated.Value(0)).current;
  const fiShake = useRef(new Animated.Value(0)).current;
  const spShake = useRef(new Animated.Value(0)).current;
  const sylFlash = useRef(new Animated.Value(0)).current;
  const phFlash = useRef(new Animated.Value(0)).current;
  const spFlash = useRef(new Animated.Value(0)).current;

  const [sylSlots, setSylSlots] = useState([]);
  const [sylPool, setSylPool] = useState([]);

  const [phSlots, setPhSlots] = useState([]);
  const [phPool, setPhPool] = useState([]);

  const [spellSlots, setSpellSlots] = useState([]);
  const [spellInventory, setSpellInventory] = useState({});

  const [spellingDone, setSpellingDone] = useState(false);

  const [fillInChoices, setFillInChoices] = useState([]);
  const [fillInLoading, setFillInLoading] = useState(false);
  const [fillInCorrect, setFillInCorrect] = useState(false);
  const [fillInWrongIndex, setFillInWrongIndex] = useState(null);

  /** Phonics tab tiles: ONLY `practiceGraphemes`, split by "•". */
  const phonicsGroups = useMemo(
    () => splitPhonicsToSyllables(practiceGraphemes),
    [practiceGraphemes],
  );

  const blankedExample = useMemo(
    () => blankExampleSentence(exampleSentence, practiceWord),
    [exampleSentence, practiceWord],
  );

  const loadFillInChoices = useCallback(async () => {
    setFillInLoading(true);
    try {
      const pw = practiceWord.trim();
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      let pool = [];
      if (userId) {
        const { data, error } = await supabase.from('words').select('word').eq('user_id', userId);
        if (!error && Array.isArray(data)) {
          pool = [
            ...new Set(
              data
                .map((r) => String(r.word ?? '').trim())
                .filter((w) => w && w.toLowerCase() !== pw.toLowerCase()),
            ),
          ];
        }
      }
      const shuffledPool = shuffleArray(pool);
      const distractors = [];
      for (const w of shuffledPool) {
        if (distractors.length >= 3) break;
        if (!distractors.some((d) => d.toLowerCase() === w.toLowerCase())) distractors.push(w);
      }
      let fb = 0;
      while (distractors.length < 3 && fb < FILL_DISTRACTOR_FALLBACK.length) {
        const w = FILL_DISTRACTOR_FALLBACK[fb];
        fb += 1;
        if (w.toLowerCase() === pw.toLowerCase()) continue;
        if (distractors.some((d) => d.toLowerCase() === w.toLowerCase())) continue;
        distractors.push(w);
      }
      while (distractors.length < 3) {
        distractors.push(`choice${distractors.length}`);
      }
      setFillInChoices(shuffleArray([pw, ...distractors.slice(0, 3)]));
    } finally {
      setFillInLoading(false);
    }
  }, [practiceWord]);

  useEffect(() => {
    if (tab !== 'fill') return;
    setFillInCorrect(false);
    setFillInWrongIndex(null);
    void loadFillInChoices();
  }, [tab, practiceWord, loadFillInChoices]);

  useEffect(() => {
    if (tab === 'fill') return;
    if (fillAdvanceTimerRef.current) {
      clearTimeout(fillAdvanceTimerRef.current);
      fillAdvanceTimerRef.current = null;
    }
  }, [tab]);

  useEffect(() => {
    console.log('[Practice] practicePhonics (syllables):', practicePhonics);
    console.log('[Practice] practiceGraphemes (phonics):', practiceGraphemes);
    console.log(
      '[Practice] breakdowns differ?',
      practicePhonics.replace(/\s/g, '') !== practiceGraphemes.replace(/\s/g, ''),
    );
  }, [practiceWord, practicePhonics, practiceGraphemes]);

  useEffect(() => {
    void Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      allowsRecordingIOS: false,
      staysActiveInBackground: false,
    });
  }, []);

  const unloadSound = useCallback(async () => {
    if (soundRef.current) {
      try {
        await soundRef.current.unloadAsync();
      } catch {
        // ignore
      }
      soundRef.current = null;
    }
  }, []);

  const unloadPhonemeSound = useCallback(async () => {
    if (phonemeSoundRef.current) {
      try {
        await phonemeSoundRef.current.unloadAsync();
      } catch {
        // ignore
      }
      phonemeSoundRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      unloadSound();
      unloadPhonemeSound();
      if (spellingAdvanceTimerRef.current) {
        clearTimeout(spellingAdvanceTimerRef.current);
        spellingAdvanceTimerRef.current = null;
      }
      if (fillAdvanceTimerRef.current) {
        clearTimeout(fillAdvanceTimerRef.current);
        fillAdvanceTimerRef.current = null;
      }
    };
  }, [unloadSound, unloadPhonemeSound]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerShown: false,
      title: 'Practice',
    });
  }, [navigation]);

  const resetSyllables = useCallback(() => {
    const list = splitPhonicsToSyllables(practicePhonics).length
      ? splitPhonicsToSyllables(practicePhonics)
      : practiceWord
        ? [practiceWord]
        : [];
    const pool = list.map((text, i) => ({
      id: `syl-${i}-${text}`,
      text,
      placed: false,
    }));
    setSylSlots(Array(list.length).fill(null));
    setSylPool(shuffleArray(pool));
  }, [practicePhonics, practiceWord]);

  const resetPhonics = useCallback(() => {
    const gr = splitPhonicsToSyllables(practiceGraphemes);
    if (gr.length === 0) {
      setPhSlots([]);
      setPhPool([]);
      return;
    }
    const pool = gr.map((text, i) => ({
      id: `gr-${i}-${text}`,
      text,
      placed: false,
    }));
    setPhSlots(Array(gr.length).fill(null));
    setPhPool(shuffleArray(pool));
  }, [practiceGraphemes]);

  const resetSpelling = useCallback(() => {
    const w = practiceWord.toLowerCase();
    const inv = {};
    for (const ch of w) {
      inv[ch] = (inv[ch] || 0) + 1;
    }
    setSpellSlots(Array(practiceWord.length).fill(null));
    setSpellInventory(inv);
    setSpellingDone(false);
  }, [practiceWord]);

  useEffect(() => {
    if (!practiceWord) return;
    resetSyllables();
    resetPhonics();
    resetSpelling();
  }, [practiceWord, practicePhonics, practiceGraphemes, resetSyllables, resetPhonics, resetSpelling]);

  useEffect(() => {
    phonemeCacheRef.current = {};
    if (!practiceWord || phonicsGroups.length === 0) return;
    const next = {};
    phonicsGroups.forEach((gr, i) => {
      const resolved = resolvePhonicsTtsInput(gr, graphemesPronunciation);
      const path = graphemeToStoragePath(gr, resolved);
      const { data } = supabase.storage.from(PHONEME_BUCKET).getPublicUrl(path);
      if (data?.publicUrl) {
        next[i] = data.publicUrl;
      }
    });
    phonemeCacheRef.current = next;
  }, [practiceWord, phonicsGroups, graphemesPronunciation]);

  const playTts = async (text, options = {}) => {
    const { speed, voice, language } = options;
    if (!text || ttsBusy) return;
    const now = Date.now();
    if (now - lastTtsAt.current < 400) return;
    lastTtsAt.current = Date.now();
    setTtsBusy(true);
    try {
      await unloadSound();
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const ttsOpts = {};
      if (speed != null) ttsOpts.speed = speed;
      if (voice != null) ttsOpts.voice = voice;
      if (language != null) ttsOpts.language = language;
      const base64 = await fetchOpenAITtsAudio(text, ttsOpts);
      const dir = FileSystem.cacheDirectory;
      if (!dir) throw new Error('No cache dir');
      const uri = `${dir}tts-${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(uri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const { sound } = await Audio.Sound.createAsync({ uri });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.isLoaded && s.didJustFinish) {
          setTtsBusy(false);
        }
      });
      await sound.playAsync();
    } catch {
      setTtsBusy(false);
    }
  };

  const playSuccessSound = async () => {
    try {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await unloadSound();
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const { sound } = await Audio.Sound.createAsync(
        { uri: SUCCESS_SOUND_URI },
        { shouldPlay: true, volume: 0.6 },
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.isLoaded && s.didJustFinish) {
          sound.unloadAsync().catch(() => {});
        }
      });
    } catch {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  };

  const runShake = (anim) => {
    anim.setValue(0);
    Animated.sequence([
      Animated.timing(anim, { toValue: 12, duration: 60, useNativeDriver: true }),
      Animated.timing(anim, { toValue: -12, duration: 60, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 10, duration: 60, useNativeDriver: true }),
      Animated.timing(anim, { toValue: -10, duration: 60, useNativeDriver: true }),
      Animated.timing(anim, { toValue: 0, duration: 60, useNativeDriver: true }),
    ]).start();
  };

  const runGreenFlash = (anim, onDone) => {
    anim.setValue(1);
    Animated.sequence([
      Animated.timing(anim, { toValue: 0, duration: 600, useNativeDriver: false }),
    ]).start(() => onDone && onDone());
  };

  const onSylPoolTap = (item) => {
    if (item.placed) return;
    const idx = sylSlots.findIndex((s) => s == null);
    if (idx === -1) return;
    setSylPool((p) => p.map((x) => (x.id === item.id ? { ...x, placed: true } : x)));
    setSylSlots((s) => {
      const n = [...s];
      n[idx] = { id: item.id, text: item.text };
      return n;
    });
  };

  const onSylSlotTap = (idx) => {
    const slot = sylSlots[idx];
    if (!slot) return;
    setSylPool((p) => p.map((x) => (x.id === slot.id ? { ...x, placed: false } : x)));
    setSylSlots((s) => {
      const n = [...s];
      n[idx] = null;
      return n;
    });
  };

  const checkSyllables = () => {
    if (!sylSlots.every(Boolean)) return;
    const parts = splitPhonicsToSyllables(practicePhonics);
    const expected =
      parts.length > 0 ? parts.map((s) => s.toLowerCase()) : [practiceWord.toLowerCase()];
    const got = sylSlots.map((s) => s.text.toLowerCase());
    const ok =
      got.length === expected.length && got.every((g, i) => g === expected[i]);
    if (ok) {
      playSuccessSound();
      runGreenFlash(sylFlash, () => {
        setTimeout(() => setTab('phonics'), 1000);
      });
    } else {
      runShake(sylShake);
      resetSyllables();
    }
  };

  const onPhPoolTap = (item) => {
    if (item.placed) return;
    const idx = phSlots.findIndex((s) => s == null);
    if (idx === -1) return;
    setPhPool((p) => p.map((x) => (x.id === item.id ? { ...x, placed: true } : x)));
    setPhSlots((s) => {
      const n = [...s];
      n[idx] = { id: item.id, text: item.text };
      return n;
    });
  };

  const onPhSlotTap = (idx) => {
    const slot = phSlots[idx];
    if (!slot) return;
    setPhPool((p) => p.map((x) => (x.id === slot.id ? { ...x, placed: false } : x)));
    setPhSlots((s) => {
      const n = [...s];
      n[idx] = null;
      return n;
    });
  };

  const playPhonemeLiveTts = async (phonicsInput) => {
    await unloadPhonemeSound();
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    });
    const base64 = await fetchOpenAITtsAudio(phonicsInput, {
      speed: PHONEME_TTS_SPEED,
      voice: TTS_VOICE_PHONEME,
    });
    const dir = FileSystem.cacheDirectory;
    if (!dir) throw new Error('No cache dir');
    const uri = `${dir}tts-phoneme-${Date.now()}.mp3`;
    await FileSystem.writeAsStringAsync(uri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const { sound } = await Audio.Sound.createAsync({ uri });
    phonemeSoundRef.current = sound;
    await sound.playAsync();
  };

  const playPhonemeSoundAtIndex = async (index) => {
    const raw = phonicsGroups[index] ?? '';
    const phonicsInput = resolvePhonicsTtsInput(raw, graphemesPronunciation) || raw || 'uh';

    const cachedUri = phonemeCacheRef.current[index];
    try {
      await unloadPhonemeSound();
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      if (cachedUri) {
        try {
          const { sound } = await Audio.Sound.createAsync({ uri: cachedUri });
          phonemeSoundRef.current = sound;
          await sound.playAsync();
          return;
        } catch {
          // fall through to live TTS
        }
      }
      await playPhonemeLiveTts(phonicsInput);
    } catch {
      await playPhonemeLiveTts(phonicsInput).catch(() => {});
    }
  };

  const checkPhonics = () => {
    if (!phSlots.every(Boolean)) return;
    const built = phSlots.map((s) => s.text).join('');
    if (built.toLowerCase() === practiceWord.toLowerCase()) {
      playSuccessSound();
      runGreenFlash(phFlash, () => {
        setTimeout(() => setTab('fill'), 1000);
      });
    } else {
      runShake(phShake);
      resetPhonics();
    }
  };

  const playKeyboardClick = useCallback(() => {
    Vibration.vibrate(10);
  }, []);

  const onSpellKey = async (char) => {
    if (spellingDone) return;
    const idx = spellSlots.findIndex((s) => s == null);
    if (idx === -1) return;
    const inv = { ...spellInventory };
    if (!inv[char]) return;
    playKeyboardClick();
    inv[char] -= 1;
    setSpellInventory(inv);
    setSpellSlots((s) => {
      const n = [...s];
      n[idx] = char;
      return n;
    });
  };

  const onSpellBackspace = async () => {
    if (spellingDone) return;
    let last = -1;
    for (let i = spellSlots.length - 1; i >= 0; i -= 1) {
      if (spellSlots[i] != null) {
        last = i;
        break;
      }
    }
    if (last < 0) return;
    playKeyboardClick();
    const ch = spellSlots[last];
    const inv = { ...spellInventory };
    inv[ch] = (inv[ch] || 0) + 1;
    setSpellInventory(inv);
    setSpellSlots((s) => {
      const n = [...s];
      n[last] = null;
      return n;
    });
  };

  const goLearnNextWord = useCallback(() => {
    navigation.navigate('Learn', { advanceToNextWord: true });
  }, [navigation]);

  const checkSpelling = () => {
    if (spellSlots.some((x) => x == null)) return;
    const built = spellSlots.join('');
    if (built === practiceWord.toLowerCase()) {
      playSuccessSound();
      runGreenFlash(spFlash, () => {});
      setSpellingDone(true);
      if (spellingAdvanceTimerRef.current) clearTimeout(spellingAdvanceTimerRef.current);
      spellingAdvanceTimerRef.current = setTimeout(() => {
        spellingAdvanceTimerRef.current = null;
        goLearnNextWord();
      }, 1400);
    } else {
      runShake(spShake);
      resetSpelling();
    }
  };

  const goBackLearn = () => {
    navigation.goBack();
  };

  const onFillInChoicePress = (choice, index) => {
    if (fillInCorrect) return;
    if (String(choice).toLowerCase() === practiceWord.toLowerCase()) {
      setFillInCorrect(true);
      playSuccessSound();
      if (fillAdvanceTimerRef.current) clearTimeout(fillAdvanceTimerRef.current);
      fillAdvanceTimerRef.current = setTimeout(() => {
        fillAdvanceTimerRef.current = null;
        setTab('spelling');
      }, 1000);
    } else {
      setFillInWrongIndex(index);
      runShake(fiShake);
      setTimeout(() => setFillInWrongIndex(null), 750);
    }
  };

  const onFooterSkip = () => {
    if (tab === 'syllables') {
      setTab('phonics');
    } else if (tab === 'phonics') {
      setTab('fill');
    } else if (tab === 'fill') {
      setTab('spelling');
    } else {
      goLearnNextWord();
    }
  };

  const typeLabel = (t) => t.charAt(0).toUpperCase() + t.slice(1);

  const canCheckSyl = sylPool.every((x) => x.placed) && sylSlots.length > 0;
  const canCheckPh =
    phonicsGroups.length > 0 && phPool.every((x) => x.placed) && phSlots.length > 0;
  const canCheckSp = !spellSlots.some((x) => x == null) && practiceWord.length > 0;

  const showCheckButton =
    !spellingDone && tab !== 'sound' && tab !== 'fill';

  if (!practiceWord) {
    return (
      <View style={[styles.root, styles.centered]}>
        <Text style={styles.missText}>Missing data. Go back and try again.</Text>
        <TouchableOpacity onPress={goBackLearn}>
          <Text style={styles.backLink}>← Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const flashBg = (anim) =>
    anim.interpolate({
      inputRange: [0, 1],
      outputRange: ['transparent', 'rgba(126, 211, 33, 0.35)'],
    });

  return (
    <View style={styles.root}>
      <View style={styles.headerBar}>
        <TouchableOpacity style={styles.headerBack} onPress={goBackLearn} hitSlop={12}>
          <Text style={styles.headerBackText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Practice</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.tabRow}>
        {[
          { key: 'sound', label: 'Sound It Out' },
          { key: 'syllables', label: 'Syllables' },
          { key: 'phonics', label: 'Phonics' },
          { key: 'fill', label: 'Fill In' },
          { key: 'spelling', label: 'Spelling' },
        ].map(({ key, label }) => (
          <TouchableOpacity key={key} style={styles.tabCell} onPress={() => setTab(key)}>
            <Text
              style={[styles.tabLabel, tab === key ? styles.tabLabelOn : styles.tabLabelOff]}
              numberOfLines={2}
              adjustsFontSizeToFit
              minimumFontScale={0.65}
            >
              {label}
            </Text>
            {tab === key ? <View style={styles.tabUnderline} /> : <View style={styles.tabUnderlineHidden} />}
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollInner} keyboardShouldPersistTaps="handled">
        <TouchableOpacity style={styles.playBtn} onPress={() => playTts(practiceWord)} disabled={ttsBusy}>
          {ttsBusy ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.playBtnText}>🔊 Play pronunciation</Text>
          )}
        </TouchableOpacity>

        <View style={styles.defBox}>
          {definitions.length === 0 ? (
            <Text style={styles.defEmpty}>No dictionary hints for this entry.</Text>
          ) : (
            definitions.map((d, i) => (
              <View key={`${d.type}-${i}`} style={styles.defBlock}>
                <Text style={styles.defType}>{typeLabel(d.type)}</Text>
                <Text style={styles.defMeaning}>{d.meaning}</Text>
              </View>
            ))
          )}
        </View>

        {tab === 'sound' ? (
          phonicsGroups.length === 0 ? (
            <View style={styles.section}>
              <Text style={styles.phonicsMissingText}>
                Sound blocks are missing (practiceGraphemes was not loaded). Go back to Learn and open this word
                again, or continue to Syllables.
              </Text>
              <TouchableOpacity style={styles.phonicsSkipBtn} onPress={() => setTab('syllables')}>
                <Text style={styles.phonicsSkipBtnText}>Continue to Syllables →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.section}>
              <Text style={styles.sectionHint}>Tap each sound block to hear it</Text>
              <View style={styles.soundCardWrap}>
                {phonicsGroups.map((gr, i) => {
                  const pronSmall =
                    resolvePhonicsTtsInput(gr, graphemesPronunciation) || gr;
                  return (
                    <TouchableOpacity
                      key={`sound-${i}-${gr}`}
                      style={styles.soundCard}
                      onPress={() => void playPhonemeSoundAtIndex(i)}
                      activeOpacity={0.75}
                    >
                      <Text style={styles.soundCardGrapheme}>{gr}</Text>
                      <Text style={styles.soundCardPron} numberOfLines={2}>
                        {pronSmall}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.soundNavRow}>
                <TouchableOpacity style={styles.soundNextBtn} onPress={() => setTab('syllables')}>
                  <Text style={styles.soundNextBtnText}>Next →</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.soundSkipBtn} onPress={() => setTab('phonics')}>
                  <Text style={styles.soundSkipBtnText}>Skip →</Text>
                </TouchableOpacity>
              </View>
            </View>
          )
        ) : null}

        {tab === 'syllables' ? (
          <View style={styles.section}>
            <Text style={styles.sectionHint}>Build the word from syllables. Tap a slot to return a tile.</Text>
            <Animated.View style={{ transform: [{ translateX: sylShake }] }}>
              <Animated.View
                style={[
                  styles.slotWrap,
                  { backgroundColor: flashBg(sylFlash) },
                ]}
              >
                <View style={styles.slotRow}>
                {sylSlots.map((slot, idx) => (
                  <TouchableOpacity
                    key={`syl-${idx}`}
                    style={[styles.sylSlot, slot && styles.sylSlotFilled]}
                    onPress={() => onSylSlotTap(idx)}
                  >
                    <Text style={styles.slotText}>{slot ? slot.text : ''}</Text>
                  </TouchableOpacity>
                ))}
                </View>
              </Animated.View>
            </Animated.View>
            <View style={styles.tileWrap}>
              {sylPool.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.tile, item.placed && styles.tileGhost]}
                  onPress={() => onSylPoolTap(item)}
                  disabled={item.placed}
                >
                  <Text style={[styles.tileText, item.placed && styles.tileTextGhost]}>{item.text}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        ) : null}

        {tab === 'phonics' ? (
          phonicsGroups.length === 0 ? (
            <View style={styles.section}>
              <Text style={styles.phonicsMissingText}>
                Phonics groups are missing (practiceGraphemes was not loaded). Go back to Learn and open this word
                again, or continue to Spelling.
              </Text>
              <TouchableOpacity style={styles.phonicsSkipBtn} onPress={() => setTab('fill')}>
                <Text style={styles.phonicsSkipBtnText}>Continue to Fill In →</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.section}>
              <Text style={styles.sectionHint}>
                Build with the phonics groups from your card. Tap an empty box to hear that group. Tap a filled
                box to put the tile back.
              </Text>
              <Animated.View style={{ transform: [{ translateX: phShake }] }}>
                <Animated.View style={[styles.slotWrap, { backgroundColor: flashBg(phFlash) }]}>
                  <View style={styles.phSlotRow}>
                    {phSlots.map((slot, idx) => (
                      <Pressable
                        key={`ph-${idx}`}
                        style={({ pressed }) => [
                          styles.phBox,
                          slot ? styles.phBoxFilled : styles.phBoxEmpty,
                          pressed && styles.phBoxPressed,
                        ]}
                        onPress={() => {
                          if (slot) {
                            onPhSlotTap(idx);
                          } else {
                            void playPhonemeSoundAtIndex(idx);
                          }
                        }}
                      >
                        <Text style={styles.slotText}>{slot ? slot.text : ''}</Text>
                      </Pressable>
                    ))}
                  </View>
                </Animated.View>
              </Animated.View>
              <View style={styles.tileWrap}>
                {phPool.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={[styles.tile, item.placed && styles.tileGhost]}
                    onPress={() => onPhPoolTap(item)}
                    disabled={item.placed}
                  >
                    <Text style={[styles.tileText, item.placed && styles.tileTextGhost]}>{item.text}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )
        ) : null}

        {tab === 'fill' ? (
          <View style={styles.section}>
            <Text style={styles.sectionHint}>Choose the word that fits the sentence</Text>
            <Text style={styles.fillSentence}>{blankedExample}</Text>
            {fillInLoading ? (
              <ActivityIndicator style={{ marginVertical: 16 }} color={BLUE} />
            ) : (
              <Animated.View style={{ transform: [{ translateX: fiShake }] }}>
                <View style={styles.fillOptionsWrap}>
                  {fillInChoices.map((choice, idx) => {
                    const correct =
                      fillInCorrect &&
                      String(choice).toLowerCase() === practiceWord.toLowerCase();
                    const wrong = fillInWrongIndex === idx;
                    return (
                      <TouchableOpacity
                        key={`fill-${idx}-${choice}`}
                        style={[
                          styles.fillOptionCard,
                          correct && styles.fillOptionCorrect,
                          wrong && styles.fillOptionWrong,
                        ]}
                        onPress={() => onFillInChoicePress(choice, idx)}
                        disabled={fillInCorrect}
                        activeOpacity={0.75}
                      >
                        <Text style={styles.fillOptionText}>{choice}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </Animated.View>
            )}
            {fillInCorrect ? (
              <Text style={styles.fillCorrectText}>Correct!</Text>
            ) : null}
          </View>
        ) : null}

        {tab === 'spelling' ? (
          <View style={styles.section}>
            <Text style={styles.sectionHint}>Type the word with the keyboard. Backspace removes the last letter.</Text>
            <Animated.View style={{ transform: [{ translateX: spShake }] }}>
              <Animated.View style={[styles.slotWrap, { backgroundColor: flashBg(spFlash) }]}>
                <View style={styles.spellRow}>
                {spellSlots.map((ch, idx) => (
                  <View key={`sp-${idx}`} style={[styles.spellBox, ch && styles.spellBoxFilled]}>
                    <Text style={styles.spellBoxText}>{ch ?? ''}</Text>
                  </View>
                ))}
                </View>
              </Animated.View>
            </Animated.View>

            <View style={styles.kbdShell}>
              <View style={styles.kbdRow}>
                {KBD_ROW_1.split('').map((keyChar) => {
                  const c = keyChar.toLowerCase();
                  const enabled = (spellInventory[c] || 0) > 0 && !spellingDone;
                  return (
                    <TouchableOpacity
                      key={`r1-${keyChar}`}
                      style={[styles.kbdKey, enabled ? styles.kbdKeyOn : styles.kbdKeyOff]}
                      onPress={() => {
                        void onSpellKey(c);
                      }}
                      disabled={!enabled}
                      activeOpacity={0.65}
                    >
                      <Text style={[styles.kbdKeyText, enabled ? styles.kbdKeyTextOn : styles.kbdKeyTextOff]}>
                        {keyChar.toLowerCase()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={styles.kbdRow}>
                {KBD_ROW_2.split('').map((keyChar) => {
                  const c = keyChar.toLowerCase();
                  const enabled = (spellInventory[c] || 0) > 0 && !spellingDone;
                  return (
                    <TouchableOpacity
                      key={`r2-${keyChar}`}
                      style={[styles.kbdKey, enabled ? styles.kbdKeyOn : styles.kbdKeyOff]}
                      onPress={() => {
                        void onSpellKey(c);
                      }}
                      disabled={!enabled}
                      activeOpacity={0.65}
                    >
                      <Text style={[styles.kbdKeyText, enabled ? styles.kbdKeyTextOn : styles.kbdKeyTextOff]}>
                        {keyChar.toLowerCase()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <View style={[styles.kbdRow, styles.kbdRowLast]}>
                {KBD_ROW_3.split('').map((keyChar) => {
                  const c = keyChar.toLowerCase();
                  const enabled = (spellInventory[c] || 0) > 0 && !spellingDone;
                  return (
                    <TouchableOpacity
                      key={`r3-${keyChar}`}
                      style={[styles.kbdKey, enabled ? styles.kbdKeyOn : styles.kbdKeyOff]}
                      onPress={() => {
                        void onSpellKey(c);
                      }}
                      disabled={!enabled}
                      activeOpacity={0.65}
                    >
                      <Text style={[styles.kbdKeyText, enabled ? styles.kbdKeyTextOn : styles.kbdKeyTextOff]}>
                        {keyChar.toLowerCase()}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity
                  style={styles.kbdBackspace}
                  onPress={() => {
                    void onSpellBackspace();
                  }}
                  disabled={spellingDone}
                  activeOpacity={0.65}
                >
                  <Text style={styles.kbdBackspaceText}>⌫</Text>
                </TouchableOpacity>
              </View>
            </View>

            {spellingDone ? (
              <View style={styles.doneBox}>
                <Text style={styles.doneText}>Well done! 🎉</Text>
                <Text style={styles.doneSub}>Loading next word…</Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {showCheckButton ? (
          <TouchableOpacity
            style={[
              styles.checkBtn,
              !(tab === 'syllables' ? canCheckSyl : tab === 'phonics' ? canCheckPh : canCheckSp) &&
                styles.checkBtnOff,
            ]}
            onPress={() => {
              if (tab === 'syllables') checkSyllables();
              else if (tab === 'phonics') checkPhonics();
              else checkSpelling();
            }}
            disabled={!(tab === 'syllables' ? canCheckSyl : tab === 'phonics' ? canCheckPh : canCheckSp)}
          >
            <Text style={styles.checkBtnText}>Check</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      {!spellingDone && tab !== 'sound' ? (
        <View style={styles.footer}>
          <TouchableOpacity style={styles.skipBtn} onPress={onFooterSkip}>
            <Text style={styles.skipBtnText}>I&apos;m not sure — Skip</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 48,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  missText: {
    color: GRAY,
    marginBottom: 16,
  },
  backLink: {
    color: BLUE,
    fontSize: 16,
    fontWeight: '600',
  },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: BLUE,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  headerBack: {
    width: 88,
  },
  headerBackText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  headerSpacer: {
    width: 88,
  },
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: GRAY_LIGHT,
  },
  tabCell: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 12,
    paddingBottom: 4,
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  tabLabelOn: {
    color: BLUE,
  },
  tabLabelOff: {
    color: GRAY,
  },
  tabUnderline: {
    height: 3,
    width: '70%',
    backgroundColor: BLUE,
    borderRadius: 2,
  },
  tabUnderlineHidden: {
    height: 3,
    width: '70%',
  },
  scroll: {
    flex: 1,
  },
  scrollInner: {
    padding: 16,
    paddingBottom: 24,
  },
  playBtn: {
    backgroundColor: BLUE,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  playBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  defBox: {
    borderWidth: 1,
    borderColor: GRAY_LIGHT,
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    backgroundColor: '#fafafa',
  },
  defEmpty: {
    color: GRAY,
    fontSize: 14,
  },
  defBlock: {
    marginBottom: 14,
  },
  defType: {
    color: BLUE,
    fontWeight: '800',
    fontSize: 15,
    marginBottom: 4,
  },
  defMeaning: {
    color: DARK_GRAY,
    fontSize: 15,
    lineHeight: 22,
  },
  section: {
    marginBottom: 8,
  },
  sectionHint: {
    color: GRAY,
    fontSize: 13,
    marginBottom: 12,
    lineHeight: 18,
  },
  phonicsMissingText: {
    color: DARK_GRAY,
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 16,
  },
  phonicsSkipBtn: {
    alignSelf: 'flex-start',
    backgroundColor: BLUE,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
  },
  phonicsSkipBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  soundCardWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
  },
  soundCard: {
    minWidth: 76,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: BLUE,
    backgroundColor: '#E8F4FD',
    alignItems: 'center',
    justifyContent: 'center',
  },
  soundCardGrapheme: {
    fontSize: 17,
    fontWeight: '800',
    color: BLUE,
    marginBottom: 6,
    textAlign: 'center',
  },
  soundCardPron: {
    fontSize: 12,
    fontWeight: '600',
    color: GRAY,
    textAlign: 'center',
  },
  soundNavRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  soundNextBtn: {
    backgroundColor: BLUE,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
  },
  soundNextBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
  },
  soundSkipBtn: {
    borderWidth: 2,
    borderColor: GRAY,
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 12,
    backgroundColor: '#fff',
  },
  soundSkipBtnText: {
    color: GRAY,
    fontSize: 16,
    fontWeight: '700',
  },
  fillSentence: {
    fontSize: 16,
    lineHeight: 24,
    color: DARK_GRAY,
    marginBottom: 16,
    fontWeight: '600',
  },
  fillOptionsWrap: {
    gap: 10,
    marginBottom: 8,
  },
  fillOptionCard: {
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: '#fff',
  },
  fillOptionCorrect: {
    borderColor: '#2d7a16',
    backgroundColor: 'rgba(126, 211, 33, 0.2)',
  },
  fillOptionWrong: {
    borderColor: '#c00',
    backgroundColor: 'rgba(200, 0, 0, 0.08)',
  },
  fillOptionText: {
    fontSize: 17,
    fontWeight: '700',
    color: DARK_GRAY,
    textAlign: 'center',
  },
  fillCorrectText: {
    marginTop: 12,
    fontSize: 20,
    fontWeight: '800',
    color: '#2d7a16',
    textAlign: 'center',
  },
  slotWrap: {
    borderRadius: 12,
    padding: 8,
    marginBottom: 16,
  },
  slotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  sylSlot: {
    minWidth: 72,
    minHeight: 48,
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 8,
    backgroundColor: '#fff',
  },
  sylSlotFilled: {
    backgroundColor: '#E8F4FD',
  },
  slotText: {
    fontSize: 16,
    fontWeight: '700',
    color: DARK_GRAY,
  },
  tileWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tile: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: BLUE,
    backgroundColor: '#E8F4FD',
  },
  tileGhost: {
    opacity: 0.38,
    borderColor: GRAY_LIGHT,
  },
  tileText: {
    fontWeight: '800',
    color: BLUE,
    fontSize: 16,
  },
  tileTextGhost: {
    color: GRAY,
  },
  phSlotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  phBox: {
    minWidth: 40,
    minHeight: 48,
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  phBoxEmpty: {
    backgroundColor: '#fff',
  },
  phBoxFilled: {
    backgroundColor: '#E8F4FD',
  },
  phBoxPressed: {
    opacity: 0.85,
  },
  spellRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    justifyContent: 'center',
  },
  spellBox: {
    width: 34,
    height: 46,
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  spellBoxFilled: {
    backgroundColor: '#E8F4FD',
  },
  spellBoxText: {
    fontSize: 18,
    fontWeight: '800',
    color: DARK_GRAY,
  },
  kbdShell: {
    marginTop: 12,
    backgroundColor: '#c4c6ca',
    borderRadius: 12,
    paddingTop: 10,
    paddingBottom: 12,
    paddingHorizontal: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#a8aaae',
  },
  kbdRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    gap: 5,
  },
  kbdRowLast: {
    marginBottom: 0,
    justifyContent: 'center',
  },
  kbdKey: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 28,
    minWidth: 24,
    maxWidth: 36,
    height: 42,
    borderRadius: 6,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.12,
    shadowRadius: 0,
    elevation: 1,
  },
  kbdKeyOn: {
    backgroundColor: '#fcfcfe',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8e8e93',
  },
  kbdKeyOff: {
    backgroundColor: '#7c7f84',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#6a6d72',
  },
  kbdKeyText: {
    fontSize: 17,
    fontWeight: '500',
  },
  kbdKeyTextOn: {
    color: '#000',
  },
  kbdKeyTextOff: {
    color: '#c7c7cc',
  },
  kbdBackspace: {
    minWidth: 52,
    width: 52,
    height: 42,
    borderRadius: 6,
    backgroundColor: DARK_GRAY,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 0,
    elevation: 1,
  },
  kbdBackspaceText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  checkBtn: {
    marginTop: 20,
    backgroundColor: BLUE,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  checkBtnOff: {
    opacity: 0.45,
  },
  checkBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
  },
  doneBox: {
    marginTop: 20,
    alignItems: 'center',
  },
  doneText: {
    fontSize: 22,
    fontWeight: '800',
    color: '#2d7a16',
    marginBottom: 8,
  },
  doneSub: {
    fontSize: 14,
    color: GRAY,
    fontWeight: '600',
  },
  footer: {
    padding: 16,
    paddingBottom: 28,
    borderTopWidth: 1,
    borderTopColor: GRAY_LIGHT,
  },
  skipBtn: {
    borderWidth: 2,
    borderColor: GRAY,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  skipBtnText: {
    color: GRAY,
    fontSize: 15,
    fontWeight: '700',
  },
});
