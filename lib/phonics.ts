/** Grapheme (lowercase key) → phonics-friendly text for TTS (sounds, not letter names). */
export const phonicsMap: Record<string, string> = {
  a: 'ah',
  b: 'buh',
  c: 'kuh',
  d: 'duh',
  e: 'eh',
  f: 'fff',
  g: 'guh',
  h: 'huh',
  i: 'ih',
  j: 'juh',
  k: 'kuh',
  l: 'lll',
  m: 'mmm',
  n: 'nnn',
  o: 'oh',
  p: 'puh',
  q: 'kwuh',
  r: 'rrr',
  s: 'sss',
  t: 'tuh',
  u: 'uh',
  v: 'vvv',
  w: 'wuh',
  x: 'ks',
  y: 'yuh',
  z: 'zzz',
  sh: 'shh',
  ch: 'chh',
  th: 'thh',
  ck: 'k',
  ph: 'fff',
  wh: 'wuh',
  ng: 'ing',
  qu: 'kwuh',
  oo: 'ooh',
  ee: 'eee',
  ai: 'ay',
  ay: 'ay',
  oa: 'oh',
  oi: 'oy',
  ou: 'ow',
  ow: 'ow',
  ea: 'ee',
  ar: 'arr',
  or: 'orr',
  er: 'err',
  ir: 'err',
  ur: 'err',
};

/**
 * Maps a phonics group (single letter or multi-letter chunk from practicePhonics) to TTS input.
 * Unknown multi-letter groups (e.g. "con", "tion") are returned as-is so TTS speaks the chunk naturally.
 */
export function graphemeToPhonicsTtsInput(grapheme: string): string {
  if (!grapheme) return '';
  const key = String(grapheme).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(phonicsMap, key)) {
    return phonicsMap[key];
  }
  return grapheme;
}

/** Claude per-grapheme hint → else phonicsMap / grapheme (via graphemeToPhonicsTtsInput). */
export function resolvePhonicsTtsInput(
  grapheme: string,
  claudeMap?: Record<string, string> | null,
): string {
  const g = String(grapheme ?? '').trim();
  if (!g) return '';
  if (claudeMap && typeof claudeMap === 'object') {
    const direct = claudeMap[g] ?? claudeMap[g.toLowerCase()];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
  }
  return graphemeToPhonicsTtsInput(g);
}

export const GRAPHEME_DIGRAPHS = [
  'tch',
  'igh',
  'eigh',
  'augh',
  'ough',
  'tion',
  'sion',
  'ture',
  'ck',
  'ch',
  'sh',
  'th',
  'ph',
  'wh',
  'qu',
  'ng',
  'nk',
  'ss',
  'll',
  'ff',
  'zz',
  'mb',
  'kn',
  'wr',
  'dg',
];

export function splitPhonicsToSyllables(phonicsStr: string): string[] {
  if (!phonicsStr || phonicsStr === '—') return [];
  return phonicsStr
    .split('•')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitIntoGraphemes(word: string): string[] {
  if (!word) return [];
  const lower = word.toLowerCase();
  const sorted = [...GRAPHEME_DIGRAPHS].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  let i = 0;
  while (i < word.length) {
    let matched = false;
    for (const d of sorted) {
      if (lower.slice(i, i + d.length) === d) {
        out.push(word.slice(i, i + d.length));
        i += d.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out.push(word[i]);
      i += 1;
    }
  }
  return out;
}

/** Phoneme-only TTS uses speed 0.85; full word uses default (omit speed). */
export const PHONEME_TTS_SPEED = 0.85;

/** British-style TTS: full word vs phoneme (OpenAI voices). */
export const TTS_VOICE_WORD = 'onyx';
export const TTS_VOICE_PHONEME = 'nova';

/** Sent when the Speech API accepts a locale hint (omit if request fails). */
export const TTS_LANGUAGE = 'en-GB';

export const PHONEME_BUCKET = 'phonemes';

/**
 * Object path inside bucket `phonemes`. When `resolvedTtsInput` differs from the
 * default phonics mapping for `grapheme`, uses a suffix so a new pronunciation
 * does not reuse an old clip (e.g. Claude hint "shun" for "tion").
 */
export function graphemeToStoragePath(grapheme: string, resolvedTtsInput?: string): string {
  const safe = String(grapheme)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const base = safe || 'x';
  const defaultInput = graphemeToPhonicsTtsInput(grapheme);
  const resolved =
    resolvedTtsInput != null && String(resolvedTtsInput).trim()
      ? String(resolvedTtsInput).trim()
      : defaultInput;
  if (resolved !== defaultInput) {
    const slugIn = String(resolved)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 32);
    return `${base}__${slugIn || 'x'}.mp3`;
  }
  return `${base}.mp3`;
}

const openAIKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const sub = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode.apply(
      null,
      sub as unknown as number[],
    );
  }
  return btoa(binary);
}

export async function fetchOpenAITtsAudio(
  text: string,
  options: { speed?: number; voice?: string; language?: string } = {},
): Promise<string> {
  if (!openAIKey) throw new Error('Missing EXPO_PUBLIC_OPENAI_API_KEY');
  const payload: Record<string, unknown> = {
    model: 'tts-1',
    voice: options.voice ?? TTS_VOICE_WORD,
    input: text,
    language: options.language ?? TTS_LANGUAGE,
  };
  if (options.speed != null) {
    payload.speed = options.speed;
  }
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAIKey}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message ?? 'TTS failed');
  }
  const arrayBuffer = await response.arrayBuffer();
  return arrayBufferToBase64(arrayBuffer);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
