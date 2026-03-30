import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

import { ensurePhonemeClipsInStorage } from '../../lib/phonemeStorage';
import { fetchOpenAITtsAudio, splitPhonicsToSyllables } from '../../lib/phonics';
import { supabase } from '../../lib/supabase';

const CLAUDE_MIN_INTERVAL_MS = 2000;
const TTS_MIN_INTERVAL_MS = 800;

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const anthropicKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;

function parseClaudeJson(text) {
  const trimmed = String(text ?? '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match?.[0]) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // ignore
    }
  }
  throw new Error('Could not parse learning content from Claude.');
}

const ALLOWED_DEF_TYPES = new Set(['verb', 'noun', 'adjective', 'adverb']);

function normalizeDefinitions(parsed) {
  const raw = Array.isArray(parsed?.definitions) ? parsed.definitions : [];
  return raw
    .map((d) => ({
      type: String(d?.type ?? '')
        .toLowerCase()
        .trim(),
      meaning: String(d?.meaning ?? '')
        .trim(),
    }))
    .filter((d) => ALLOWED_DEF_TYPES.has(d.type) && d.meaning)
    .slice(0, 3);
}

/** Keep only entries whose keys match practiceGraphemes segments (after " • "). */
function normalizeGraphemesPronunciation(parsed, practiceGraphemes) {
  const groups = splitPhonicsToSyllables(practiceGraphemes);
  const raw = parsed?.graphemesPronunciation;
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const g of groups) {
    const key = String(g).trim();
    if (!key) continue;
    const val = raw[key] ?? raw[key.toLowerCase()];
    if (typeof val === 'string' && val.trim()) {
      out[key] = val.trim();
    }
  }
  return out;
}

function derivePracticeWordFallback(display) {
  const t = String(display ?? '').trim();
  if (!t.includes(' ')) return t;
  const parts = t.split(/\s+/).filter(Boolean);
  if (!parts.length) return t;
  return [...parts].sort((a, b) => b.length - a.length)[0];
}

/** Syllable vs grapheme strings must differ; missing/duplicate graphemes fall back to per-letter split. */
function ensureDistinctGraphemes(practiceWord, practicePhonics, practiceGraphemes) {
  const w = String(practiceWord ?? '').trim();
  const pp = String(practicePhonics ?? '').trim();
  let pg = String(practiceGraphemes ?? '').trim();
  if (!pg || pg === '—') {
    pg = w.split('').join(' • ');
  }
  const compact = (s) => String(s).replace(/\s/g, '');
  if (w.length > 1 && compact(pg) === compact(pp)) {
    return w.split('').join(' • ');
  }
  return pg;
}

