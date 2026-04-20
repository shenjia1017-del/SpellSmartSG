import * as Haptics from 'expo-haptics';
import { useNavigation } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
  TTS_VOICE_PHONEME,
} from '../../lib/phonics';
import { supabase } from '../../lib/supabase';

const BLUE = '#F97316';
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

/**
 * Phonics tab: spaces separate words; • / | / ｜ separate graphemes within a word.
 * Returns a flat array of grapheme strings only (no spacer entries).
 */
function parsePhonicsFlatPattern(graphemesStr) {
  if (!graphemesStr || graphemesStr === '-' || graphemesStr === '—') return [];
  return graphemesStr
    .trim()
    .split(/\s+/)
    .flatMap((word) => word.split(/[•|\uFF5C|]/).map((s) => s.trim()).filter(Boolean));
}

/**
 * Syllables tab: spaces separate words; • / | / ｜ separate syllables within a word.
 * Returns a flat array of syllable strings only (no spacer entries).
 * Example: "rep•ri•man•ded se•vere•ly" → ["rep","ri","man","ded","se","vere","ly"]
 */
function parseSyllablesTabPattern(syllablesStr) {
  if (!syllablesStr || syllablesStr === '-' || syllablesStr === '—') return [];
  return syllablesStr
    .trim()
    .split(/\s+/)
    .flatMap((word) => word.split(/[•|\uFF5C|]/).map((s) => s.trim()).filter(Boolean));
}

function syllablesTileList(syllablesStr, practiceWordFallback) {
  const flat = parseSyllablesTabPattern(syllablesStr);
  if (flat.length > 0) return flat;
  const w = String(practiceWordFallback ?? '').trim();
  if (!w) return [];
  return w.split(/\s+/).filter(Boolean);
}

function parseWordUnitGroups(inputStr) {
  const s = String(inputStr ?? '').trim();
  if (!s || s === '-' || s === '—') return [];
  return s
    .split(/\s+/)
    .map((word) => word.split(/[•|\uFF5C|]/).map((u) => u.trim()).filter(Boolean))
    .filter((group) => group.length > 0);
}

// Phonics tab uses dedicated state initialization effect below.

function parseTileIndex(id) {
  const m = String(id ?? '').match(/-(\d+)-/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]);
}

function groupPoolByWordGroups(pool, wordGroups) {
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const counts = wordGroups.map((g) => g.length).filter((n) => n > 0);
  if (counts.length === 0) return [pool];
  const ordered = [...pool].sort((a, b) => parseTileIndex(a.id) - parseTileIndex(b.id));
  const out = [];
  let cursor = 0;
  counts.forEach((count) => {
    const chunk = ordered.slice(cursor, cursor + count);
    if (chunk.length > 0) out.push(chunk);
    cursor += count;
  });
  if (cursor < ordered.length) out.push(ordered.slice(cursor));
  return out;
}

// Removed legacy phonics grouping helpers; Phonics tab now initializes from one effect.

const stripPipeDisplay = (text) => (text ? String(text).replace(/\|/g, '') : '');

const SUCCESS_SOUND_URI =
  'https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3';

function paramStr(params, key) {
  const v = params[key];
  if (v == null) return '';
  return Array.isArray(v) ? String(v[0] ?? '') : String(v);
}

function resolvePhonicsTabRawField(params) {
  const jsonRaw = paramStr(params, 'learnCardJSON');
  if (jsonRaw.trim()) {
    try {
      const learnCard = JSON.parse(jsonRaw);
      const rawField =
        learnCard?.graphemes ||
        learnCard?.phonics ||
        learnCard?.phoneticBreakdown ||
        '';
      const s = String(rawField ?? '').trim();
      if (s && s !== '-' && s !== '—') return s;
    } catch {
      // ignore invalid learnCardJSON
    }
  }
  const directCandidates = [
    paramStr(params, 'graphemes'),
    paramStr(params, 'phonics'),
    paramStr(params, 'phoneticBreakdown'),
    paramStr(params, 'practiceGraphemes'),
  ];
  for (const raw of directCandidates) {
    const s = String(raw ?? '').trim();
    if (s && s !== '-' && s !== '—') return s;
  }
  return '';
}

