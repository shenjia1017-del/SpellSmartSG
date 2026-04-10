import { useFocusEffect } from '@react-navigation/native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  SafeAreaView,
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
  return String(display ?? '').trim();
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
      syllables: '',
      graphemesPronunciation: {},
      definitions: [],
    };
  }

  console.log('[LearnScreen] Claude request for word:', word, 'model:', CLAUDE_MODEL);

  const prompt = `You are a British English phonics expert trained in the official Jolly Phonics programme (by Jolly Learning Ltd), helping Singapore primary school students (P1–P6) learn spelling.

IMPORTANT: The input may be a single word OR a multi-word phrase (e.g. "reprimanded severely").

- practicePhonics: if the input is a phrase, split EVERY word and join with a SPACE between words. Use • between graphemes within each word. Example for "reprimanded severely": "r•e•p•r•i•m•a•n•d•ed s•e•v•ere•l•y". Never omit any word from the phrase.
- practiceGraphemes: same rule as practicePhonics. Split every word, join words with a space. Example: "r•e•p•r•i•m•a•n•d•ed s•e•v•ere•l•y"
- syllables: split every word into syllables, join words with a space. Example for "reprimanded severely": "rep•ri•man•ded se•vere•ly"
- practiceWord: must be the full phrase exactly as given. Example: "reprimanded severely"

CRITICAL: Never truncate or omit any word from the phrase in any field.

- definition: define the full phrase as a unit (not just one word).
- example: use the full phrase in the example sentence.

CRITICAL RULE — SPLITTING APPROACH:
Always attempt to split words into graphemes using the rules below. Only keep a word unsplit if it is a well-known completely irregular word with no phonetic pattern (e.g. "said", "was", "one", "the"). For all other words, apply the rules below and split as best you can. An imperfect split is better than no split, because children need to see the parts to learn. When uncertain between two valid splits, choose the more common phonics pattern.

THE 42 JOLLY PHONICS LETTER SOUNDS (7 groups):
Group 1: s, a, t, i, p, n
Group 2: ck, e, h, r, m, d  
Group 3: g, o, u, l, f, b
Group 4: ai, j, oa, ie, ee, or
Group 5: z, w, ng, v, oo (long as in moon), oo (short as in book)
Group 6: y, x, ch, sh, th (voiced as in 'this'), th (unvoiced as in 'three')
Group 7: qu, ou, oi, ue, er, ar

LETTER SOUND RULES (use letter SOUNDS not letter NAMES):
- s="sss", a="ah", t="tuh", i="ih", p="puh", n="nuh"
- ck="kuh", e="eh", h="huh", r="ruh", m="muh", d="duh"
- g="guh", o="oh", u="uh", l="luh", f="fuh", b="buh"
- j="juh", or="orr", z="zzz", w="wuh", ng="ing", v="vuh"
- y="yuh", x="ks", ch="chuh", sh="shh"
- th (voiced, e.g. this/the/that/them/they/with)="thh"
- th (unvoiced, e.g. think/three/both/math)="thh"
- qu="kwuh", ou="ow", oi="oy", ue="yoo", er="err", ar="arr"

DIGRAPHS — NEVER SPLIT THESE (treat as one unit):
ai="ay", ee="ee", oa="oh", ie="eye", or="orr", ng="ing",
ck="kuh", ch="chuh", sh="shh", th="thh", qu="kwuh",
ph="fuh", wh="wuh", nk="ink", dg="juh", tch="chuh"

VOWEL TEAMS — NEVER SPLIT THESE (treat as one unit):
- ai="ay" (rain, tail, paid, main, plain)
- ay="ay" (day, play, say, stay, away)
- a_e="ay" (cake, make, came, gate, snake, late)
- ee="ee" (feet, green, seen, tree, sheep)
- ea="ee" (eat, beach, read, team, dream) EXCEPTION: ea="eh" in bread, head, dead, heavy, ready, weather, instead
- e_e="ee" (these, theme, complete)
- ey="ee" (key, money, honey, donkey, valley)
- ie="eye" (pie, tie, lie, die, tried) EXCEPTION: ie="ee" in field, chief, piece, niece, grief
- igh="eye" (night, light, right, fight, sight, high, thigh)
- i_e="eye" (bike, time, fine, white, smile, kite)
- y (end of word)="ee" (funny, happy, silly, quickly, really)
- y (middle of word)="ih" (gym, myth, symbol, crystal)
- y (end short word)="eye" (fly, dry, by, my, try, cry, sky)
- oa="oh" (boat, coat, road, toast, groan, oak)
- ow="oh" (low, show, snow, grow, own, slow, below) EXCEPTION: ow="ow" in cow, how, now, town, down, brown, crown, owl, tower
- o_e="oh" (home, hope, note, stone, those, bone)
- oe="oh" (toe, foe, goes, hoe)
- oo (long)="oo" (moon, food, soon, school, tooth, room, boot)
- oo (short)="uh" (book, look, cook, good, wood, stood, hood, foot)
- ou="ow" (out, loud, found, ground, mouth, shout, cloud) EXCEPTIONS: ou="oo" in you/soup/through/group/route; ou="uh" in could/would/should; ou="oh" in shoulder/though/soul; ou="uh" in touch/young/double/trouble/country
- ow="ow" (cow, how, now, town, down, brown, crown, owl)
- oi="oy" (oil, join, coin, point, voice, moist)
- oy="oy" (boy, toy, enjoy, destroy, royal, loyal)
- ue="yoo" (cue, due, hue, rescue, argue, blue, true, glue) NOTE: ue="oo" in blue/true/glue/clue/flue
- ew="yoo" (new, few, dew, knew) EXCEPTION: ew="oo" after r/l/bl/fl/cr/br (brew, flew, blew, crew, drew, grew, threw, chew, stew, screw)
- u_e="yoo" (cube, tune, cute, huge, use, fuse) EXCEPTION: u_e="oo" after r/l/j (rule, June, rude, flute, prune)
- er="err" (her, fern, serve, term, person, verb, nerve)
- ir="err" (bird, girl, first, shirt, circle, third, firm)
- ur="err" (burn, turn, hurt, purple, church, burst, curve)
- ar="arr" (car, far, star, farm, garden, dark, bark, charm)
- au="aw" (cause, fault, haunt, August, sauce, pause, author)
- aw="aw" (saw, draw, jaw, straw, crawl, awful, claw)
- al="aw" (talk, walk, calm, palm, half, calf, always, although) — l is silent
- air="air" (hair, fair, chair, pair, stair, repair)
- are="air" (bare, care, dare, hare, share, square, stare, compare)
- ear="ear" (hear, near, fear, year, clear, dear, appear) EXCEPTION: ear="air" in bear/wear/pear/swear; ear="err" in earth/earn/early/heard/learn/pearl/search
- eer="ear" (deer, beer, cheer, steer, career, engineer)
- ire="eye-err" (fire, wire, hire, entire, inspire, tired, desire)
- ure="yoor" (pure, cure, sure, nature, picture, future, adventure) NOTE: ure="err" in pressure/measure/treasure/pleasure/leisure

ADDITIONAL ALTERNATIVE SPELLINGS (from Jolly Phonics):
- eigh="ay" (eight, weight, freight, neighbour, sleigh, weigh, they) — gh is silent
- aigh="ay" (straight, straighten, straightforward) — gh is silent
- ei="ay" (vein, rein, reign, eight, reindeer, beige)
- a (open syllable)="ay" (baby, crazy, lady, paper, table, able)
- e (open syllable)="ee" (email, secret, equal, even, evil, hotel)
- i (open syllable)="eye" (icy, child, mild, find, kind, mind, wild)
- o (open syllable)="oh" (open, hello, go, so, no, also, zero, over)
- ge/gi/gy="juh" (germ, gentle, giant, magic, gym, energy, giraffe, age, huge)
- ce/ci/cy="sss" (race, ice, city, cycle, cent, circus, ceiling, mice, face, place, voice, price, notice, since, fence, bounce, dance, glance)
- ph="fuh" (photo, phone, graph, dolphin, elephant, alphabet, nephew, phrase, trophy)
- wa="woh" (wash, was, want, watch, water, swan, swamp, wasp, wallet, wander)
- wor="werr" (word, work, world, worm, worth, worry, worse, worship, sword)
- war="worr" (war, warm, warn, ward, swarm, reward, toward)
- wr="r" (write, wrong, wrap, wreck, wrist, wrestle, wren) — w is silent
- kn="n" (know, knee, knife, knock, knight, knit, knob, knot, knew) — k is silent
- gn="n" (gnaw, gnat, gnome, sign, foreign, design, campaign, reign) — g is silent
- mb="m" (lamb, comb, climb, thumb, numb, bomb, womb, plumb, debt) — b is silent
- bt="t" (doubt, debt, subtle) — b is silent
- st="s" (listen, fasten, castle, whistle, bristle, thistle, Christmas) — t is silent
- mn="m" (autumn, column, solemn, condemn, hymn) — n is silent
- rh="r" (rhyme, rhythm, rhinoceros) — h is silent
- sc="s" before e/i (scene, scent, science, scissors, muscle) — c is silent
- gh="guh" (ghost, ghastly, dinghy, spaghetti) — NOT silent in these words
- gh=silent (night, light, right, fight, though, thought, through, daughter, caught) — silent after vowel teams igh/ough/augh

SPECIAL MULTI-LETTER CHUNKS (keep together as one unit):
- tion="shun" (nation, action, station, mention, attention, position, question→"kes-chun")
- sion="shun" (mansion, tension, extension, comprehension, permission, expression)
- sion after vowel="zhun" (vision, television, division, conclusion, explosion, occasion, decision)
- ture="cher" (picture, nature, future, adventure, creature, mixture, fracture, capture)
- ous="uss" (famous, nervous, dangerous, gorgeous, jealous, generous, marvellous, enormous, serious, various, obvious, previous, glorious, furious, curious)
- cial="shull" (special, social, official, crucial, facial, racial, glacial)
- tial="shull" (partial, initial, essential, potential, spatial, martial, substantial)
- cian="shun" (musician, magician, politician, technician, optician, electrician)
- cious="shuss" (precious, gracious, spacious, ferocious, atrocious, conscious, luscious)
- tious="shuss" (cautious, ambitious, nutritious, infectious, fictitious, pretentious)
- age (end)="ij" (village, package, message, damage, manage, cottage, cabbage, savage, bandage, language, sausage, average, advantage, disadvantage)
- ace (end)="iss" (palace, surface, menace, furnace, necklace, terrace, interface)
- le (end)="ul" (table, simple, circle, apple, little, bottle, castle, turtle, jungle, purple, middle, noodle, handle, candle, puzzle, giggle, tickle, pickle, whistle)
- en (end)="un" (open, broken, frozen, often, garden, chicken, spoken, token, happen, kitchen, listen, often, sudden, certain, fasten)
- el (end)="ul" (camel,anel, tunnel, squirrel, barrel, channel, flannel, travel, level, novel, cancel, model)
- ed (after unvoiced consonant p/k/t/f/s/sh/ch/x)="t" (jumped, walked, stopped, talked, helped, passed, watched, fixed, laughed, kissed, wished, reached)
- ed (after voiced consonant or vowel)="d" (played, rained, moved, lived, showed, called, named, loved, used, described)
- ed (after t or d)="id" (wanted, landed, needed, started, waited, ended, added, melted, visited, counted, divided, folded)

DOUBLING RULE (from Jolly Phonics Grammar 1):
Words with a short stressed vowel before a suffix have doubled consonant: fatter, bedding, hilly, hottest, button, running, sitting, hopping, getting, putting, cutting, bigger, thinner
Words with long vowel or other vowel do NOT double: sailor, leaflet, silent, hotel, booking, sooner, eating, hoping, making, reading

SYLLABLE SPLITTING RULES (for practicePhonics — rhythm only):
- Single syllable words: NEVER split (straight, caught, knight, through, scream, bright, thought, school, might, friend, build, world)
- Split between two consonants: win•ter, car•pet, gar•den, hap•py, let•ter, but•ter, din•ner, sum•mer, pep•per
- Long vowel before single consonant: split before consonant: ti•ger, pa•per, mu•sic, o•pen, si•lent, e•ven, po•lite, be•fore
- Short vowel before single consonant: split after consonant: cab•in, hab•it, rob•in, mod•el, pun•ish, lim•it, riv•er, vis•it
- Prefixes stay together: un•hap•py, re•turn, dis•cov•er, pre•tend, mis•take, be•cause, a•round, be•long, be•tween, be•low
- Suffixes stay together: play•ing, help•ful, care•less, quick•ly, friend•ship, use•less, hope•ful, dark•ness, sad•ness
- Compound words split at boundary: sun•shine, rain•bow, foot•ball, bed•room, some•thing, any•thing, every•thing, with•out, in•side, out•side
- NEVER split a digraph or vowel team across syllables: broth•er NOT brot•her; rain•bow NOT ra•in•bow
- le ending: consonant goes WITH le: ta•ble, sim•ple, cir•cle, tur•tle, mid•dle, bot•tle, gig•gle, puz•zle

For this exact spelling entry: ${JSON.stringify(word)}

Return ONLY valid JSON, no markdown, no extra text:
{
  "phonics": "for a phrase: syllable-style breakdown of the FULL entry — split each word into syllables, join words with a space, use • between syllables. For a single word: syllable breakdown using •",
  "definition": "one short child-friendly definition max 2 sentences, suitable for Singapore P1-P6",
  "example": "one natural example sentence",
  "emoji": "one Unicode emoji representing the meaning",
  "practiceWord": "exactly the full input string (word or phrase); for phrases never drop or shorten words",
  "syllables": "syllable breakdown only: each word split into syllables joined by •; multiple words separated by a single space. Example phrase reprimanded severely as rep•ri•man•ded se•vere•ly; single word enormous as e•nor•mous",
  "practicePhonics": "split EVERY word into graphemes with • within each word; for phrases join words with a SPACE between words. Never omit a word. Single-word entries: grapheme split with •",
  "practiceGraphemes": "same as practicePhonics: every word split with • between graphemes; phrases join words with a space. Use digraph/vowel team rules — never split a digraph or vowel team across •",
  "graphemesPronunciation": {
    "each_grapheme_key": "British English TTS pronunciation text using sounds from rules above. Silent letters use empty string ''."
  },
  "definitions": [
    {"type": "verb/noun/adjective/adverb", "meaning": "simple P1-P6 definition"}
  ]
}

REMEMBER: If unsure how to split any part of a word, keep it whole. Never guess. Incorrect splitting is worse than no splitting.
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

  let syllables = String(parsed.syllables ?? '').trim();
  if (!syllables || syllables === '—') {
    const phonicsField = String(parsed.phonics ?? '').trim();
    if (phonicsField && phonicsField !== '—') {
      syllables = phonicsField;
    }
  }

  const definitions = normalizeDefinitions(parsed);
  const graphemesPronunciation = normalizeGraphemesPronunciation(parsed, practiceGraphemes);

  return {
    definition: String(parsed.definition ?? '').trim() || '—',
    example: String(parsed.example ?? '').trim() || '—',
    emoji: String(parsed.emoji ?? '').trim() || '📘',
    practiceWord,
    practicePhonics,
    practiceGraphemes,
    syllables,
    graphemesPronunciation,
    definitions,
  };
}

function paramFromSearchParams(params, key) {
  const v = params[key];
  if (v == null) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

export default function LearnScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
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
    syllables: '',
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
      const adv = paramFromSearchParams(params, 'advanceToNextWord');
      if (String(adv) === 'true' && words.length > 0) {
        setIndex((i) => Math.min(words.length - 1, i + 1));
        router.setParams({ advanceToNextWord: '' });
      }
    }, [params, router, words.length]),
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoadingList(true);
      setErrorMsg(null);
      try {
        const wordsJSONRaw = paramFromSearchParams(params, 'wordsJSON');
        let rawList = null;
        if (wordsJSONRaw) {
          try {
            const parsed = JSON.parse(String(wordsJSONRaw));
            rawList = Array.isArray(parsed) ? parsed : [];
          } catch {
            rawList = [];
          }
        }
        if (!rawList) rawList = [];
        const passedWords = rawList
          .filter(Boolean)
          .map((w) =>
            typeof w === 'string' ? { id: null, word: w, learn_card_json: null } : w,
          );
        const learnIndexRaw = paramFromSearchParams(params, 'learnIndex');

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
          const hadPassedWords = passedWords.length > 0;
          const nextIdx =
            hadPassedWords && learnIndexRaw != null && String(learnIndexRaw).trim() !== ''
              ? Math.max(
                  0,
                  Math.min(Number(learnIndexRaw) || 0, Math.max(0, list.length - 1)),
                )
              : 0;
          setIndex(nextIdx);
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
  }, [params.wordsJSON, params.learnIndex]);

  useEffect(() => {
    if (!currentWord || !userId) {
      setCard({
        definition: '',
        example: '',
        emoji: '📘',
        practiceWord: '',
        practicePhonics: '',
        practiceGraphemes: '',
        syllables: '',
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
        syllables: String(cached.syllables ?? '').trim(),
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
        syllables: String(dbCard.syllables ?? '').trim(),
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
            syllables: '',
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

  const playOpenAiTts = async (text, ttsOptions = {}) => {
    await unloadSound();
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
    });

    lastTtsAt.current = Date.now();
    const base64 = await fetchOpenAITtsAudio(text, ttsOptions);
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
  };

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
      await playOpenAiTts(currentWord, {});
    } catch (e) {
      setErrorMsg(e?.message ?? 'Could not play audio.');
      setPlaying(false);
    }
  };

  const goPractice = () => {
    if (!card.practiceWord) return;
    router.push({
      pathname: '/practice',
      params: {
        word: currentWord,
        practiceWord: card.practiceWord,
        practicePhonics: card.practicePhonics,
        syllables: card.syllables ?? '',
        practiceGraphemes: ensureDistinctGraphemes(
          card.practiceWord,
          card.practicePhonics,
          card.practiceGraphemes ?? '',
        ),
        graphemesPronunciationJSON: JSON.stringify(card.graphemesPronunciation ?? {}),
        definitionsJSON: JSON.stringify(card.definitions ?? []),
        exampleSentence: card.example ?? '',
        wordsJSON: JSON.stringify(words),
        learnIndex: String(index),
      },
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
      <SafeAreaView style={[styles.container, styles.centered]}>
        <ActivityIndicator size="large" color="#4A90E2" />
        <Text style={styles.muted}>Loading your words…</Text>
      </SafeAreaView>
    );
  }

  if (!userId) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]}>
        <Text style={styles.errorText}>{errorMsg ?? 'Not logged in.'}</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (!words.length) {
    return (
      <SafeAreaView style={[styles.container, styles.centered]}>
        <Text style={styles.muted}>No words saved yet.</Text>
        <Text style={styles.hint}>Import a list from the Home screen first.</Text>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
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

      <Text style={styles.bottomCounter}>
        {index + 1} / {words.length}
      </Text>
      <View style={styles.bottomNavRow}>
        <TouchableOpacity
          style={[styles.secondaryNavBtn, index === 0 && styles.secondaryNavBtnDisabled]}
          onPress={goPrev}
          disabled={index === 0}
        >
          <Text style={styles.secondaryNavBtnText}>← Previous</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.secondaryNavBtn, index >= words.length - 1 && styles.secondaryNavBtnDisabled]}
          onPress={goNext}
          disabled={index >= words.length - 1}
        >
          <Text style={styles.secondaryNavBtnText}>Next →</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
    </SafeAreaView>
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
  bottomCounter: {
    fontSize: 14,
    color: '#666',
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 8,
  },
  bottomNavRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 6,
  },
  secondaryNavBtn: {
    flex: 1,
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#4A90E2',
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryNavBtnDisabled: {
    opacity: 0.45,
  },
  secondaryNavBtnText: {
    color: '#4A90E2',
    fontSize: 16,
    fontWeight: '700',
  },
  backText: {
    color: '#4A90E2',
    fontSize: 16,
  },
});
