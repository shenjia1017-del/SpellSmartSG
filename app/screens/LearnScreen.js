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

  // Safety: Claude should always receive a plain string word.
  if (typeof word !== 'string') {
    console.error('[LearnScreen] Claude fetch: invalid word value (expected string):', word);
    return {
      definition: '—',
      example: '—',
      emoji: '📘',
      practiceWord: '',
      practicePhonics: '',
      practiceGraphemes: '',
      graphemesPronunciation: {},
      definitions: [],
    };
  }

  console.log('[LearnScreen] Claude request for word:', word, 'model:', CLAUDE_MODEL);

  const prompt = `You are a British English phonics expert trained in the Jolly Phonics system, helping Singapore primary school students (P1–P6) learn spelling. You must follow the exact phonics rules below when splitting words.

JOLLY PHONICS COMPLETE RULE LIBRARY:

GROUP 1 — SINGLE CONSONANT SOUNDS:
b="buh", c="kuh", d="duh", f="fuh", g="guh", h="huh", j="juh", k="kuh", l="luh", m="muh", n="nuh", p="puh", r="ruh", s="sss", t="tuh", v="vuh", w="wuh", x="ks", y="yuh", z="zzz"
- NEVER use letter names (e.g. never "bee" for b, never "pee" for p, never "tee" for t)
- s at end of word after voiced consonant = "zzz" (e.g. dogs, beds)
- s at end of word after unvoiced consonant = "sss" (e.g. cats, books)
- c before e/i/y = "sss" (e.g. ce•ment, ci•ty, cy•cle)
- c before a/o/u = "kuh" (e.g. cat, cot, cut)
- g before e/i/y = "juh" (e.g. gem, gi•ant, gym)
- g before a/o/u = "guh" (e.g. gap, got, gum)
- silent b after m = "" (e.g. lamb, comb, thumb)
- silent k before n = "" (e.g. knee, knife, know)
- silent w before r = "" (e.g. write, wrong, wrap)
- silent g before n = "" (e.g. gnaw, gnat, sign)
- silent h in wh words (British) = "" (e.g. what→w•a•t, when→w•e•n)
- silent p before n/s/t = "" (e.g. pneumonia, psychology)

GROUP 2 — CONSONANT DIGRAPHS (never split these):
- ch = "chuh" (chin, church, much)
- sh = "shh" (ship, dish, shell)
- th voiced = "thh" (the, this, that, them, they, with)
- th unvoiced = "thh" (think, three, both, math)
- wh = "wuh" (when, where, which, while)
- ph = "fuh" (phone, photo, graph, dolphin)
- ng = "ing" (ring, sing, long, strong)
- nk = "ink" (sink, think, drink, blank)
- ck = "kuh" (back, duck, clock, stick)
- gh = "guh" OR silent (ghost="guh", night=silent, though=silent)
- dg = "juh" (edge, bridge, judge, fridge)
- tch = "chuh" (watch, catch, match, witch)
- qu = "kwuh" (queen, quick, quiet, square)

GROUP 3 — CONSONANT BLENDS (each letter keeps its own sound, but stay together in graphemes):
Beginning: bl, br, cl, cr, dr, fl, fr, gl, gr, pl, pr, sc, sk, sl, sm, sn, sp, st, sw, tr, tw, scr, spl, spr, str, squ
Ending: ld, lf, lk, ll, lm, lp, lt, mp, nd, nk, nt, pt, sk, sp, st, xt
- Note: blends are NOT digraphs — split them into individual phonemes in practiceGraphemes
- e.g. "str•ee•t" NOT "street", "bl•a•ck" NOT "black"

GROUP 4 — SHORT VOWELS (use these unless rules below override):
- a = "ah" (cat, hand, flat, stamp)
- e = "eh" (bed, help, best, spent)
- i = "ih" (sit, fish, wind, gift)
- o = "oh" (hot, dog, stop, clock)
- u = "uh" (cup, jump, drum, must)
- y as vowel in middle = "ih" (gym, myth, symbol)
- y at end of short word = "ih" (happy, funny, silly — actually "ee" sound)

GROUP 5 — LONG VOWELS (magic e / silent e rule):
- a_e = "ay" (cake, make, came, game, place)
- e_e = "ee" (these, here, eve, complete)
- i_e = "eye" (bike, time, fine, white, smile)
- o_e = "oh" (home, hope, note, stone, those)
- u_e = "yoo" (cube, tune, cute, huge, use)
- u_e after r/l/j/s = "oo" (rule, June, rude, blue)
- silent e at end: merge with preceding consonant (e.g. make → m•a•k•e where "ke"="kuh" silent e)

GROUP 6 — VOWEL TEAMS (never split these):
- ai = "ay" (rain, paid, tail, wait, plain)
- ay = "ay" (day, play, say, stay, away)
- ee = "ee" (feet, green, seen, street, sheep)
- ea = "ee" (eat, beach, read, team, dream) — EXCEPTION: ea="eh" in bread, head, dead, instead, heavy, ready, weather
- ey = "ee" (key, money, honey, valley, donkey)
- ie = "eye" (pie, tie, lie, die, tried) — EXCEPTION: ie="ee" in field, chief, piece, niece, grief
- igh = "eye" (night, light, right, fight, sight)
- oa = "oh" (boat, coat, road, toast, groan)
- oe = "oh" (toe, foe, goes, hoe, oboe)
- ow = "oh" (low, show, snow, grow, own) — EXCEPTION: ow="ow" in cow, how, now, town, down, brown, crown
- oo = "oo" (moon, food, soon, school, tooth) — EXCEPTION: oo="uh" in book, look, cook, good, wood, stood, hood
- ou = "ow" (out, loud, found, ground, mouth) — EXCEPTION: ou="oo" in you, soup, through, group, route; ou="uh" in could, would, should; ou="oh" in shoulder, though, soul
- oi = "oy" (oil, join, coin, point, voice)
- oy = "oy" (boy, toy, enjoy, destroy, royal)
- ue = "yoo" (cue, due, hue, rescue, argue)
- ew = "yoo" (new, few, dew, grew, knew) — EXCEPTION: ew="oo" after r/l (brew, flew, blew, crew)
- ui = "ih" (build, guilt, guitar) — EXCEPTION: ui="oo" in fruit, juice, suit, cruise
- au = "aw" (cause, fault, haunt, August, sauce)
- aw = "aw" (saw, draw, jaw, straw, crawl)
- augh = "aw" (caught, taught, daughter, naughty)
- ough = context dependent:
  * "aw" in thought, bought, ought, brought, fought
  * "oo" in through
  * "ow" in plough, bough
  * "oh" in though, dough
  * "uh" in thorough
  * "off" in cough, trough

GROUP 7 — R-CONTROLLED VOWELS (never split these):
- ar = "arr" (car, far, star, farm, garden, dark)
- or = "orr" (for, born, storm, short, sport, corner)
- er = "err" (her, fern, serve, term, person)
- ir = "err" (bird, girl, first, shirt, circle)
- ur = "err" (burn, turn, hurt, purple, church)
- air = "air" (hair, fair, chair, pair, stair)
- ear = "ear" (hear, near, fear, year, clear) — EXCEPTION: ear="air" in bear, wear, pear, swear
- eer = "ear" (deer, beer, cheer, steer, career)
- are = "air" (bare, care, dare, hare, share, square)
- ore = "orr" (more, store, bore, score, before)
- ire = "eye-err" (fire, wire, hire, entire, inspire)
- ure = "yoor" (pure, cure, sure, nature, picture)
- war = "worr" (war, warm, warn, ward, swarm)
- wor = "werr" (word, work, world, worm, worth)

GROUP 8 — SPECIAL MULTI-LETTER CHUNKS (keep together, never split):
- tion = "shun" (nation, action, station, mention, attention)
- sion = "shun" (mansion, tension, extension, comprehension)
- sion after vowel = "zhun" (vision, television, division, conclusion, explosion)
- ture = "cher" (picture, nature, future, adventure, creature)
- ous = "uss" (famous, nervous, serious, dangerous, gorgeous)
- ious = "ee-uss" (serious, various, obvious, previous, glorious)
- tion after s = "chun" (question, digestion, suggestion)
- cial = "shull" (special, social, official, crucial, facial)
- tial = "shull" (partial, initial, essential, potential, spatial)
- cian = "shun" (musician, magician, politician, technician)
- cious = "shuss" (precious, gracious, spacious, ferocious, atrocious)
- tious = "shuss" (cautious, ambitious, nutritious, infectious)
- age at end = "ij" (village, package, message, damage, manage)
- ace at end = "iss" (palace, surface, menace, furnace)
- ure at end = "cher" (treasure, measure, pleasure, leisure)
- el/le at end = "ul" (table, simple, circle, apple, little, bottle)
- en at end = "un" (open, broken, frozen, often, garden)
- ed at end after unvoiced = "t" (jumped, walked, stopped, talked, helped)
- ed at end after voiced = "d" (played, rained, moved, lived, showed)
- ed at end after t/d = "id" (wanted, landed, needed, started, waited)
- ing = "ing" (running, jumping, playing, singing, helping)

GROUP 9 — SILENT LETTER PATTERNS:
- silent e at end (already covered above)
- silent b: mb="m" (lamb, comb, climb, thumb, numb, bomb), bt="t" (doubt, debt, subtle)
- silent k: kn="n" (know, knee, knife, knock, knight, knit)
- silent w: wr="r" (write, wrong, wrap, wreck, wrist, wrestle)
- silent g: gn="n" at start (gnaw, gnat, gnome), gn="n" at end (sign, foreign, design, campaign)
- silent h: rh="r" (rhyme, rhythm, rhinoceros), gh=silent in ight/aught/ought patterns
- silent l: al before f/k/m/v = "aw" (half, calm, palm, walk, talk, folk, salmon)
- silent t: st sometimes = "s" (listen, fasten, castle, whistle, bristle, thistle)
- silent n: mn = "m" (autumn, column, solemn, condemn, hymn)
- silent p: ps="s" (psychology, psalm, pterodactyl)
- silent c: sc before e/i = "s" (scene, scent, science, scissors, muscle)

GROUP 10 — SYLLABLE SPLITTING RULES (for practicePhonics):
- Split between two consonants: hap•py, win•ter, car•pet, gar•den
- Split before single consonant if vowel is long: ti•ger, pa•per, mu•sic, o•pen
- Split after single consonant if vowel is short: cab•in, hab•it, rob•in, mod•el
- Prefixes stay together: un•happy, re•turn, dis•cover, pre•tend, mis•take
- Suffixes stay together: play•ing, help•ful, care•less, quick•ly, friend•ship
- Compound words split at word boundary: sun•shine, rain•bow, foot•ball, bed•room
- Never split consonant digraphs across syllables: broth•er NOT brot•her
- Never split vowel teams across syllables: rain•bow NOT ra•inbow
- -le at end: consonant goes with le: ta•ble, sim•ple, cir•cle, tur•tle

For this exact spelling entry: ${JSON.stringify(word)}

Return ONLY valid JSON, no markdown, no extra text:
{
  "phonics": "syllable breakdown of full entry using • (e.g. 'chil•dren', 'ap•proached')",
  "definition": "one short child-friendly definition, max 2 sentences, simple words suitable for Singapore P1-P6",
  "example": "one natural example sentence using the word or phrase",
  "emoji": "one Unicode emoji representing the meaning",
  "practiceWord": "if multi-word phrase pick the hardest single word; if already single word return it unchanged",
  "practicePhonics": "syllable breakdown of practiceWord by RHYTHM using rules from GROUP 10 above",
  "practiceGraphemes": "sound-unit breakdown of practiceWord using ALL rules above. Each unit separated by •. Apply GROUP 9 silent letter rules (silent letters get empty string or merge). Apply GROUP 8 chunks. Apply GROUP 2 digraphs. Apply GROUP 6 vowel teams. Apply GROUP 7 r-controlled. NEVER split a digraph, vowel team, or special chunk.",
  "graphemesPronunciation": {
    "each_grapheme": "exact British English TTS text using sounds from GROUP 1-8 above. Silent letters use empty string. Follow all exception rules."
  },
  "definitions": [
    {"type": "verb/noun/adjective/adverb", "meaning": "simple definition for this word type, P1-P6 level"}
  ]
}

CRITICAL: practicePhonics (rhythm) and practiceGraphemes (sound units) MUST be different for most words. graphemesPronunciation must have exactly one key per unit in practiceGraphemes.
`;

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

  const wordString = typeof words[index] === 'string' ? words[index] : words[index]?.word ?? '';
  const currentWord = typeof wordString === 'string' ? wordString : '';

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
        const passedWordsRaw = route.params?.words;
        const passedWords = Array.isArray(passedWordsRaw)
          ? passedWordsRaw
              .filter(Boolean)
              .map((w) =>
                typeof w === 'string' ? { id: null, word: w, learn_card_json: null } : w,
              )
          : [];

        console.log('[LearnScreen] First word raw:', JSON.stringify(passedWords[0]));

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

        let list = passedWords;
        if (list.length === 0) {
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
          list = rows
            .map((r) => ({
              id: r.id,
              word: String(r.word ?? '').trim(),
              learn_card_json: r.learn_card_json ?? null,
            }))
            .filter((r) => r.word.length > 0);
        }

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
  }, [route.params?.words]);

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
        const content = await fetchClaudeCard(currentWord);
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
      word: currentWord,
      practiceWord: card.practiceWord,
      practicePhonics: card.practicePhonics,
      practiceGraphemes: ensureDistinctGraphemes(
        card.practiceWord,
        card.practicePhonics,
        card.practiceGraphemes ?? '',
      ),
      graphemesPronunciation: card.graphemesPronunciation ?? {},
      definitions: card.definitions ?? [],
      exampleSentence: card.example ?? '',
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
