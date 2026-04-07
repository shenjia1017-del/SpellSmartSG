import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

import {
  fetchOpenAITtsAudio,
  TTS_LANGUAGE,
  TTS_VOICE_WORD,
} from '../../lib/phonics';

const BLUE = '#378ADD';
const GREEN_PHRASE = '#2e7d32';
const TTS_MIN_MS = 800;
/** Words & phrases dictation — slower than default. */
const TTS_SPEED_WORDS = 0.75;
/** Full sentences — slower for young students. */
const TTS_SPEED_SENTENCES = 0.65;

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

function buildMixedWordPhraseItems(words, passages) {
  const out = [];
  for (const w of words || []) {
    const text = String(w?.word ?? '').trim();
    if (!text) continue;
    out.push({
      id: `w-${out.length}-${text.slice(0, 24)}`,
      text,
      week_label: String(w?.week_label ?? ''),
      tag: text.includes(' ') ? 'phrase' : 'word',
    });
  }
  for (const p of passages || []) {
    const text = String(p?.body ?? '').trim();
    if (!text) continue;
    out.push({
      id: `p-${out.length}-${text.slice(0, 24)}`,
      text,
      week_label: String(p?.week_label ?? ''),
      tag: 'phrase',
    });
  }
  return shuffle(out);
}

/**
 * Split stored passage block into sentences (keeps final "." for natural TTS pauses).
 * Splits on ". " or ".\n" after normalizing newlines.
 */
function splitPassageIntoSentences(body) {
  const raw = String(body ?? '').trim();
  if (!raw) return [];
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\.\n/g, '. ');
  const parts = normalized
    .split('. ')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.map((seg) => (/[.!?]$/.test(seg) ? seg : `${seg}.`));
}

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
  return shuffle(out);
}