function resolvePhonicsBoundarySyllables(params, currentSyllables) {
  const direct = String(currentSyllables ?? '').trim();
  if (direct && direct !== '-' && direct !== '—') return direct;
  const jsonRaw = paramStr(params, 'learnCardJSON');
  if (!jsonRaw.trim()) return '';
  try {
    const learnCard = JSON.parse(jsonRaw);
    const fromJson = String(learnCard?.syllables ?? '').trim();
    if (fromJson && fromJson !== '-' && fromJson !== '—') return fromJson;
  } catch {
    // ignore invalid learnCardJSON
  }
  return '';
}

export default function PracticeScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const word = String(paramStr(params, 'word')).trim();
  const practiceWord = String(paramStr(params, 'practiceWord') || word).trim();
  /** Syllable breakdown from learn card — Syllables tab + Phonics tab (same route param). */
  const syllablesRaw = paramStr(params, 'syllables') || '';
  const syllables = syllablesRaw.trim();
  /** Grapheme-level rhythm string from learn card (not used for Syllables tab tiles). */
  const practicePhonics = String(paramStr(params, 'practicePhonics')).trim();
  /** Phonics sound units — Phonics tab ONLY. */
  const practiceGraphemes = String(paramStr(params, 'practiceGraphemes')).trim();
  /** Phonics tab raw breakdown field (learn_card_json fallback chain). */
  const phonicsTabRawField = useMemo(() => resolvePhonicsTabRawField(params), [params]);
  /** Use syllables to recover phrase word boundaries for phonics grouping. */
  const phonicsBoundarySyllables = useMemo(
    () => resolvePhonicsBoundarySyllables(params, syllables),
    [params, syllables],
  );
  const definitions = useMemo(() => {
    const raw = paramStr(params, 'definitionsJSON');
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [params.definitionsJSON]);
  const exampleSentence = String(
    paramStr(params, 'exampleSentence') || paramStr(params, 'example'),
  ).trim();
  const graphemesPronunciation = useMemo(() => {
    const raw = paramStr(params, 'graphemesPronunciationJSON');
    if (!raw.trim()) return {};
    try {
      const gp = JSON.parse(raw);
      if (gp && typeof gp === 'object' && !Array.isArray(gp)) return gp;
    } catch {
      // ignore
    }
    return {};
  }, [params.graphemesPronunciationJSON]);

  const [tab, setTab] = useState('remember');
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

  const [phGroup0, setPhGroup0] = useState([]);
  const [phGroup1, setPhGroup1] = useState([]);
  const [phAnswers, setPhAnswers] = useState([]);
  const phInitializedFor = useRef(null);
  const phSpaceIndexRef = useRef(-1);
  const phExpectedRef = useRef([]);

  const [spellSlots, setSpellSlots] = useState([]);
  const [spellInventory, setSpellInventory] = useState({});

  const [spellingDone, setSpellingDone] = useState(false);

  const [fillInChoices, setFillInChoices] = useState([]);
  const [fillInLoading, setFillInLoading] = useState(false);
  const [fillInCorrect, setFillInCorrect] = useState(false);
  const [fillInWrongIndex, setFillInWrongIndex] = useState(null);
  const [rememberSlots, setRememberSlots] = useState([]);
  const [lcwcStage, setLcwcStage] = useState('look');
  const [rememberTimerMs, setRememberTimerMs] = useState(5000);
  const [rememberIsCorrect, setRememberIsCorrect] = useState(false);
  const [rememberReveal, setRememberReveal] = useState('');

  /** Words in the practice phrase (space = boundary). */
  const practiceWordWords = useMemo(
    () => practiceWord.trim().split(/\s+/).filter(Boolean),
    [practiceWord],
  );
  /** practicePhonics / practiceGraphemes split by spaces = one string per word, then •/|/｜ within word. */
  const soundPhonicsByWord = useMemo(() => parseWordUnitGroups(practicePhonics), [practicePhonics]);
  const graphemesByWord = useMemo(() => parseWordUnitGroups(practiceGraphemes), [practiceGraphemes]);
  /** Sound tab: only split into rows + separator when word count matches practiceWord (avoids spurious spaces in data). */
  const soundDisplayWordGroups = useMemo(() => {
    const n = practiceWordWords.length;
    if (n <= 1) return null;
    if (soundPhonicsByWord.length === n) return soundPhonicsByWord;
    if (graphemesByWord.length === n) return graphemesByWord;
    return null;
  }, [practiceWordWords, soundPhonicsByWord, graphemesByWord]);
  /** Flat list for TTS cache + indices (same order as on-screen tiles). */
  const phonicsGroups = useMemo(() => {
    if (soundDisplayWordGroups) return soundDisplayWordGroups.flat();
    const flatFromRhythm = soundPhonicsByWord.flat();
    if (flatFromRhythm.length > 0) return flatFromRhythm;
    return parsePhonicsFlatPattern(String(practiceGraphemes ?? ''));
  }, [soundDisplayWordGroups, soundPhonicsByWord, practiceGraphemes]);
  useEffect(() => {
    if (tab !== 'phonics') return;

    const key = `phonics_${syllablesRaw}`;
    if (phInitializedFor.current === key) return;
    phInitializedFor.current = key;

    const syllablesRaw = paramStr(params, 'syllables') || '';
    console.log('[Phonics] syllablesRaw from params:', syllablesRaw);
    // Expected: "rep•ri•man•ded se•vere•ly"

    const syllableWords = syllablesRaw.trim().split(' ').filter((w) => w.length > 0);
    const parseWord = (str) => str.split('•').filter((s) => s.length > 0);

    const g0 = parseWord(syllableWords[0] || '');
    const g1 = syllableWords.length > 1 ? parseWord(syllableWords[1]) : [];

    console.log('[Phonics] g0:', g0);
    console.log('[Phonics] g1:', g1);

    const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
    setPhGroup0(shuffle(g0));
    setPhGroup1(shuffle(g1));
    const totalBoxes = g0.length + (g1.length > 0 ? g1.length : 0);
    setPhAnswers(new Array(totalBoxes).fill(null));
    phSpaceIndexRef.current = g1.length > 0 ? g0.length : -1;
    phExpectedRef.current = g1.length > 0 ? [...g0, ' ', ...g1] : [...g0];
  }, [tab, syllablesRaw]);
  const syllablesWordGroups = useMemo(() => {
    const parsed = parseWordUnitGroups(syllables);
    if (parsed.length > 0) return parsed;
    const words = practiceWord.split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    return words.map((w) => [w]);
  }, [syllables, practiceWord]);
  const groupedSylPool = useMemo(
    () => groupPoolByWordGroups(sylPool, syllablesWordGroups),
    [sylPool, syllablesWordGroups],
  );
  useEffect(() => {
    console.log('[Phonics] poolGroup0:', phGroup0);
    console.log('[Phonics] poolGroup1:', phGroup1);
  }, [phGroup0, phGroup1]);
  
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
    console.log('[Practice] syllables (Syllables tab):', syllables);
    console.log('[Practice] practicePhonics (grapheme rhythm):', practicePhonics);
    console.log('[Practice] practiceGraphemes (phonics):', practiceGraphemes);
    console.log(
      '[Practice] breakdowns differ?',
      practicePhonics.replace(/\s/g, '') !== practiceGraphemes.replace(/\s/g, ''),
    );
  }, [practiceWord, syllables, practicePhonics, practiceGraphemes]);

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
    const list = syllablesTileList(syllables, practiceWord);
    const pool = list.map((text, i) => ({
      id: `syl-${i}-${text}`,
      text,
      placed: false,
    }));
    setSylSlots(Array(list.length).fill(null));
    setSylPool(shuffleArray(pool));
  }, [syllables, practiceWord]);

  const resetSpelling = useCallback(() => {
    const w = practiceWord.replace(/ /g, '').toLowerCase();
    const inv = {};
    for (const ch of w) {
      inv[ch] = (inv[ch] || 0) + 1;
    }
    setSpellSlots(Array(w.length).fill(null));
    setSpellInventory(inv);
    setSpellingDone(false);
  }, [practiceWord]);

  useEffect(() => {
    if (!practiceWord) return;
    resetSyllables();
    resetSpelling();
  }, [practiceWord, syllables, practiceGraphemes, resetSyllables, resetSpelling]);

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
    let expected = syllablesTileList(syllables, practiceWord);
    if (expected.length === 0) {
      expected = practiceWord.trim() ? [practiceWord.trim()] : [];
    }
    const expLower = expected.map((s) => s.toLowerCase());
    const got = sylSlots.map((s) => s.text.toLowerCase());
    const ok = got.length === expLower.length && got.every((g, i) => g === expLower[i]);
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
    const idx = phAnswers.findIndex((box, i) => i !== phSpaceIndexRef.current && box == null);
    if (idx === -1) return;
    if (phGroup0.includes(item)) {
      setPhGroup0((prev) => {
        const i = prev.indexOf(item);
        if (i === -1) return prev;
        const n = [...prev];
        n.splice(i, 1);
        return n;
      });
    } else if (phGroup1.includes(item)) {
      setPhGroup1((prev) => {
        const i = prev.indexOf(item);
        if (i === -1) return prev;
        const n = [...prev];
        n.splice(i, 1);
        return n;
      });
    } else {
      return;
    }
    setPhAnswers((prev) => {
      const n = [...prev];
      n[idx] = item;
      return n;
    });
  };

  const onPhSlotTap = (idx) => {
    if (idx === phSpaceIndexRef.current) return;
    const slot = phAnswers[idx];
    if (!slot) return;
    if (phSpaceIndexRef.current >= 0 && idx > phSpaceIndexRef.current) {
      setPhGroup1((prev) => [...prev, slot]);
    } else {
      setPhGroup0((prev) => [...prev, slot]);
    }
    setPhAnswers((prev) => {
      const n = [...prev];
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
    const complete = phAnswers.every((box, i) => (i === phSpaceIndexRef.current ? true : box != null));
    if (!complete) return;
    const expectedTexts = phExpectedRef.current;
    if (expectedTexts.length === 0) return;
    const normTile = (t) => stripPipeDisplay(String(t ?? '')).toLowerCase();
    const expNorm = expectedTexts.map(normTile);
    const got = phAnswers.map((box, i) => (i === phSpaceIndexRef.current ? normTile(' ') : normTile(box)));
    const ok = got.length === expNorm.length && got.every((g, i) => g === expNorm[i]);
    if (ok) {
      playSuccessSound();
      runGreenFlash(phFlash, () => {
        setTimeout(() => setTab('fill'), 1000);
      });
    } else {
      runShake(phShake);
      const splitAt = phSpaceIndexRef.current;
      const full = phExpectedRef.current.filter((x) => x !== ' ');
      const left = splitAt >= 0 ? full.slice(0, splitAt) : full;
      const right = splitAt >= 0 ? full.slice(splitAt) : [];
      const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);
      setPhGroup0(shuffle(left));
      setPhGroup1(shuffle(right));
      setPhAnswers(new Array((left.length || 0) + (right.length || 0)).fill(null));
    }
  };

  const playKeyboardClick = useCallback(() => {
    Vibration.vibrate(10);
  }, []);

  const wordChars = useMemo(() => String(practiceWord || '').split(''), [practiceWord]);
  const correctLetters = useMemo(
    () => String(practiceWord || '').replace(/ /g, '').toLowerCase().split(''),
    [practiceWord],
  );

  const onSpellKey = async (char) => {
    if (spellingDone) return;
    if (char === ' ') {
      playKeyboardClick();
      return;
    }
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
    const wj = paramStr(params, 'wordsJSON');
    const li = Number(paramStr(params, 'learnIndex')) || 0;
    if (!wj.trim()) {
      router.replace({ pathname: '/learn', params: { advanceToNextWord: 'true' } });
      return;
    }
    let list = [];
    try {
      list = JSON.parse(wj);
    } catch {
      list = [];
    }
    if (!Array.isArray(list) || list.length === 0) {
      router.replace({ pathname: '/learn', params: { advanceToNextWord: 'true' } });
      return;
    }
    const next = Math.min(li + 1, list.length - 1);
    router.replace({
      pathname: '/learn',
      params: {
        wordsJSON: wj,
        learnIndex: String(next),
      },
    });
  }, [params, router]);

  const checkSpelling = () => {
    if (spellSlots.some((x) => x == null)) return;
    const built = spellSlots.join('');
    const ok = built === correctLetters.join('');
    if (ok) {
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
    router.back();
  };

  const onFillInChoicePress = (choice, index) => {
    if (fillInCorrect) return;
    const ok = String(choice).toLowerCase() === practiceWord.toLowerCase();
    if (ok) {
      setFillInCorrect(true);
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

  const rememberChars = useMemo(() => String(practiceWord || '').split(''), [practiceWord]);
  const rememberTarget = useMemo(
    () => String(practiceWord || '').replace(/ /g, '').toLowerCase(),
    [practiceWord],
  );
  const hasRememberInput = rememberSlots.some((x) => x != null && x !== ' ');

  const resetRememberFlow = useCallback(() => {
    setLcwcStage('look');
    setRememberSlots(Array(rememberTarget.length).fill(null));
    setRememberTimerMs(5000);
    setRememberIsCorrect(false);
    setRememberReveal('');
  }, [rememberTarget]);

  const onRememberKey = (char) => {
    if (lcwcStage !== 'write') return;
    if (char === ' ') return;
    const idx = rememberSlots.findIndex((s) => s == null);
    if (idx === -1) return;
    setRememberSlots((prev) => {
      const n = [...prev];
      n[idx] = String(char).toLowerCase();
      return n;
    });
  };

  const onRememberBackspace = () => {
    if (lcwcStage !== 'write') return;
    let last = -1;
    for (let i = rememberSlots.length - 1; i >= 0; i -= 1) {
      if (rememberSlots[i] != null) {
        last = i;
        break;
      }
    }
    if (last < 0) return;
    setRememberSlots((prev) => {
      const n = [...prev];
      n[last] = null;
      return n;
    });
  };

  const checkRemember = () => {
    if (lcwcStage !== 'write') return;
    if (!hasRememberInput) return;
    const typed = rememberSlots.join('').toLowerCase();
    const ok = typed === rememberTarget;
    setLcwcStage('check');
    setRememberIsCorrect(ok);
    if (ok) {
      setRememberReveal('✓ Well done! You got it right!');
    } else {
      setRememberReveal(`✗ The correct spelling is: ${String(practiceWord || '').toUpperCase()}`);
    }
  };

  const onFooterSkip = () => {
    if (tab === 'remember') {
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
    phAnswers.length > 0 &&
    phGroup0.length === 0 &&
    phGroup1.length === 0 &&
    phAnswers.every((box, i) => (i === phSpaceIndexRef.current ? true : box != null));
  const canCheckSp = !spellSlots.some((x) => x == null) && practiceWord.length > 0;

  const showCheckButton =
    !spellingDone && tab === 'spelling';

  useEffect(() => {
    if (tab !== 'remember') return;
    resetRememberFlow();
  }, [tab, resetRememberFlow]);

  useEffect(() => {
    if (tab !== 'remember') return;
    resetRememberFlow();
  }, [practiceWord, tab, resetRememberFlow]);

  useEffect(() => {
    if (tab !== 'remember' || lcwcStage !== 'look') return;
    setRememberTimerMs(5000);
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const left = Math.max(0, 5000 - (Date.now() - startedAt));
      setRememberTimerMs(left);
    }, 100);
    const autoNext = setTimeout(() => {
      setLcwcStage('write');
      setRememberTimerMs(0);
    }, 5000);
    return () => {
      clearInterval(tick);
      clearTimeout(autoNext);
    };
  }, [tab, lcwcStage]);

  useEffect(() => {
    if (tab !== 'remember' || lcwcStage !== 'look') return;
    void playTts(practiceWord);
  }, [tab, lcwcStage, practiceWord]);

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
        <TouchableOpacity style={styles.headerBack} onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.headerBackText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Practice</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.tabRow}>
        {[
          { key: 'remember', label: '👁️ Remember' },
          { key: 'fill', label: '📝 Fill In' },
          { key: 'spelling', label: '✏️ Spelling' },
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

        {tab === 'remember' ? (
          <View style={styles.section}>
            <View style={styles.lcwcPillsRow}>
              <View
                style={[
                  styles.lcwcPill,
                  lcwcStage === 'look' ? styles.lcwcPillActive : lcwcStage !== 'look' ? styles.lcwcPillDone : null,
                ]}
              >
                <Text style={[styles.lcwcPillText, (lcwcStage === 'look' || lcwcStage !== 'look') && styles.lcwcPillTextOn]}>
                  {lcwcStage === 'look' ? '👁 LOOK' : '👁 LOOK ✓'}
                </Text>
              </View>
              <View
                style={[
                  styles.lcwcPill,
                  lcwcStage === 'write' ? styles.lcwcPillActive : lcwcStage === 'check' ? styles.lcwcPillDone : null,
                ]}
              >
                <Text style={[styles.lcwcPillText, (lcwcStage === 'write' || lcwcStage === 'check') && styles.lcwcPillTextOn]}>
                  {lcwcStage === 'check' ? '✏️ WRITE ✓' : '✏️ WRITE'}
                </Text>
              </View>
              <View style={[styles.lcwcPill, lcwcStage === 'check' && styles.lcwcPillActive]}>
                <Text style={[styles.lcwcPillText, lcwcStage === 'check' && styles.lcwcPillTextOn]}>✓ CHECK</Text>
              </View>
            </View>

            {lcwcStage === 'look' ? (
              <>
                <View style={styles.rememberWordCard}>
                  <Text style={styles.rememberWordCardText}>{String(practiceWord ?? '').toUpperCase()}</Text>
                </View>
                <View style={styles.rememberTimerTrack}>
                  <View style={[styles.rememberTimerFill, { width: `${(rememberTimerMs / 5000) * 100}%` }]} />
                </View>
                <Text style={styles.rememberStageHint}>Look carefully — disappears in 5s...</Text>
              </>
            ) : null}

            {lcwcStage === 'write' ? (
              <View style={styles.rememberHiddenBox}>
                <Text style={styles.rememberHiddenText}>Word is hidden — type from memory!</Text>
              </View>
            ) : null}

            {lcwcStage === 'check' ? (
              <View style={styles.rememberWordCard}>
                <Text style={styles.rememberWordCardText}>{String(practiceWord ?? '').toUpperCase()}</Text>
              </View>
            ) : null}

            {lcwcStage !== 'look' ? (
              <View style={[styles.slotWrap, styles.rememberSlotsWrap]}>
                <View style={styles.spellRow}>
                  {(() => {
                    let letterIdx = 0;
                    return rememberChars.map((char, index) => {
                      if (char === ' ') return <View style={styles.rememberSpaceGap} key={`rm-gap-${index}`} />;
                      const ch = rememberSlots[letterIdx] ?? '';
                      const isChecked = lcwcStage === 'check';
                      const ok = String(ch).toLowerCase() === String(char).toLowerCase();
                      const node = (
                        <View
                          key={`rm-box-${index}`}
                          style={[
                            styles.spellBox,
                            ch && styles.spellBoxFilled,
                            isChecked && (ok ? styles.rememberBoxCorrect : styles.rememberBoxWrong),
                          ]}
                        >
                          <Text style={[styles.spellBoxText, isChecked && (ok ? styles.rememberLetterOk : styles.rememberLetterBad)]}>
                            {ch}
                          </Text>
                        </View>
                      );
                      letterIdx += 1;
                      return node;
                    });
                  })()}
                </View>
              </View>
            ) : null}

            {lcwcStage === 'write' ? (
              <>
                <View style={styles.kbdShell}>
                  <View style={styles.kbdRow}>
                    {KBD_ROW_1.split('').map((keyChar) => (
                      <TouchableOpacity
                        key={`rm-r1-${keyChar}`}
                        style={[styles.kbdKey, styles.kbdKeyOn]}
                        onPress={() => onRememberKey(keyChar)}
                        activeOpacity={0.65}
                      >
                        <Text style={[styles.kbdKeyText, styles.kbdKeyTextOn]}>{keyChar}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={styles.kbdRow}>
                    {KBD_ROW_2.split('').map((keyChar) => (
                      <TouchableOpacity
                        key={`rm-r2-${keyChar}`}
                        style={[styles.kbdKey, styles.kbdKeyOn]}
                        onPress={() => onRememberKey(keyChar)}
                        activeOpacity={0.65}
                      >
                        <Text style={[styles.kbdKeyText, styles.kbdKeyTextOn]}>{keyChar}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <View style={[styles.kbdRow, styles.kbdRowLast]}>
                    {KBD_ROW_3.split('').map((keyChar) => (
                      <TouchableOpacity
                        key={`rm-r3-${keyChar}`}
                        style={[styles.kbdKey, styles.kbdKeyOn]}
                        onPress={() => onRememberKey(keyChar)}
                        activeOpacity={0.65}
                      >
                        <Text style={[styles.kbdKeyText, styles.kbdKeyTextOn]}>{keyChar}</Text>
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity
                      style={styles.kbdBackspace}
                      onPress={onRememberBackspace}
                      activeOpacity={0.65}
                    >
                      <Text style={styles.kbdBackspaceText}>⌫</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={styles.spaceRow}>
                    <TouchableOpacity
                      style={[styles.kbdKey, styles.spaceKey]}
                      onPress={() => onRememberKey(' ')}
                      activeOpacity={0.65}
                    >
                      <Text style={styles.spaceKeyText}>SPACE</Text>
                    </TouchableOpacity>
                  </View>
                </View>

                <TouchableOpacity
                  style={[styles.checkBtn, !hasRememberInput && styles.checkBtnOff]}
                  onPress={checkRemember}
                  disabled={!hasRememberInput}
                >
                  <Text style={[styles.checkBtnText, !hasRememberInput && styles.checkBtnTextOff]}>Check</Text>
                </TouchableOpacity>
              </>
            ) : null}

            {lcwcStage === 'check' ? (
              <View style={styles.rememberFeedbackBox}>
                <Text style={[styles.rememberFeedbackText, rememberIsCorrect ? styles.rememberOk : styles.rememberBad]}>
                  {rememberReveal}
                </Text>
                <TouchableOpacity
                  style={styles.soundNextBtn}
                  onPress={() => {
                    resetRememberFlow();
                    goLearnNextWord();
                  }}
                >
                  <Text style={styles.soundNextBtnText}>Next word →</Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
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
                {(() => {
                  let letterIdx = 0;
                  return wordChars.map((char, index) => {
                    if (char === ' ') return <View key={`sp-gap-${index}`} style={styles.rememberSpaceGap} />;
                    const ch = spellSlots[letterIdx] ?? '';
                    const node = (
                      <View key={`sp-box-${index}`} style={[styles.spellBox, ch && styles.spellBoxFilled]}>
                        <Text style={styles.spellBoxText}>{ch}</Text>
                      </View>
                    );
                    letterIdx += 1;
                    return node;
                  });
                })()}
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
              <View style={styles.spaceRow}>
                <TouchableOpacity
                  style={[styles.kbdKey, styles.spaceKey]}
                  onPress={() => {
                    void onSpellKey(' ');
                  }}
                  disabled={spellingDone}
                  activeOpacity={0.65}
                >
                  <Text style={styles.spaceKeyText}>SPACE</Text>
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
              !canCheckSp && styles.checkBtnOff,
            ]}
            onPress={() => {
              checkSpelling();
            }}
            disabled={!canCheckSp}
          >
            <Text style={[styles.checkBtnText, !canCheckSp && styles.checkBtnTextOff]}>Check</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>

      {!spellingDone && tab !== 'remember' ? (
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
    backgroundColor: '#FFF8F0',
  },
  bgDecor: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  cloud: { position: 'absolute', backgroundColor: 'white', borderRadius: 99, opacity: 0.85 },
  sun: { position: 'absolute', top: 32, right: 24, width: 28, height: 28, borderRadius: 14, backgroundColor: '#FFD740', opacity: 0.8 },
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
    paddingTop: 50,
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
    backgroundColor: '#FFF8F0',
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
    color: '#bbb',
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
    borderColor: '#F0E8DC',
    borderRadius: 12,
    padding: 14,
    marginBottom: 20,
    backgroundColor: '#FFF8F0',
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
  lcwcPillsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  lcwcPill: {
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#E0E0E0',
  },
  lcwcPillActive: {
    backgroundColor: '#F97316',
  },
  lcwcPillDone: {
    backgroundColor: '#22A050',
  },
  lcwcPillText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#666',
  },
  lcwcPillTextOn: {
    color: '#fff',
  },
  rememberWordCard: {
    backgroundColor: '#F97316',
    borderRadius: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 8,
  },
  rememberWordCardText: {
    color: 'white',
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: 1,
  },
  rememberTimerTrack: {
    height: 4,
    borderRadius: 99,
    backgroundColor: '#F0E8DC',
    overflow: 'hidden',
    marginBottom: 8,
  },
  rememberTimerFill: {
    height: '100%',
    backgroundColor: '#F97316',
  },
  rememberStageHint: {
    fontSize: 12,
    color: '#999',
    marginBottom: 8,
  },
  rememberHiddenBox: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#F97316',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  rememberHiddenText: {
    color: '#F97316',
    textAlign: 'center',
    fontWeight: '600',
  },
  rememberSpaceGap: {
    width: 16,
    height: 36,
  },
  rememberBoxCorrect: {
    borderColor: '#22A050',
  },
  rememberBoxWrong: {
    borderColor: '#E53935',
  },
  rememberLetterOk: {
    color: '#22A050',
  },
  rememberLetterBad: {
    color: '#E53935',
  },
  rememberFeedbackBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#F0E8DC',
    gap: 10,
  },
  rememberFeedbackText: {
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  rememberOk: {
    color: '#22A050',
  },
  rememberBad: {
    color: '#E53935',
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
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  soundSkipBtnText: {
    color: GRAY,
    fontSize: 16,
    fontWeight: '700',
  },
  fillSentence: {
    fontSize: 16,
    lineHeight: 24,
    color: '#F97316',
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
    backgroundColor: '#FFF3E0',
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
    backgroundColor: 'rgba(255,255,255,0.88)',
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
  phAnswerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    gap: 8,
    width: '100%',
  },
  phAnswerGraphemeSlot: {
    width: 52,
    height: 52,
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
  phAnswerSpaceGap: {
    width: 18,
    height: 52,
  },
  phPoolColumn: {
    width: '100%',
    flexDirection: 'column',
  },
  phPoolWordRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
    width: '100%',
  },
  phPoolTile: {
    minWidth: 76,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: BLUE,
    backgroundColor: '#EBF4FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  phPoolTileGhost: {
    opacity: 0.38,
    borderColor: GRAY_LIGHT,
  },
  phPoolTileText: {
    fontSize: 17,
    fontWeight: '800',
    color: BLUE,
    textAlign: 'center',
  },
  phPoolTileTextGhost: {
    color: GRAY,
  },
  phPoolWordDivider: {
    width: '100%',
    alignItems: 'center',
    marginVertical: 10,
  },
  phPoolWordDividerLineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 6,
  },
  phPoolWordDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#ccc',
  },
  phPoolWordDividerText: {
    fontSize: 12,
    color: '#aaa',
    fontWeight: '600',
  },
  phBoxEmpty: {
    backgroundColor: 'rgba(255,255,255,0.88)',
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
    width: 32,
    height: 36,
    borderWidth: 2,
    borderColor: '#F0E8DC',
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  spellBoxFilled: {
    borderColor: '#F97316',
    backgroundColor: '#FFF3E0',
  },
  spellBoxText: {
    fontSize: 18,
    fontWeight: '800',
    color: DARK_GRAY,
  },
  kbdShell: {
    marginTop: 12,
    backgroundColor: '#D1D5DB',
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
    backgroundColor: '#fcfcfe',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#8e8e93',
  },
  kbdKeyText: {
    fontSize: 17,
    fontWeight: '500',
  },
  kbdKeyTextOn: {
    color: '#000',
  },
  kbdKeyTextOff: {
    color: '#000',
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
  spaceKey: {
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    flexBasis: '100%',
    flexGrow: 0,
    flexShrink: 0,
    height: 42,
    backgroundColor: 'white',
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  spaceRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    width: '100%',
    marginTop: 4,
  },
  spaceKeyText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111',
    letterSpacing: 0.4,
  },
  checkBtn: {
    marginTop: 20,
    backgroundColor: BLUE,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  checkBtnOff: {
    backgroundColor: '#E0E0E0',
    opacity: 1,
  },
  checkBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
  },
  checkBtnTextOff: {
    color: '#999',
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
    borderColor: '#F0E8DC',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  skipBtnText: {
    color: '#999',
    fontSize: 15,
    fontWeight: '700',
  },
});
