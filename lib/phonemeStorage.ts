import { supabase } from './supabase';
import {
  base64ToUint8Array,
  fetchOpenAITtsAudio,
  graphemeToStoragePath,
  PHONEME_BUCKET,
  PHONEME_TTS_SPEED,
  resolvePhonicsTtsInput,
  splitPhonicsToSyllables,
  TTS_VOICE_PHONEME,
} from './phonics';

const UPLOAD_GAP_MS = 400;

/**
 * Ensure each practicePhonics segment has an mp3 in Supabase Storage (phonemes bucket).
 * Skips if file already exists. Runs silently; failures are logged only.
 */
export async function ensurePhonemeClipsInStorage(
  practicePhonics: string,
  graphemesPronunciation?: Record<string, string> | null,
): Promise<void> {
  const pp = String(practicePhonics ?? '').trim();
  if (!pp || pp === '—') return;

  const graphemes = [...new Set(splitPhonicsToSyllables(pp))];
  for (const gr of graphemes) {
    const phonicsInput = resolvePhonicsTtsInput(gr, graphemesPronunciation);
    if (!phonicsInput) continue;

    const path = graphemeToStoragePath(gr, phonicsInput);
    const { data: blob, error: dlErr } = await supabase.storage.from(PHONEME_BUCKET).download(path);
    if (!dlErr && blob) {
      continue;
    }

    try {
      const base64 = await fetchOpenAITtsAudio(phonicsInput, {
        speed: PHONEME_TTS_SPEED,
        voice: TTS_VOICE_PHONEME,
      });
      const bytes = base64ToUint8Array(base64);
      const { error: upErr } = await supabase.storage.from(PHONEME_BUCKET).upload(path, bytes, {
        contentType: 'audio/mpeg',
        upsert: false,
      });
      if (upErr) {
        const msg = String(upErr.message ?? '');
        if (msg.includes('already exists') || msg.includes('Duplicate') || msg.includes('409')) {
          continue;
        }
        console.warn('[phonemeStorage] upload failed', path, upErr);
      }
    } catch (e) {
      console.warn('[phonemeStorage] TTS or upload failed', path, e);
    }

    await new Promise((r) => setTimeout(r, UPLOAD_GAP_MS));
  }
}