function normalizeAnswer(s) {
  return String(s ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function answersMatch(typed, expected) {
  return normalizeAnswer(typed).toLowerCase() === normalizeAnswer(expected).toLowerCase();
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
  const navigation = useNavigation();
  const params = useLocalSearchParams();
  const words = useMemo(() => {
    const raw = params.wordsJSON;
    const s = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
    return parseJsonArrayParam(s);
  }, [params.wordsJSON]);
  const passages = useMemo(() => {
    const raw = params.passagesJSON;
    const s = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
    return parseJsonArrayParam(s);
  }, [params.passagesJSON]);

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
  const [ttsBusy, setTtsBusy] = useState(false);
  const [resultsRows, setResultsRows] = useState([]);
  /** Sentence flows: Next allowed only after playback + 3s countdown. */
  const [sentenceNextReady, setSentenceNextReady] = useState(false);
  /** 3 | 2 | 1 while counting down, null when idle / done. */
  const [sentenceCountdown, setSentenceCountdown] = useState(null);

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

  useLayoutEffect(() => {
    let title = 'Dictation';
    if (phase === 'modeSelect') title = 'Dictation';
    else if (phase === 'sentenceModeSelect') title = 'Sentences';
    else if (phase === 'wordsActive') title = 'Words & Phrases';
    else if (phase === 'sentencesTypeActive') title = 'Sentences';
    else if (phase === 'sentencesPaperActive') title = 'Write on paper';
    else if (phase === 'results') title = 'Results';
    else if (phase === 'answerReveal') title = 'Answers';
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

  const startWordsFlow = () => {
    const items = buildMixedWordPhraseItems(words, passages);
    if (items.length === 0) {
      return;
    }
    setQueue(items);
    setQueueSnapshot(items.map((x) => ({ ...x })));
    setFlowKind('words');
    setIdx(0);
    setInputText('');
    setResultsRows([]);
    setPhase('wordsActive');
  };

  const startSentencesTypeFlow = () => {
    const items = buildSentenceItems(passages);
    if (items.length === 0) return;
    setQueue(items);
    setQueueSnapshot(items.map((x) => ({ ...x })));
    setFlowKind('sentencesType');
    setIdx(0);
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

  const onNextWordsOrTypeSentence = () => {
    if (!current) return;
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

  const onPaperNext = () => {
    if (phase === 'sentencesPaperActive' && !sentenceNextReady) return;
    if (idx + 1 >= queue.length) {
      setPhase('answerReveal');
      return;
    }
    setIdx((i) => i + 1);
  };

  const onTryAgain = () => {
    const snap = queueSnapshot.length ? queueSnapshot.map((x) => ({ ...x })) : [];
    setQueue(snap);
    setIdx(0);
    setInputText('');
    setResultsRows([]);
    if (flowKind === 'words') setPhase('wordsActive');
    else if (flowKind === 'sentencesType') setPhase('sentencesTypeActive');
  };

  const score = resultsRows.filter((r) => r.correct).length;
  const scoreTotal = resultsRows.length;
  const scorePct = scoreTotal > 0 ? score / scoreTotal : 0;

  const hasWordPhraseContent =
    buildMixedWordPhraseItems(words, passages).length > 0;
  const hasSentenceContent = buildSentenceItems(passages).length > 0;

  const playWordOrPhrase = () =>
    void playTts(current?.text, { speed: TTS_SPEED_WORDS });

  const playSentenceAudio = () =>
    void playTts(current?.text, {
      speed: TTS_SPEED_SENTENCES,
      onPlaybackEnd: startPostPlaybackCountdown,
    });

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={64}
    >
      <ScrollView
        contentContainerStyle={styles.scrollInner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {phase === 'modeSelect' ? (
          <View style={styles.block}>
            <Text style={styles.lead}>Choose how you want to practise dictation.</Text>
            <TouchableOpacity
              style={[styles.primaryBtn, !hasWordPhraseContent && styles.btnDisabled]}
              onPress={startWordsFlow}
              disabled={!hasWordPhraseContent}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Words & Phrases</Text>
              <Text style={styles.subtitle}>Mixed together, random order</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.primaryBtn, !hasSentenceContent && styles.btnDisabled]}
              onPress={() => setPhase('sentenceModeSelect')}
              disabled={!hasSentenceContent}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Sentences</Text>
              <Text style={styles.subtitle}>Choose how to answer</Text>
            </TouchableOpacity>
            {!hasWordPhraseContent && !hasSentenceContent ? (
              <Text style={styles.warn}>No words or passages to dictate. Add content from Import first.</Text>
            ) : null}
            <TouchableOpacity style={styles.textLink} onPress={() => router.back()}>
              <Text style={styles.textLinkLabel}>← Back</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'sentenceModeSelect' ? (
          <View style={styles.block}>
            <Text style={styles.lead}>How do you want to answer?</Text>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={startSentencesTypeFlow}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Type on screen</Text>
              <Text style={styles.subtitle}>SpellSmart marks your answers</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={startSentencesPaperFlow}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Write on paper</Text>
              <Text style={styles.subtitle}>SpellSmart shows answers at the end</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.textLink} onPress={() => router.back()}>
              <Text style={styles.textLinkLabel}>← Back</Text>
            </TouchableOpacity>
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
                <Text style={styles.playBigText}>🔊 Play</Text>
              )}
            </TouchableOpacity>

            <Pressable
              onPress={phase === 'wordsActive' ? playWordOrPhrase : playSentenceAudio}
              disabled={ttsBusy}
            >
              <Text style={styles.playAgain}>🔊 Play again</Text>
            </Pressable>

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
              {ttsBusy ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.playBigText}>🔊 Play sentence</Text>
              )}
            </TouchableOpacity>

            <Pressable onPress={playSentenceAudio} disabled={ttsBusy}>
              <Text style={styles.playAgain}>🔊 Play again</Text>
            </Pressable>

            {sentenceCountdown != null ? (
              <Text style={styles.countdownHint}>Next in {sentenceCountdown}...</Text>
            ) : null}
            {!sentenceNextReady && sentenceCountdown == null && !ttsBusy ? (
              <Text style={styles.hintMuted}>
                Tap Play to listen. After the audio, a 3-second countdown runs before you can go to the next sentence.
              </Text>
            ) : null}

            <TouchableOpacity
              style={[styles.primaryBtn, !sentenceNextReady && styles.btnDisabled]}
              onPress={onPaperNext}
              disabled={!sentenceNextReady}
              activeOpacity={0.85}
            >
              <Text style={styles.primaryBtnText}>Done, next →</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.textLink} onPress={() => router.back()}>
              <Text style={styles.textLinkLabel}>← Back</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'results' ? (
          <View style={styles.block}>
            <Text style={styles.scoreBig}>
              {score} / {scoreTotal}
            </Text>
            <Text style={styles.encourage}>{scoreMessage(scorePct)}</Text>

            {resultsRows.map((row, i) => (
              <View key={`r-${i}`} style={styles.resultCard}>
                {row.tag ? (
                  <Text style={[styles.miniTag, row.tag === 'phrase' ? styles.tagPhraseTxt : styles.tagWordTxt]}>
                    {row.tag}
                  </Text>
                ) : null}
                {row.correct ? (
                  <Text style={styles.resultOk}>
                    ✓ <Text style={styles.resultOkStrong}>{row.expected}</Text>
                  </Text>
                ) : (
                  <View>
                    <Text style={styles.resultBad}>✗ Incorrect</Text>
                    <Text style={styles.resultLabel}>You typed:</Text>
                    <StudentAnswerHighlights typed={row.typed} expected={row.expected} />
                    <Text style={styles.resultLabel}>Correct answer:</Text>
                    <Text style={styles.resultExpected}>{row.expected}</Text>
                  </View>
                )}
              </View>
            ))}

            <TouchableOpacity style={styles.primaryBtn} onPress={onTryAgain} activeOpacity={0.85}>
              <Text style={styles.primaryBtnText}>Try again →</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => router.push('/home')} activeOpacity={0.85}>
              <Text style={styles.secondaryBtnText}>Back to Home</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.textLink} onPress={() => router.back()}>
              <Text style={styles.textLinkLabel}>← Back</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {phase === 'answerReveal' ? (
          <View style={styles.block}>
            <Text style={styles.revealTitle}>Check your answers</Text>
            <Text style={styles.revealSub}>SpellSmart has the answers — check what you wrote!</Text>
            {queue.map((item, i) => (
              <View key={item.id} style={styles.revealCard}>
                <Text style={styles.revealNum}>Sentence {i + 1}</Text>
                <Text style={styles.revealBody}>{item.text}</Text>
              </View>
            ))}
            <TouchableOpacity style={styles.primaryBtn} onPress={() => router.push('/home')} activeOpacity={0.85}>
              <Text style={styles.primaryBtnText}>Done! →</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.textLink} onPress={() => router.back()}>
              <Text style={styles.textLinkLabel}>← Back</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#fff',
  },
  scrollInner: {
    padding: 20,
    paddingBottom: 40,
  },
  block: {
    gap: 16,
  },
  lead: {
    fontSize: 17,
    color: '#333',
    marginBottom: 8,
    lineHeight: 24,
  },
  primaryBtn: {
    backgroundColor: BLUE,
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 20,
    alignItems: 'center',
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
  playAgain: {
    color: BLUE,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: -4,
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
    backgroundColor: '#fafafa',
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
  revealSub: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 12,
    lineHeight: 22,
  },
  revealCard: {
    backgroundColor: '#f0f0f0',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  revealNum: {
    fontSize: 13,
    fontWeight: '700',
    color: BLUE,
    marginBottom: 8,
  },
  revealBody: {
    fontSize: 16,
    color: '#333',
    lineHeight: 24,
  },
});
