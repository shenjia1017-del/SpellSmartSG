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

import { supabase } from '../../lib/supabase';

const CLAUDE_MIN_INTERVAL_MS = 2000;
const TTS_MIN_INTERVAL_MS = 800;

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const anthropicKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
const openAIKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;

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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  // eslint-disable-next-line no-undef
  return btoa(binary);
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
- "phonics": syllable breakdown using bullet " • " between parts, e.g. "e • NOR • mous" or "round • the • cor • ner". Use simple sounds suitable for kids.
- "definition": one short English definition a child can understand (one or two sentences max).
- "example": one example sentence using the word or phrase naturally, in quotes in the string value only if you like.
- "emoji": exactly one Unicode emoji that fits the meaning (not multiple).

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

  return {
    phonics: String(parsed.phonics ?? '').trim() || '—',
    definition: String(parsed.definition ?? '').trim() || '—',
    example: String(parsed.example ?? '').trim() || '—',
    emoji: String(parsed.emoji ?? '').trim() || '📘',
  };
}

async function fetchOpenAITtsAudio(word) {
  if (!openAIKey) {
    throw new Error('Missing EXPO_PUBLIC_OPENAI_API_KEY in .env');
  }

  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAIKey}`,
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'alloy',
      input: word,
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? 'OpenAI TTS request failed.');
  }

  const arrayBuffer = await response.arrayBuffer();
  return arrayBufferToBase64(arrayBuffer);
}

export default function LearnScreen({ navigation }) {
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
    phonics: '',
    definition: '',
    example: '',
    emoji: '📘',
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

        let query = supabase.from('words').select('id, word').eq('user_id', uid);
        let { data, error } = await query.order('created_at', { ascending: true });

        if (error) {
          const retry = await supabase
            .from('words')
            .select('id, word')
            .eq('user_id', uid)
            .order('id', { ascending: true });
          data = retry.data;
          error = retry.error;
        }

        if (error) throw error;

        const rows = Array.isArray(data) ? data : [];
        const list = rows
          .map((r) => ({ id: r.id, word: String(r.word ?? '').trim() }))
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
      setCard({ phonics: '', definition: '', example: '', emoji: '📘' });
      return;
    }

    const cached = cacheRef.current.get(currentWord);
    if (cached) {
      setCard(cached);
      return;
    }

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
        const content = await fetchClaudeCard(currentWord);
        if (cancelled) return;
        cacheRef.current.set(currentWord, content);
        setCard(content);
      } catch (e) {
        if (!cancelled) {
          console.error('[LearnScreen] Claude fetch failed (LearnScreen handler):', e);
          console.error('[LearnScreen] Claude fetch error message:', e?.message);
          setErrorMsg(e?.message ?? 'Failed to load card content.');
          setCard({
            phonics: '—',
            definition: '—',
            example: '—',
            emoji: '📘',
          });
        }
      } finally {
        if (!cancelled) setLoadingCard(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentWord, userId]);

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
            <Text style={styles.buttonText}>🔊 Pronunciation</Text>
          )}
        </TouchableOpacity>

        {loadingCard ? (
          <View style={styles.loadingCard}>
            <ActivityIndicator color="#4A90E2" />
            <Text style={styles.muted}>Preparing phonics & examples…</Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionLabel}>Phonics</Text>
            <Text style={styles.phonics}>{card.phonics}</Text>

            <Text style={styles.sectionLabel}>Definition</Text>
            <Text style={styles.definition}>{card.definition}</Text>

            <Text style={styles.sectionLabel}>Example</Text>
            <Text style={styles.example}>{card.example}</Text>
          </>
        )}

        {errorMsg ? <Text style={styles.errorBanner}>{errorMsg}</Text> : null}
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
    paddingBottom: 16,
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
  phonics: {
    fontSize: 20,
    color: '#7ED321',
    marginBottom: 4,
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
  backButton: {
    alignSelf: 'center',
    paddingVertical: 12,
  },
  backText: {
    color: '#4A90E2',
    fontSize: 16,
  },
});
