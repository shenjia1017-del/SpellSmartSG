import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import {
  fetchOpenAITtsAudio,
  TTS_LANGUAGE,
  TTS_VOICE_WORD,
} from '../../lib/phonics';
import { supabase } from '../../lib/supabase';
import { completeWeek, updateWordMastery } from '../lib/gardenHelpers';
import WeekCompleteModal from '../components/WeekCompleteModal';
import { useChild } from '../lib/childContext';

const BLUE = '#F97316';
const GREEN_PHRASE = '#2e7d32';
const TTS_MIN_MS = 800;
/** Words & phrases dictation — slower than default. */
const TTS_SPEED_WORDS = 0.75;
/** Full sentences — slower for young students. */
const TTS_SPEED_SENTENCES = 0.65;

/** Minimum silence between end of one sentence TTS and start of the next (sentence modes). */
const SENTENCE_GAP_MS = 3000;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/** Words & Phrases mode: `words` table rows only — never passage bodies. */
function buildMixedWordPhraseItems(words) {
  const out = [];
  for (const w of words || []) {
    const text =
      typeof w === 'string' ? String(w).trim() : String(w?.word ?? '').trim();
    if (!text) continue;
    out.push({
      id: `w-${out.length}-${text.slice(0, 24)}`,
      text,
      week_label: String(w?.week_label ?? ''),
      tag: text.includes(' ') ? 'phrase' : 'word',
    });
  }
  return shuffle(out);
}

/**
 * Split passage into sentences in original order: break after . ? ! when followed by
 * whitespace or end. Punctuation stays on the sentence before it. Drops empty segments.
 */
function splitPassageIntoSentences(body) {
  const raw = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];
  const out = [];
  const re = /[\s\S]*?[.!?](?=\s|$)/g;
  let m;
  let lastIndex = 0;
  while ((m = re.exec(raw)) !== null) {
    const chunk = m[0].trim();
    if (chunk) out.push(chunk);
    lastIndex = re.lastIndex;
  }
  const tail = raw.slice(lastIndex).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/**
 * Punctuation → spoken words for sentence TTS only. Step order matches product spec.
 * UI and scoring still use the raw sentence in the queue.
 */
function sentenceTextToTtsInput(raw) {
  let t = String(raw ?? '');

  // Step 1 — quotation marks first
  t = t.replace(/\u201C/g, ' open inverted comma ');
  t = t.replace(/\u201D/g, ' close inverted comma ');
  t = t.replace(/\u2018/g, ' open single quote ');
  t = t.replace(/\u2019/g, ' close single quote ');
  let useOpenDouble = true;
  t = t.replace(/"/g, () => {
    const sp = useOpenDouble ? ' open inverted comma ' : ' close inverted comma ';
    useOpenDouble = !useOpenDouble;
    return sp;
  });

  // Step 2 — ellipsis before single full stops
  t = t.replace(/\u2026/g, ' dot dot dot ');
  t = t.replace(/\.{3}/g, ' dot dot dot ');
  t = t.replace(/,/g, ' comma ');
  t = t.replace(/\./g, ' full stop ');
  t = t.replace(/\?/g, ' question mark ');
  t = t.replace(/!/g, ' exclamation mark ');
  t = t.replace(/;/g, ' semicolon ');
  t = t.replace(/:/g, ' colon ');
  t = t.replace(/'/g, ' apostrophe ');
  t = t.replace(/-/g, ' dash ');
  t = t.replace(/\(/g, ' open bracket ');
  t = t.replace(/\)/g, ' close bracket ');

  // Step 3
  return t.replace(/\s+/g, ' ').trim();
}

/** Sentences mode: `passages` table rows only — ordered sentences; never words table. */
function buildSentenceItems(passages) {
  const out = [];
  for (const p of passages || []) {
    const weekLabel = String(p?.week_label ?? '');
    const sentences = splitPassageIntoSentences(p?.body ?? '');
    for (const text of sentences) {
      if (!text) continue;
      out.push({
        id: `s-${out.length}-${text.slice(0, 24)}`,
        text,
        week_label: weekLabel,
      });
    }
  }
  return out;
}