async function fetchClaudeCard(word) {
  console.log('[LearnScreen] Claude API key exists:', !!process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY);
  if (!anthropicKey) {
    console.error('[LearnScreen] Claude: missing EXPO_PUBLIC_ANTHROPIC_API_KEY');
    throw new Error('Missing EXPO_PUBLIC_ANTHROPIC_API_KEY in .env');
  }

  console.log('[LearnScreen] Claude request for word:', word, 'model:', CLAUDE_MODEL);

  const prompt = `You help Singapore primary school students (P1–P6) learn spelling.

For this exact spelling entry (may be a single word or a phrase): ${JSON.stringify(word)}

Return ONLY valid JSON with these keys (no markdown, no extra text):
- "phonics": syllable breakdown using bullet " • " between parts for the full entry (for reference only in your reasoning).
- "definition": one short English definition a child can understand (one or two sentences max).
- "example": one example sentence using the word or phrase naturally, in quotes in the string value only if you like.
- "emoji": exactly one Unicode emoji that fits the meaning (not multiple).
- "practiceWord": If the entry is a multi-word phrase, the single hardest or key spelling word to practice (copy spelling exactly as it appears inside the phrase). If the entry is already one word, use that exact same word.
- "practicePhonics": SYLLABLE breakdown by rhythm/beat for practiceWord ONLY (used in the Syllables activity). Use " • " between spoken syllables. Examples: "approached" → "ap • proached", "getting" → "get • ting", "enormous" → "e • nor • mous". The segments joined must spell practiceWord exactly (ignore spaces around bullets).
- "practiceGraphemes": PHONICS sound breakdown for practiceWord ONLY (used in the Phonics activity). Split by real sound units following English phonics rules, using " • " between parts. Examples: "approached" → "a • pp • r • oa • ch • ed", "getting" → "g • e • tt • i • ng", "enormous" → "e • n • or • m • ou • s". The segments joined must spell practiceWord exactly.
- CRITICAL: practicePhonics and practiceGraphemes MUST always be different from each other. Never output the same string for both. Syllable beats are fewer chunks than phonics sound units (except rare edge cases); if unsure, use more splits in practiceGraphemes than in practicePhonics.
- "graphemesPronunciation": object mapping each key from practiceGraphemes (split by " • ") to the EXACT text that text-to-speech should speak to produce the correct phonics sound for that grapheme (not IPA; use simple English spellings). Keys must be exactly those segment strings. Follow these rules for the values:
  • Single consonants: add "uh" after the letter sound (b→"buh", p→"puh", t→"tuh", d→"duh", and similarly for other single consonants).
  • Vowels: use the SHORT vowel sound (a→"ah", e→"eh", i→"ih", o→"oh", u→"uh").
  • Digraphs: sh→"shh", ch→"chh", th→"thh", ck→"k", ph→"fff", ng→"ing".
  • Vowel teams: oa→"oh", ai→"ay", ee→"eee", ou→"ow", oi→"oy".
  • R-controlled: ar→"arr", er→"err", or→"orr".
  • Multi-letter chunks: give natural spoken pronunciation (e.g. tion→"shun", ture→"cher").
  • NEVER use letter names: never "pee" for p, never "tee" for t, never "ess" for s—always phonics-style sounds as above.
- "definitions": array of up to 3 objects. ONLY use word types: "verb", "noun", "adjective", "adverb". Each object: {"type":"verb"|"noun"|"adjective"|"adverb","meaning":"short child-friendly English definition for that sense"}. Include only types that genuinely apply to practiceWord.

Keep vocabulary simple. British English spelling is fine when it matches the entry.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const rawBody = await response.text();

  console.log('[LearnScreen] Claude API HTTP status:', response.status, response.statusText);
  console.log('[LearnScreen] Claude API raw response body:', rawBody);

  let payload;
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch (parseErr) {
    console.error('[LearnScreen] Claude API JSON parse error:', parseErr);
    console.error('[LearnScreen] Claude API raw body (parse failed):', rawBody);
    throw new Error(`Claude API returned invalid JSON (HTTP ${response.status}).`);
  }

  console.log('[LearnScreen] Claude API parsed payload:', JSON.stringify(payload, null, 2));

  if (!response.ok) {
    console.error('[LearnScreen] Claude API error object:', payload?.error ?? payload);
    const msg =
      payload?.error?.message ??
      (rawBody ? rawBody.slice(0, 200) : null) ??
      `Claude request failed (HTTP ${response.status}).`;
    throw new Error(msg);
  }

  const blocks = Array.isArray(payload?.content) ? payload.content : [];
  const textParts = blocks
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text);
  const raw = textParts.join('\n').trim();
  if (!raw) {
    console.error('[LearnScreen] Claude API success but no text in content blocks. Full payload:', payload);
    throw new Error('Claude returned no text content.');
  }

  let parsed;
  try {
    parsed = parseClaudeJson(raw);
  } catch (jsonErr) {
    console.error('[LearnScreen] Claude model text could not be parsed as card JSON:', jsonErr);
    console.error('[LearnScreen] Claude model text (raw):', raw);
    throw jsonErr;
  }

  console.log('[LearnScreen] Claude card JSON parsed OK:', parsed);

  const displayEntry = String(word ?? '').trim();
  let practiceWord = String(parsed.practiceWord ?? '').trim();
  if (!practiceWord) {
    practiceWord = derivePracticeWordFallback(displayEntry);
  }
  let practicePhonics = String(parsed.practicePhonics ?? '').trim();
  if (!practicePhonics || practicePhonics === '—') {
    practicePhonics = practiceWord;
  }
  let practiceGraphemes = String(parsed.practiceGraphemes ?? '').trim();
  practiceGraphemes = ensureDistinctGraphemes(practiceWord, practicePhonics, practiceGraphemes);

  const definitions = normalizeDefinitions(parsed);
  const graphemesPronunciation = normalizeGraphemesPronunciation(parsed, practiceGraphemes);

  return {
    definition: String(parsed.definition ?? '').trim() || '—',
    example: String(parsed.example ?? '').trim() || '—',
    emoji: String(parsed.emoji ?? '').trim() || '📘',
    practiceWord,
    practicePhonics,
    practiceGraphemes,
    graphemesPronunciation,
    definitions,
  };
}

export default function LearnScreen({ navigation, route }) {
  const [userId, setUserId] = useState(null);
  const [words, setWords] = useState([]);
  const [index, setIndex] = useState(0);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingCard, setLoadingCard] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const cacheRef = useRef(new Map());
  const soundRef = useRef(null);
  const lastClaudeAt = useRef(0);
  const lastTtsAt = useRef(0);

  const currentWord = words[index]?.word ?? '';

  const [card, setCard] = useState({
    definition: '',
    example: '',
    emoji: '📘',
    practiceWord: '',
    practicePhonics: '',
    practiceGraphemes: '',
    graphemesPronunciation: {},
    definitions: [],
  });

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
      unloadSound();
    };
  }, [unloadSound]);

  useFocusEffect(
    useCallback(() => {
      if (route.params?.advanceToNextWord && words.length > 0) {
        setIndex((i) => Math.min(words.length - 1, i + 1));
        navigation.setParams({ advanceToNextWord: undefined });
      }
    }, [route.params?.advanceToNextWord, navigation, words.length]),
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoadingList(true);
      setErrorMsg(null);
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const uid = sessionData?.session?.user?.id;
        if (!uid) {
          if (!cancelled) {
            setErrorMsg('Log in to load your spelling list.');
            setWords([]);
          }
          return;
        }
        if (!cancelled) setUserId(uid);

        let query = supabase.from('words').select('id, word, learn_card_json').eq('user_id', uid);
        let { data, error } = await query.order('created_at', { ascending: true });

        if (error) {
          const retry = await supabase
            .from('words')
            .select('id, word, learn_card_json')
            .eq('user_id', uid)
            .order('id', { ascending: true });
          data = retry.data;
          error = retry.error;
        }

        if (error) throw error;

        const rows = Array.isArray(data) ? data : [];
        const list = rows
          .map((r) => ({
            id: r.id,
            word: String(r.word ?? '').trim(),
            learn_card_json: r.learn_card_json ?? null,
          }))
          .filter((r) => r.word.length > 0);

        if (!cancelled) {
          setWords(list);
          setIndex(0);
        }
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(e?.message ?? 'Failed to load words.');
          setWords([]);
        }
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentWord || !userId) {
      setCard({
        definition: '',
        example: '',
        emoji: '📘',
        practiceWord: '',
        practicePhonics: '',
        practiceGraphemes: '',
        graphemesPronunciation: {},
        definitions: [],
      });
      return;
    }

    const cached = cacheRef.current.get(currentWord);
    if (cached) {
      const pw = cached.practiceWord ?? derivePracticeWordFallback(currentWord);
      const pp = cached.practicePhonics && cached.practicePhonics !== '—' ? cached.practicePhonics : pw;
      const pgr = ensureDistinctGraphemes(
        pw,
        pp,
        cached.practiceGraphemes && String(cached.practiceGraphemes).trim() && cached.practiceGraphemes !== '—'
          ? String(cached.practiceGraphemes).trim()
          : '',
      );
      const defs = Array.isArray(cached.definitions) ? cached.definitions : [];
      const gp =
        cached.graphemesPronunciation &&
        typeof cached.graphemesPronunciation === 'object' &&
        !Array.isArray(cached.graphemesPronunciation)
          ? cached.graphemesPronunciation
          : {};
      setCard({
        ...cached,
        practiceWord: pw,
        practicePhonics: pp,
        practiceGraphemes: pgr,
        definitions: defs,
        graphemesPronunciation: gp,
      });
      if (pgr) {
        void ensurePhonemeClipsInStorage(pgr, gp);
      }
      return;
    }

    const row = words[index];
    const dbCard = row?.learn_card_json;
    if (dbCard && typeof dbCard === 'object' && String(dbCard.practiceWord || '').trim() && String(dbCard.practicePhonics || '').trim()) {
      const pw = String(dbCard.practiceWord).trim();
      const pp = String(dbCard.practicePhonics).trim() !== '—' ? String(dbCard.practicePhonics).trim() : pw;
      const pgr = ensureDistinctGraphemes(
        pw,
        pp,
        dbCard.practiceGraphemes && String(dbCard.practiceGraphemes).trim() && String(dbCard.practiceGraphemes).trim() !== '—'
          ? String(dbCard.practiceGraphemes).trim()
          : '',
      );
      const defs = Array.isArray(dbCard.definitions) ? dbCard.definitions : [];
      const gp =
        dbCard.graphemesPronunciation &&
        typeof dbCard.graphemesPronunciation === 'object' &&
        !Array.isArray(dbCard.graphemesPronunciation)
          ? dbCard.graphemesPronunciation
          : {};
      const normalized = {
        definition: String(dbCard.definition ?? '').trim() || '—',
        example: String(dbCard.example ?? '').trim() || '—',
        emoji: String(dbCard.emoji ?? '').trim() || '📘',
        practiceWord: pw,
        practicePhonics: pp,
        practiceGraphemes: pgr,
        definitions: defs,
        graphemesPronunciation: gp,
      };
      setCard(normalized);
      cacheRef.current.set(currentWord, normalized);
      void ensurePhonemeClipsInStorage(pgr, gp);
      return;
    }

    const wordKey = currentWord;
    const persistId = words[index]?.id;

    let cancelled = false;

    (async () => {
      const now = Date.now();
      const wait = CLAUDE_MIN_INTERVAL_MS - (now - lastClaudeAt.current);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      if (cancelled) return;

      setLoadingCard(true);
      setErrorMsg(null);
      try {
        lastClaudeAt.current = Date.now();
        const content = await fetchClaudeCard(wordKey);
        if (cancelled) return;
        cacheRef.current.set(wordKey, content);
        setCard(content);
        const pgr = ensureDistinctGraphemes(
          content.practiceWord,
          content.practicePhonics,
          content.practiceGraphemes,
        );
        if (pgr) {
          void ensurePhonemeClipsInStorage(pgr, content.graphemesPronunciation ?? {});
        }
        if (persistId) {
          const { error: upErr } = await supabase
            .from('words')
            .update({ learn_card_json: content })
            .eq('id', persistId);
          if (upErr) {
            console.warn('[LearnScreen] Failed to cache learn_card_json:', upErr);
          } else {
            setWords((prev) =>
              prev.map((w) => (w.id === persistId ? { ...w, learn_card_json: content } : w)),
            );
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error('[LearnScreen] Claude fetch failed (LearnScreen handler):', e);
          console.error('[LearnScreen] Claude fetch error message:', e?.message);
          setErrorMsg(e?.message ?? 'Failed to load card content.');
          setCard({
            definition: '—',
            example: '—',
            emoji: '📘',
            practiceWord: '',
            practicePhonics: '',
            practiceGraphemes: '',
            graphemesPronunciation: {},
            definitions: [],
          });
        }
      } finally {
        if (!cancelled) setLoadingCard(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentWord, userId, index, words]);

  const onPlayPronunciation = async () => {
    if (!currentWord || playing) return;

    const now = Date.now();
    const wait = TTS_MIN_INTERVAL_MS - (now - lastTtsAt.current);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    setPlaying(true);
    setErrorMsg(null);
    try {
      await unloadSound();
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
      });

      lastTtsAt.current = Date.now();
      const base64 = await fetchOpenAITtsAudio(currentWord);
      const dir = FileSystem.cacheDirectory;
      if (!dir) {
        throw new Error('Cache directory not available for audio.');
      }
      const fileUri = `${dir}tts-${Date.now()}.mp3`;
      await FileSystem.writeAsStringAsync(fileUri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const { sound } = await Audio.Sound.createAsync({ uri: fileUri });
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (status.isLoaded && status.didJustFinish) {
          setPlaying(false);
        }
      });
      await sound.playAsync();
    } catch (e) {
      setErrorMsg(e?.message ?? 'Could not play audio.');
      setPlaying(false);
    }
  };

  const goPractice = () => {
    if (!card.practiceWord) return;
    navigation.navigate('Practice', {
      practiceWord: card.practiceWord,
      practicePhonics: card.practicePhonics,
      practiceGraphemes: ensureDistinctGraphemes(
        card.practiceWord,
        card.practicePhonics,
        card.practiceGraphemes ?? '',
      ),
      graphemesPronunciation: card.graphemesPronunciation ?? {},
      definitions: card.definitions ?? [],
    });
  };

  const goPrev = () => {
    setIndex((i) => Math.max(0, i - 1));
  };

  const goNext = () => {
    setIndex((i) => Math.min(words.length - 1, i + 1));
  };

  if (loadingList) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color="#4A90E2" />
        <Text style={styles.muted}>Loading your words…</Text>
      </View>
    );
  }

  if (!userId) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.errorText}>{errorMsg ?? 'Not logged in.'}</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!words.length) {
    return (
      <View style={[styles.container, styles.centered]}>
        <Text style={styles.muted}>No words saved yet.</Text>
        <Text style={styles.hint}>Import a list from the Home screen first.</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.navRow}>
        <TouchableOpacity
          style={[styles.navBtn, index === 0 && styles.navBtnDisabled]}
          onPress={goPrev}
          disabled={index === 0}
        >
          <Text style={styles.navBtnText}>← Previous</Text>
        </TouchableOpacity>
        <Text style={styles.counter}>
          {index + 1} / {words.length}
        </Text>
        <TouchableOpacity
          style={[styles.navBtn, index >= words.length - 1 && styles.navBtnDisabled]}
          onPress={goNext}
          disabled={index >= words.length - 1}
        >
          <Text style={styles.navBtnText}>Next →</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.wordTitle} numberOfLines={4}>
          {currentWord}
        </Text>

        <Text style={styles.emoji}>{card.emoji}</Text>

        <TouchableOpacity
          style={[styles.button, playing && styles.buttonDisabled]}
          onPress={onPlayPronunciation}
          disabled={playing || loadingCard}
        >
          {playing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Pronunciation</Text>
          )}
        </TouchableOpacity>

        {loadingCard ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color="#4A90E2" />
            <Text style={styles.muted}>Loading definition and example…</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Definition</Text>
            <Text style={styles.definition}>{card.definition}</Text>

            <Text style={styles.sectionLabel}>Example</Text>
            <Text style={styles.example}>{card.example}</Text>
          </>
        )}

        {errorMsg ? <Text style={styles.errorBanner}>{errorMsg}</Text> : null}

        <TouchableOpacity
          style={[styles.practiceNavBtn, (!card.practiceWord || loadingCard) && styles.practiceNavBtnDisabled]}
          onPress={goPractice}
          disabled={!card.practiceWord || loadingCard}
        >
          <Text style={styles.practiceNavBtnText}>Practice this word →</Text>
        </TouchableOpacity>
      </ScrollView>

      <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 24,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  centered: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  navBtn: {
    paddingVertical: 8,
    paddingHorizontal: 10,
  },
  navBtnDisabled: {
    opacity: 0.35,
  },
  navBtnText: {
    color: '#4A90E2',
    fontSize: 15,
    fontWeight: '600',
  },
  counter: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
  },
  wordTitle: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#4A90E2',
    textAlign: 'center',
    marginBottom: 8,
  },
  emoji: {
    fontSize: 56,
    textAlign: 'center',
    marginBottom: 12,
  },
  button: {
    alignSelf: 'center',
    backgroundColor: '#4A90E2',
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 25,
    marginBottom: 20,
    minWidth: 200,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  loadingCard: {
    alignItems: 'center',
    gap: 10,
    marginTop: 8,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#888',
    textTransform: 'uppercase',
    marginBottom: 4,
    marginTop: 10,
  },
  definition: {
    fontSize: 17,
    color: '#333',
    lineHeight: 24,
  },
  example: {
    fontSize: 16,
    color: '#666',
    fontStyle: 'italic',
    lineHeight: 22,
  },
  muted: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
  },
  hint: {
    marginTop: 8,
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
  },
  errorText: {
    color: '#c00',
    fontSize: 16,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  errorBanner: {
    marginTop: 16,
    color: '#c00',
    fontSize: 14,
    textAlign: 'center',
  },
  practiceNavBtn: {
    marginTop: 28,
    alignSelf: 'stretch',
    backgroundColor: '#4A90E2',
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: 'center',
  },
  practiceNavBtnDisabled: {
    opacity: 0.45,
  },
  practiceNavBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '800',
  },
  backButton: {
    alignSelf: 'center',
    paddingVertical: 12,
  },
  backText: {
    color: '#4A90E2',
    fontSize: 16,
  },
});