function normalizeAnswer(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function answersMatch(typed, expected) {
  return normalizeAnswer(typed).toLowerCase() === normalizeAnswer(expected).toLowerCase();
}

const SENTENCE_PREVIEW_LEN = 30;

function truncateSentencePreview(text) {
  const t = String(text ?? '').trim();
  if (t.length <= SENTENCE_PREVIEW_LEN) return t;
  return `${t.slice(0, SENTENCE_PREVIEW_LEN)}...`;
}

/** First differing word pair for sentence dictation results, e.g. "spacial → special". */
function firstWrongWordComparison(typed, expected) {
  const ta = normalizeAnswer(typed).split(/\s+/).filter(Boolean);
  const tb = normalizeAnswer(expected).split(/\s+/).filter(Boolean);
  const max = Math.max(ta.length, tb.length);
  for (let i = 0; i < max; i += 1) {
    const a = ta[i];
    const b = tb[i];
    if ((a ?? '').toLowerCase() !== (b ?? '').toLowerCase()) {
      return `${a ?? '(missing)'} → ${b ?? '(missing)'}`;
    }
  }
  return '—';
}

function scoreMessage(pct) {
  if (pct >= 1) return 'Perfect! You are a spelling star!';
  if (pct >= 0.8) return 'Well done! Keep it up.';
  if (pct >= 0.6) return 'Good try! Practise a bit more.';
  return 'Keep practising — you will get there!';
}

function StudentAnswerHighlights({ typed, expected }) {
  const t = typed ?? '';
  const e = expected ?? '';
  return (
    <Text style={styles.diffWrap}>
      {t.split('').map((ch, i) => {
        const ec = e[i];
        const wrong = ec === undefined || ch.toLowerCase() !== ec.toLowerCase();
        return (
          <Text key={`${i}-${ch}`} style={wrong ? styles.diffWrong : styles.diffOk}>
            {ch}
          </Text>
        );
      })}
      {t.length < e.length ? (
        <Text style={styles.diffHint}> (incomplete)</Text>
      ) : null}
    </Text>
  );
}

function parseJsonArrayParam(raw) {
  if (raw == null || raw === '') return [];
  const s = typeof raw === 'string' ? raw : String(raw);
  if (!s.trim()) return [];
  try {
    const parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default function DictationScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const { currentChild } = useChild();

  /** When set (including empty string), load words + passages from Supabase for that week only. */
  const useWeekFetch = params.weekLabel !== undefined && params.weekLabel !== null;
  const weekLabelForQuery = useMemo(() => {
    if (!useWeekFetch) return '';
    const raw = params.weekLabel;
    return Array.isArray(raw) ? String(raw[0] ?? '') : String(raw ?? '');
  }, [useWeekFetch, params.weekLabel]);

  const wordsFromParams = useMemo(() => {
    const raw = params.wordsJSON;
    const s = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
    return parseJsonArrayParam(s);
  }, [params.wordsJSON]);
  const passagesFromParams = useMemo(() => {
    const raw = params.passagesJSON;
    const s = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
    return parseJsonArrayParam(s);
  }, [params.passagesJSON]);

  /** Open Words flow immediately (e.g. from Review with wrong words only). */
  const autoStartWordsParam = useMemo(() => {
    const raw = params.autoStartWords;
    const s = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
    return s === '1' || s === 'true';
  }, [params.autoStartWords]);

  const [fetchedWords, setFetchedWords] = useState([]);
  const [fetchedPassages, setFetchedPassages] = useState([]);
  const [weekDataLoading, setWeekDataLoading] = useState(useWeekFetch);
  const [weekDataError, setWeekDataError] = useState(null);

  useEffect(() => {
    if (!useWeekFetch) {
      setWeekDataLoading(false);
      setWeekDataError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setWeekDataLoading(true);
      setWeekDataError(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const userId = sessionData?.session?.user?.id;
        if (!userId) {
          throw new Error('Please log in to use dictation.');
        }
        const [wRes, pRes] = await Promise.all([
          supabase
            .from('words')
            .select('id, word, week_label')
            .eq('user_id', userId)
            .eq('child_id', currentChild?.id ?? '')
            .eq('week_label', weekLabelForQuery),
          supabase
            .from('passages')
            .select('id, body, week_label')
            .eq('user_id', userId)
            .eq('child_id', currentChild?.id ?? '')
            .eq('week_label', weekLabelForQuery)
            .order('id', { ascending: true }),
        ]);
        if (wRes.error) throw wRes.error;
        if (pRes.error) throw pRes.error;
        if (!cancelled) {
          setFetchedWords(Array.isArray(wRes.data) ? wRes.data : []);
          setFetchedPassages(Array.isArray(pRes.data) ? pRes.data : []);
        }
      } catch (e) {
        if (!cancelled) {
          setFetchedWords([]);
          setFetchedPassages([]);
          setWeekDataError(e?.message ?? 'Failed to load dictation data.');
        }
      } finally {
        if (!cancelled) setWeekDataLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [useWeekFetch, weekLabelForQuery, currentChild?.id]);

  const words = useWeekFetch ? fetchedWords : wordsFromParams;
  const passages = useWeekFetch ? fetchedPassages : passagesFromParams;

  const soundRef = useRef(null);
  const lastTtsAt = useRef(0);
  const playbackEndCallbackRef = useRef(null);
  const sentenceCountdownTimerRef = useRef(null);

  const [phase, setPhase] = useState('modeSelect');
  /** 'words' | 'sentencesType' | 'sentencesPaper' */
  const [flowKind, setFlowKind] = useState(null);
  const [queue, setQueue] = useState([]);
  const [queueSnapshot, setQueueSnapshot] = useState([]);
  const [idx, setIdx] = useState(0);
  const [inputText, setInputText] = useState('');
  /** Words & Phrases mode only: typed answer per question index (restored on Prev). */
  const [answers, setAnswers] = useState([]);
  const [ttsBusy, setTtsBusy] = useState(false);
  /** After first successful playback for current item, main play button shows "Play again". */
  const [hasPlayed, setHasPlayed] = useState(false);
  const [resultsRows, setResultsRows] = useState([]);
  /** Words & Phrases: expected spellings the user got wrong (for Review). */
  const [wrongWords, setWrongWords] = useState([]);
  /** Sentences (type in app): full expected text for each wrong sentence (for redo subset). */
  const [wrongSentences, setWrongSentences] = useState([]);
  const [modalVisible, setModalVisible] = useState(false);
  const [modalFlower, setModalFlower] = useState(null);
  const [modalCreature, setModalCreature] = useState(null);
  const [modalTotalFlowers, setModalTotalFlowers] = useState(0);
  /** Sentence flows: Next allowed only after playback + 3s countdown. */
  const [sentenceNextReady, setSentenceNextReady] = useState(false);
  /** 3 | 2 | 1 while counting down, null when idle / done. */
  const [sentenceCountdown, setSentenceCountdown] = useState(null);

  const flowKindRef = useRef(flowKind);
  flowKindRef.current = flowKind;
  /** Timestamp of last finished sentence TTS (sentence dictation modes only). */
  const lastSentenceEndAtRef = useRef(0);
  /** Set true before `setIdx` when paper mode "Done, next" should trigger TTS for the new sentence. */
  const paperAutoAdvanceRef = useRef(false);

  const current = queue[idx] ?? null;
  const total = queue.length;
  const progress = total > 0 ? (idx + 1) / total : 0;

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

  useEffect(() => {
    return () => {
      void unloadSound();
      if (sentenceCountdownTimerRef.current) {
        clearInterval(sentenceCountdownTimerRef.current);
        sentenceCountdownTimerRef.current = null;
      }
    };
  }, [unloadSound]);

  useEffect(() => {
    if (phase !== 'sentencesTypeActive' && phase !== 'sentencesPaperActive') return;
    setSentenceNextReady(false);
    setSentenceCountdown(null);
    if (sentenceCountdownTimerRef.current) {
      clearInterval(sentenceCountdownTimerRef.current);
      sentenceCountdownTimerRef.current = null;
    }
  }, [idx, phase]);

  useEffect(() => {
    if (
      phase !== 'wordsActive' &&
      phase !== 'sentencesTypeActive' &&
      phase !== 'sentencesPaperActive'
    ) {
      return;
    }
    setHasPlayed(false);
  }, [idx, phase]);

  useEffect(() => {
    if (idx === 0) lastSentenceEndAtRef.current = 0;
  }, [idx]);

  // Restore typed answer when question index changes (words mode only). Omit `answers` from deps so keystrokes are not reset when `answers` updates.
  useEffect(() => {
    if (phase !== 'wordsActive') return;
    setInputText(answers[idx] ?? '');
  }, [phase, idx]);

  useEffect(() => {
    if (phase !== 'results' || flowKind !== 'words') return;
    setWrongWords(resultsRows.filter((r) => !r.correct).map((r) => String(r.expected ?? '').trim()));
  }, [phase, flowKind, resultsRows]);

  useEffect(() => {
    if (phase !== 'results' || flowKind !== 'sentencesType') return;
    setWrongSentences(resultsRows.filter((r) => !r.correct).map((r) => String(r.expected ?? '').trim()));
  }, [phase, flowKind, resultsRows]);

  useLayoutEffect(() => {
    let title = 'Dictation';
    if (phase === 'modeSelect') title = 'Dictation';
    else if (phase === 'wordsActive') title = 'Words & Phrases';
    else if (phase === 'sentencesTypeActive') title = 'Sentences';
    else if (phase === 'sentencesPaperActive') title = 'Write on paper';
    else if (phase === 'results') title = 'Results';
    else if (phase === 'answerReveal') title = 'Check your answers';
    navigation.setOptions({ title, headerTintColor: BLUE });
  }, [navigation, phase]);

  const startPostPlaybackCountdown = useCallback(() => {
    if (sentenceCountdownTimerRef.current) {
      clearInterval(sentenceCountdownTimerRef.current);
      sentenceCountdownTimerRef.current = null;
    }
    setSentenceNextReady(false);
    setSentenceCountdown(3);
    let remaining = 3;
    sentenceCountdownTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (sentenceCountdownTimerRef.current) {
          clearInterval(sentenceCountdownTimerRef.current);
          sentenceCountdownTimerRef.current = null;
        }
        setSentenceCountdown(null);
        setSentenceNextReady(true);
      } else {
        setSentenceCountdown(remaining);
      }
    }, 1000);
  }, []);

  const playTts = async (text, options = {}) => {
    const { speed, onPlaybackEnd } = options;
    const t = String(text ?? '').trim();
    if (!t) return;
    if (typeof onPlaybackEnd === 'function') {
      if (sentenceCountdownTimerRef.current) {
        clearInterval(sentenceCountdownTimerRef.current);
        sentenceCountdownTimerRef.current = null;
      }
      setSentenceCountdown(null);
      setSentenceNextReady(false);
    }
    const now = Date.now();
    if (now - lastTtsAt.current < TTS_MIN_MS) {
      await new Promise((r) => setTimeout(r, TTS_MIN_MS - (now - lastTtsAt.current)));
    }
    if (ttsBusy) return;
    playbackEndCallbackRef.current = typeof onPlaybackEnd === 'function' ? onPlaybackEnd : null;
    lastTtsAt.current = Date.now();
    setTtsBusy(true);
    try {
      await unloadSound();
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });
      const ttsOpts = {
        voice: TTS_VOICE_WORD,
        language: TTS_LANGUAGE,
        ...(speed != null ? { speed } : {}),
      };
      const base64 = await fetchOpenAITtsAudio(t, ttsOpts);
      const dir = FileSystem.cacheDirectory;
      if (!dir) throw new Error('Cache directory not available for audio.');
      const uri = `${dir}dictation-tts-${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(uri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const { sound } = await Audio.Sound.createAsync({ uri });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((s) => {
        if (s.isLoaded && s.didJustFinish) {
          setTtsBusy(false);
          setHasPlayed(true);
          const fk = flowKindRef.current;
          if (fk === 'sentencesType' || fk === 'sentencesPaper') {
            lastSentenceEndAtRef.current = Date.now();
          }
          const cb = playbackEndCallbackRef.current;
          playbackEndCallbackRef.current = null;
          cb?.();
        }
      });
      await sound.playAsync();
    } catch {
      playbackEndCallbackRef.current = null;
      setTtsBusy(false);
    }
  };

  useEffect(() => {
    if (phase !== 'sentencesPaperActive' || !paperAutoAdvanceRef.current) return;
    paperAutoAdvanceRef.current = false;
    const row = queue[idx];
    const raw = String(row?.text ?? '').trim();
    if (!raw) return;
    void (async () => {
      if (idx > 0 && lastSentenceEndAtRef.current > 0) {
        const elapsed = Date.now() - lastSentenceEndAtRef.current;
        if (elapsed < SENTENCE_GAP_MS) {
          await new Promise((r) => setTimeout(r, SENTENCE_GAP_MS - elapsed));
        }
      }
      const ttsInput = sentenceTextToTtsInput(raw);
      await playTts(ttsInput, {
        speed: TTS_SPEED_SENTENCES,
      });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- playTts omitted to avoid redundant effect runs
  }, [idx, phase, queue]);

  const startWordsFlow = useCallback(() => {
    const items = buildMixedWordPhraseItems(words);
    if (items.length === 0) {
      return;
    }
    setQueue(items);
    setQueueSnapshot(items.map((x) => ({ ...x })));
    setFlowKind('words');
    setIdx(0);
    setAnswers([]);
    setWrongWords([]);
    setInputText('');
    setResultsRows([]);
    setPhase('wordsActive');
  }, [words]);

  const autoWordsStartedRef = useRef(false);
  useEffect(() => {
    autoWordsStartedRef.current = false;
  }, [params.wordsJSON, params.autoStartWords, weekLabelForQuery]);

  useEffect(() => {
    if (!autoStartWordsParam || weekDataLoading) return;
    if (phase !== 'modeSelect') return;
    if (autoWordsStartedRef.current) return;
    const items = buildMixedWordPhraseItems(words);
    if (items.length === 0) return;
    autoWordsStartedRef.current = true;
    startWordsFlow();
  }, [autoStartWordsParam, weekDataLoading, phase, words, startWordsFlow]);

  const startSentencesTypeFlow = () => {
    const items = buildSentenceItems(passages);
    if (items.length === 0) return;
    setQueue(items);
    setQueueSnapshot(items.map((x) => ({ ...x })));
    setFlowKind('sentencesType');
    setIdx(0);
    setWrongSentences([]);
    setInputText('');
    setResultsRows([]);
    setPhase('sentencesTypeActive');
  };

  const startSentencesPaperFlow = () => {
    const items = buildSentenceItems(passages);
    if (items.length === 0) return;
    setQueue(items);
    setQueueSnapshot(items.map((x) => ({ ...x })));
    setFlowKind('sentencesPaper');
    setIdx(0);
    setInputText('');
    setResultsRows([]);
    setPhase('sentencesPaperActive');
  };

  const onNextWordsOrTypeSentence = async () => {
    if (!current) return;
    if (phase === 'wordsActive') {
      setAnswers((prev) => {
        const copy = [...prev];
        copy[idx] = inputText;
        return copy;
      });
      const typed = inputText;
      const correct = answersMatch(typed, current.text);
      const row = {
        expected: current.text,
        typed,
        correct,
        tag: current.tag ?? null,
      };
      const { data: { user } = {} } = await supabase.auth.getUser();
      if (user) {
        const currentWord = current.text;
        const wordObj = words.find((w) =>
          (typeof w === 'string' ? w : w.word) === currentWord
        );
        if (wordObj?.id) {
          await updateWordMastery(
            user.id,
            wordObj.id,
            String(wordObj.week_label ?? current.week_label ?? weekLabelForQuery ?? ''),
            correct
          );
        }
      }
      const isLast = idx + 1 >= queue.length;
      setResultsRows((prev) => [...prev, row]);
      if (isLast) {
        const rawW = params.weekLabel;
        const weekFromParams =
          rawW == null ? '' : Array.isArray(rawW) ? String(rawW[0] ?? '') : String(rawW);
        const weekLabel =
          String(weekLabelForQuery || weekFromParams || '').trim() ||
          String(
            words.find((w) => typeof w === 'object' && w?.week_label)?.week_label ?? '',
          ).trim();
        const nextResults = [...resultsRows, row];
        if (user) {
          const allCorrect = nextResults.every((r) => r.correct === true);
          if (allCorrect && nextResults.length > 0 && weekLabel) {
            const reward = await completeWeek(user.id, weekLabel);
            if (reward) {
              setModalFlower(reward.flower);
              setModalCreature(reward.newCreature);
              setModalTotalFlowers(reward.totalFlowers);
              setModalVisible(true);
            }
          }
        }
        setPhase('results');
      } else {
        setIdx((i) => i + 1);
      }
      return;
    }
    if (phase === 'sentencesTypeActive' && !sentenceNextReady) return;
    const typed = inputText;
    const correct = answersMatch(typed, current.text);
    const row = {
      expected: current.text,
      typed,
      correct,
      tag: current.tag ?? null,
    };
    const isLast = idx + 1 >= queue.length;
    setResultsRows((prev) => [...prev, row]);
    if (isLast) {
      setPhase('results');
    } else {
      setIdx((i) => i + 1);
      setInputText('');
    }
  };

  const onPrevWords = () => {
    if (phase !== 'wordsActive' || idx <= 0) return;
    setAnswers((prev) => {
      const copy = [...prev];
      copy[idx] = inputText;
      return copy;
    });
    setResultsRows((prev) => prev.slice(0, -1));
    setIdx((i) => i - 1);
  };

  const confirmQuitWords = () => {
    Alert.alert('Quit dictation?', 'Your progress will be lost. Are you sure?', [
      {
        text: 'Yes, quit',
        style: 'destructive',
        onPress: () => router.push('/home'),
      },
      { text: 'Keep going', style: 'cancel' },
    ]);
  };

  const onPaperNext = () => {
    if (phase !== 'sentencesPaperActive' || !hasPlayed) return;
    if (idx + 1 >= queue.length) {
      setPhase('answerReveal');
      return;
    }
    paperAutoAdvanceRef.current = true;
    setIdx((i) => i + 1);
  };

  const onTryAgain = () => {
    const snap = queueSnapshot.length ? queueSnapshot.map((x) => ({ ...x })) : [];
    setQueue(snap);
    setIdx(0);
    setAnswers([]);
    setWrongWords([]);
    setWrongSentences([]);
    setInputText('');
    setResultsRows([]);
    if (flowKind === 'words') setPhase('wordsActive');
    else if (flowKind === 'sentencesType') setPhase('sentencesTypeActive');
    else if (flowKind === 'sentencesPaper') setPhase('sentencesPaperActive');
  };

  const redoWrongSentencesOnly = () => {
    if (wrongSentences.length === 0) return;
    // Align by index with current `queue` (subset after a prior "redo wrong"), not `queueSnapshot`.
    const items = resultsRows
      .map((r, i) => (!r.correct && queue[i] ? { ...queue[i] } : null))
      .filter(Boolean);
    if (items.length === 0) return;
    setQueue(items.map((x, i) => ({ ...x, id: `${x.id}-redo-${i}` })));
    setIdx(0);
    setInputText('');
    setResultsRows([]);
    setWrongSentences([]);
    setPhase('sentencesTypeActive');
  };

  const redoAllSentences = () => {
    if (flowKind !== 'sentencesType') return;
    const snap = queueSnapshot.length ? queueSnapshot.map((x) => ({ ...x })) : [];
    setQueue(snap);
    setIdx(0);
    setInputText('');
    setResultsRows([]);
    setWrongSentences([]);
    setPhase('sentencesTypeActive');
  };

  /** Paper mode: restart full sentence list from sentence 1. */
  const redoAllPaperSentences = () => {
    if (flowKind !== 'sentencesPaper') return;
    const snap = queueSnapshot.length ? queueSnapshot.map((x) => ({ ...x })) : [];
    if (snap.length === 0) return;
    setQueue(snap);
    setIdx(0);
    setPhase('sentencesPaperActive');
  };

  const score = resultsRows.filter((r) => r.correct).length;
  const scoreTotal = resultsRows.length;
  const scorePct = scoreTotal > 0 ? score / scoreTotal : 0;

  const hasWordPhraseContent = buildMixedWordPhraseItems(words).length > 0;
  const hasSentenceContent = buildSentenceItems(passages).length > 0;

  const playWordOrPhrase = () =>
    void playTts(current?.text, { speed: TTS_SPEED_WORDS });

  const playSentenceAudio = () => {
    void (async () => {
      const fk = flowKindRef.current;
      const isSentenceFlow = fk === 'sentencesType' || fk === 'sentencesPaper';
      const raw = String(current?.text ?? '').trim();
      if (!raw) return;

      if (
        isSentenceFlow &&
        idx > 0 &&
        !hasPlayed &&
        lastSentenceEndAtRef.current > 0
      ) {
        const elapsed = Date.now() - lastSentenceEndAtRef.current;
        if (elapsed < SENTENCE_GAP_MS) {
          await new Promise((r) => setTimeout(r, SENTENCE_GAP_MS - elapsed));
        }
      }

      const ttsInput = isSentenceFlow ? sentenceTextToTtsInput(raw) : raw;
      await playTts(ttsInput, {
        speed: TTS_SPEED_SENTENCES,
        ...(fk === 'sentencesPaper' ? {} : { onPlaybackEnd: startPostPlaybackCountdown }),
      });
    })();
  };

  const confirmQuitPaper = () => {
    Alert.alert('Quit dictation?', 'Your progress will be lost. Are you sure?', [
      {
        text: 'Yes, quit',
        style: 'destructive',
        onPress: () => router.push('/home'),
      },
      { text: 'Keep going', style: 'cancel' },
    ]);
  };

  return (
    <View style={styles.container}>
      <View style={[styles.pageHeader, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={styles.backBtnText}>←</Text>
        </TouchableOpacity>
        <View>
          <Text style={styles.pageTitle}>Dictation Test</Text>
          <Text style={styles.pageSubtitle}>Choose a practice mode</Text>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.kav}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={64}
      >
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 40 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
        {phase === 'modeSelect' ? (
          <View style={styles.block}>
            {weekDataLoading ? (
              <View style={styles.loadingBlock}>
                <ActivityIndicator color={BLUE} />
                <Text style={styles.hintMuted}>{"Loading this week's words and passages…"}</Text>
              </View>
            ) : (
              <>
                {weekDataError ? <Text style={styles.warn}>{weekDataError}</Text> : null}
                <TouchableOpacity
                  style={[styles.dictCardPrimary, !hasWordPhraseContent && styles.btnDisabled]}
                  onPress={startWordsFlow}
                  disabled={!hasWordPhraseContent}
                  activeOpacity={0.85}
                >
                  <View style={styles.dictCardTop}>
                    <Text style={styles.dictIcon}>📝</Text>
                    <Text style={styles.dictTitlePrimary}>Words & Phrases</Text>
                    <View style={styles.dictBadge}>
                      <Text style={styles.dictBadgeText}>POPULAR</Text>
                    </View>
                  </View>
                  <Text style={styles.dictSubPrimary}>
                    From your spelling list · random order · auto-graded
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.dictCard, !hasSentenceContent && styles.btnDisabled]}
                  onPress={startSentencesTypeFlow}
                  disabled={!hasSentenceContent}
                  activeOpacity={0.85}
                >
                  <View style={styles.dictCardTop}>
                    <Text style={styles.dictIcon}>⌨️</Text>
                    <Text style={styles.dictTitle}>Sentences (Typing)</Text>
                  </View>
                  <Text style={styles.dictSub}>
                    Hear a sentence · type your answer · auto-graded
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[styles.dictCard, !hasSentenceContent && styles.btnDisabled]}
                  onPress={startSentencesPaperFlow}
                  disabled={!hasSentenceContent}
                  activeOpacity={0.85}
                >
                  <View style={styles.dictCardTop}>
                    <Text style={styles.dictIcon}>✏️</Text>
                    <Text style={styles.dictTitle}>Sentences (Paper)</Text>
                  </View>
                  <Text style={styles.dictSub}>
                    Hear the sentence · write on paper · check answers after
                  </Text>
                </TouchableOpacity>

                {!weekDataError && !hasWordPhraseContent && !hasSentenceContent ? (
                  <Text style={styles.warn}>
                    No words or passages for this week. Add a list and/or passage from Import first.
                  </Text>
                ) : null}
              </>
            )}
          </View>
        ) : null}

        {(phase === 'wordsActive' || phase === 'sentencesTypeActive') && current ? (
          <View style={styles.block}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
            <Text style={styles.counter}>
              {idx + 1} / {total}
            </Text>

            {phase === 'wordsActive' ? (
              <View
                style={[
                  styles.typeTag,
                  current.tag === 'phrase' ? styles.tagPhrase : styles.tagWord,
                ]}
              >
                <Text style={styles.typeTagText}>{current.tag === 'phrase' ? 'phrase' : 'word'}</Text>
              </View>
            ) : null}

            <TouchableOpacity
              style={[styles.playBig, ttsBusy && styles.playDisabled]}
              onPress={phase === 'wordsActive' ? playWordOrPhrase : playSentenceAudio}
              disabled={ttsBusy}
              activeOpacity={0.85}
            >
              {ttsBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.playBigText}>
                  {hasPlayed ? '🔊 Play again' : '🔊 Play'}
                </Text>
              )}
            </TouchableOpacity>

            {phase === 'sentencesTypeActive' && sentenceCountdown != null ? (
              <Text style={styles.countdownHint}>Next in {sentenceCountdown}...</Text>
            ) : null}
            {phase === 'sentencesTypeActive' &&
            !sentenceNextReady &&
            sentenceCountdown == null &&
            !ttsBusy ? (
              <Text style={styles.hintMuted}>
                Tap Play to listen. After the audio, a 3-second countdown runs before you can tap Next.
              </Text>
            ) : null}

            <TextInput
              style={styles.input}
              placeholder="Type what you heard..."
              placeholderTextColor="#999"
              value={inputText}
              onChangeText={setInputText}
              autoCapitalize="none"
              autoCorrect={false}
              multiline={phase === 'sentencesTypeActive'}
            />

            {phase === 'wordsActive' ? (
              <>
                <View style={styles.wordsNavRow}>
                  <TouchableOpacity
                    style={[
                      styles.wordsPrevBtn,
                      idx === 0 && styles.wordsPrevBtnDisabled,
                    ]}
                    onPress={onPrevWords}
                    disabled={idx === 0}
                    activeOpacity={0.85}
                  >
                    <Text
                      style={[
                        styles.wordsPrevBtnText,
                        idx === 0 && styles.wordsPrevBtnTextDisabled,
                      ]}
                    >
                      ← Prev
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.primaryBtnWordsNext}
                    onPress={onNextWordsOrTypeSentence}
                    activeOpacity={0.85}
                  >
                    <Text style={styles.primaryBtnText}>Next →</Text>
                  </TouchableOpacity>
                </View>
                <TouchableOpacity
                  style={styles.quitLink}
                  onPress={confirmQuitWords}
                  hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
                >
                  <Text style={styles.quitLinkText}>✕ Quit</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    phase === 'sentencesTypeActive' && !sentenceNextReady && styles.btnDisabled,
                  ]}
                  onPress={onNextWordsOrTypeSentence}
                  disabled={phase === 'sentencesTypeActive' && !sentenceNextReady}
                  activeOpacity={0.85}
                >
                  <Text style={styles.primaryBtnText}>Next →</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.textLink} onPress={() => router.back()}>
                  <Text style={styles.textLinkLabel}>← Back</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        ) : null}

        {phase === 'sentencesPaperActive' && current ? (
          <View style={styles.block}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
            <Text style={styles.counter}>
              {idx + 1} / {total}
            </Text>

            <View style={styles.paperCard}>
              <Text style={styles.paperEmoji}>📝</Text>
              <Text style={styles.paperTitle}>Write your answer on paper</Text>
            </View>

            <TouchableOpacity
              style={[styles.playBig, ttsBusy && styles.playDisabled]}
              onPress={playSentenceAudio}
              disabled={ttsBusy}
              activeOpacity={0.85}
            >
              <Text style={styles.playBigText}>
                {ttsBusy ? '🔊 Playing...' : hasPlayed ? '🔊 Play again' : '🔊 Play'}
              </Text>
            </TouchableOpacity>

            <Text style={styles.hintMuted}>
              Tap Play to hear the sentence, write it on paper, then tap Done when ready for the next.
            </Text>

            <TouchableOpacity
              style={[styles.primaryBtn, !hasPlayed && styles.paperDoneDimmed]}
              onPress={onPaperNext}
              disabled={!hasPlayed}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Done, next →</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.quitLink}
              onPress={confirmQuitPaper}
              hitSlop={{ top: 12, bottom: 12, left: 24, right: 24 }}
            >
              <Text style={styles.quitLinkText}>✕ Quit</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'results' && flowKind === 'words' ? (
          <View style={styles.block}>
            <Text style={styles.wordsScoreTitle}>
              {score} / {scoreTotal} correct
            </Text>

            {resultsRows.map((row, i) => (
              <View key={`w-r-${i}`} style={styles.wordsResultRow}>
                {row.correct ? (
                  <Text style={styles.wordsResultOkLine}>
                    ✓ <Text style={styles.wordsResultOkWord}>{row.expected}</Text>
                  </Text>
                ) : (
                  <View>
                    <Text style={styles.wordsResultWrongLine}>
                      ✗ <Text style={styles.wordsResultWrongWord}>{row.expected}</Text>
                    </Text>
                    <Text style={styles.wordsResultYouTyped}>
                      You typed: {String(row.typed ?? '').trim() || '(empty)'}
                    </Text>
                  </View>
                )}
              </View>
            ))}

            {wrongWords.length > 0 ? (
              <TouchableOpacity
                style={styles.reviewOrangeBtn}
                onPress={() =>
                  router.push({
                    pathname: '/review',
                    params: { wrongWords: JSON.stringify(wrongWords) },
                  })
                }
                activeOpacity={0.85}
              >
                <Text style={styles.reviewOrangeBtnText}>
                  Review {wrongWords.length} wrong word{wrongWords.length === 1 ? '' : 's'}
                </Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity style={styles.secondaryBtn} onPress={onTryAgain} activeOpacity={0.85}>
              <Text style={styles.secondaryBtnText}>Redo all words</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.homeGrayBtn} onPress={() => router.push('/home')} activeOpacity={0.85}>
              <Text style={styles.homeGrayBtnText}>Back to home</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'results' && flowKind === 'sentencesType' ? (
          <View style={styles.block}>
            <Text style={styles.wordsScoreTitle}>
              {score} / {scoreTotal} correct
            </Text>

            {resultsRows.map((row, i) => (
              <View key={`sent-r-${i}`} style={styles.sentenceResultRow}>
                {row.correct ? (
                  <Text style={styles.sentenceResultOkLine}>
                    ✓{' '}
                    <Text style={styles.sentenceResultOkPreview}>{truncateSentencePreview(row.expected)}</Text>
                  </Text>
                ) : (
                  <View>
                    <Text style={styles.sentenceResultWrongLine}>
                      ✗{' '}
                      <Text style={styles.sentenceResultWrongPreview}>
                        {truncateSentencePreview(row.expected)}
                      </Text>
                    </Text>
                    <Text style={styles.sentenceWrongCmp}>
                      {firstWrongWordComparison(row.typed, row.expected)}
                    </Text>
                  </View>
                )}
              </View>
            ))}

            {wrongSentences.length > 0 ? (
              <TouchableOpacity
                style={styles.redoWrongOutlineBtn}
                onPress={redoWrongSentencesOnly}
                activeOpacity={0.85}
              >
                <Text style={styles.redoWrongOutlineBtnText}>
                  Redo wrong sentences ({wrongSentences.length})
                </Text>
              </TouchableOpacity>
            ) : null}

            <TouchableOpacity style={styles.secondaryBtn} onPress={redoAllSentences} activeOpacity={0.85}>
              <Text style={styles.secondaryBtnText}>Redo all sentences</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.homeGrayBtn} onPress={() => router.push('/home')} activeOpacity={0.85}>
              <Text style={styles.homeGrayBtnText}>Back to home</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'answerReveal' && flowKind === 'sentencesPaper' ? (
          <View style={styles.block}>
            <Text style={styles.revealTitle}>Check your answers</Text>
            <Text style={styles.paperResultsSubtitle}>Compare with the correct sentences below</Text>
            {queue.map((item, i) => (
              <View key={item.id} style={styles.paperAnswerItem}>
                <Text style={styles.paperSentenceNumberLabel}>Sentence {i + 1}</Text>
                <View style={styles.paperGreenAnswerBox}>
                  <Text style={styles.paperGreenAnswerText}>{item.text}</Text>
                </View>
              </View>
            ))}
            <TouchableOpacity style={styles.primaryBtn} onPress={redoAllPaperSentences} activeOpacity={0.85}>
              <Text style={styles.primaryBtnText}>Redo all sentences →</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.homeGrayBtn} onPress={() => router.push('/home')} activeOpacity={0.85}>
              <Text style={styles.homeGrayBtnText}>Back to home</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
      </KeyboardAvoidingView>

      <View style={styles.tabBar}>
        <TouchableOpacity style={styles.tabItem} onPress={() => router.push('/')}>
          <Text style={styles.tabIcon}>🏠</Text>
          <Text style={styles.tabLabel}>Home</Text>
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF8F0' },
  pageHeader: {
    backgroundColor: '#FFF8F0',
    paddingHorizontal: 16,
    paddingTop: 0,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F0E8DC',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'white',
    borderWidth: 1.5,
    borderColor: '#F0E8DC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backBtnText: { fontSize: 18, color: '#F97316', fontWeight: '700' },
  pageTitle: { fontSize: 16, fontWeight: '800', color: '#1A1A1A' },
  pageSubtitle: { fontSize: 10, color: '#999', marginTop: 1 },
  scrollArea: { flex: 1 },
  scrollContent: { padding: 14, gap: 8 },
  dictCardPrimary: {
    backgroundColor: '#F97316',
    borderRadius: 14,
    padding: 14,
    shadowColor: '#F97316',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  dictCard: {
    backgroundColor: 'white',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#F0E8DC',
    padding: 14,
  },
  dictCardTop: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  dictIcon: { fontSize: 22 },
  dictTitlePrimary: { fontSize: 15, fontWeight: '800', color: 'white', flex: 1 },
  dictTitle: { fontSize: 15, fontWeight: '700', color: '#1A1A1A', flex: 1 },
  dictSubPrimary: { fontSize: 10, color: 'rgba(255,255,255,0.75)', paddingLeft: 32 },
  dictSub: { fontSize: 10, color: '#999', paddingLeft: 32 },
  dictBadge: {
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  dictBadgeText: { fontSize: 8, fontWeight: '800', color: 'white', letterSpacing: 0.5 },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: 'white',
    borderTopWidth: 0.5,
    borderTopColor: '#F0EAE0',
    paddingBottom: 20,
    paddingTop: 8,
  },
  tabItem: { flex: 1, alignItems: 'center' },
  tabIcon: { fontSize: 20, marginBottom: 2 },
  tabLabel: { fontSize: 9, color: '#B0BEC5', fontWeight: '600' },

  kav: {
    flex: 1,
  },
  block: {
    gap: 16,
  },
  loadingBlock: {
    alignItems: 'center',
    gap: 12,
    paddingVertical: 24,
  },
  primaryBtn: {
    backgroundColor: BLUE,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  wordsNavRow: {
    flexDirection: 'row',
    gap: 10,
    alignSelf: 'stretch',
    alignItems: 'stretch',
  },
  wordsPrevBtn: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordsPrevBtnDisabled: {
    borderColor: '#ccc',
    backgroundColor: '#f5f5f5',
  },
  wordsPrevBtnText: {
    color: BLUE,
    fontSize: 17,
    fontWeight: '700',
  },
  wordsPrevBtnTextDisabled: {
    color: '#999',
  },
  primaryBtnWordsNext: {
    flex: 1,
    backgroundColor: BLUE,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quitLink: {
    alignSelf: 'center',
    paddingVertical: 10,
  },
  quitLinkText: {
    color: '#c00',
    fontSize: 15,
    fontWeight: '600',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.92)',
    fontSize: 14,
    marginTop: 6,
    textAlign: 'center',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  paperDoneDimmed: {
    opacity: 0.4,
  },
  secondaryBtn: {
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: BLUE,
    fontSize: 17,
    fontWeight: '700',
  },
  textLink: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
  },
  textLinkLabel: {
    color: BLUE,
    fontSize: 16,
    fontWeight: '600',
  },
  warn: {
    color: '#c00',
    fontSize: 14,
    textAlign: 'center',
  },
  countdownHint: {
    color: BLUE,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  hintMuted: {
    color: '#666',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  progressTrack: {
    height: 8,
    backgroundColor: '#e0e8f0',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: BLUE,
    borderRadius: 4,
  },
  counter: {
    fontSize: 16,
    fontWeight: '700',
    color: BLUE,
    textAlign: 'center',
  },
  typeTag: {
    alignSelf: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
  },
  tagWord: {
    backgroundColor: BLUE,
  },
  tagPhrase: {
    backgroundColor: GREEN_PHRASE,
  },
  typeTagText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
    textTransform: 'uppercase',
  },
  playBig: {
    backgroundColor: BLUE,
    borderRadius: 16,
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 64,
  },
  playDisabled: {
    opacity: 0.7,
  },
  playBigText: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '800',
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 17,
    color: '#222',
    minHeight: 48,
    textAlignVertical: 'top',
  },
  paperCard: {
    backgroundColor: '#f5f5f5',
    borderRadius: 16,
    padding: 28,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  paperEmoji: {
    fontSize: 48,
    marginBottom: 8,
  },
  paperTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#444',
    textAlign: 'center',
  },
  wordsScoreTitle: {
    fontSize: 34,
    fontWeight: '800',
    color: BLUE,
    textAlign: 'center',
    marginBottom: 8,
  },
  wordsResultRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    paddingVertical: 12,
  },
  wordsResultOkLine: {
    fontSize: 18,
    color: '#1b5e20',
  },
  wordsResultOkWord: {
    color: '#222',
    fontWeight: '600',
  },
  wordsResultWrongLine: {
    fontSize: 18,
    color: '#b71c1c',
  },
  wordsResultWrongWord: {
    color: '#b71c1c',
    fontWeight: '700',
  },
  wordsResultYouTyped: {
    fontSize: 14,
    color: '#c62828',
    marginTop: 6,
  },
  reviewOrangeBtn: {
    backgroundColor: '#e65100',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  reviewOrangeBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  homeGrayBtn: {
    backgroundColor: '#9e9e9e',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  homeGrayBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  sentenceResultRow: {
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    paddingVertical: 12,
  },
  sentenceResultOkLine: {
    fontSize: 17,
    color: '#1b5e20',
  },
  sentenceResultOkPreview: {
    color: '#222',
    fontWeight: '600',
  },
  sentenceResultWrongLine: {
    fontSize: 17,
    color: '#b71c1c',
  },
  sentenceResultWrongPreview: {
    color: '#b71c1c',
    fontWeight: '700',
  },
  sentenceWrongCmp: {
    fontSize: 13,
    color: '#666',
    marginTop: 6,
  },
  redoWrongOutlineBtn: {
    borderWidth: 2,
    borderColor: '#c62828',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  redoWrongOutlineBtnText: {
    color: '#c62828',
    fontSize: 17,
    fontWeight: '700',
  },
  scoreBig: {
    fontSize: 40,
    fontWeight: '800',
    color: BLUE,
    textAlign: 'center',
  },
  encourage: {
    fontSize: 18,
    color: '#333',
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 26,
  },
  resultCard: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 12,
    padding: 14,
    marginTop: 4,
    backgroundColor: 'rgba(255,255,255,0.88)',
  },
  miniTag: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  tagWordTxt: {
    color: BLUE,
  },
  tagPhraseTxt: {
    color: GREEN_PHRASE,
  },
  resultOk: {
    fontSize: 17,
    color: '#1b5e20',
  },
  resultOkStrong: {
    fontWeight: '700',
  },
  resultBad: {
    fontSize: 17,
    color: '#b71c1c',
    fontWeight: '700',
    marginBottom: 8,
  },
  resultLabel: {
    fontSize: 13,
    color: '#666',
    marginTop: 8,
    marginBottom: 4,
  },
  resultExpected: {
    fontSize: 16,
    fontWeight: '600',
    color: '#222',
  },
  diffWrap: {
    flexWrap: 'wrap',
    flexDirection: 'row',
    flexShrink: 1,
  },
  diffOk: {
    color: '#222',
    fontSize: 16,
  },
  diffWrong: {
    color: '#c62828',
    fontWeight: '700',
    fontSize: 16,
  },
  diffHint: {
    color: '#999',
    fontSize: 14,
  },
  revealTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#222',
    textAlign: 'center',
  },
  paperResultsSubtitle: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 22,
  },
  paperAnswerItem: {
    gap: 8,
  },
  paperSentenceNumberLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#222',
  },
  paperGreenAnswerBox: {
    backgroundColor: '#e8f5e9',
    borderWidth: 1,
    borderColor: '#a5d6a7',
    borderRadius: 12,
    padding: 14,
  },
  paperGreenAnswerText: {
    fontSize: 16,
    color: '#1b5e20',
    lineHeight: 24,
    fontWeight: '500',
  },
});
