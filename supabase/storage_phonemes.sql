-- Run once in Supabase Dashboard → SQL Editor.
-- Creates public bucket "phonemes" for letter/grapheme TTS clips (mp3).

INSERT INTO storage.buckets (id, name, public)
VALUES ('phonemes', 'phonemes', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- Public read so getPublicUrl() works for the mobile app without auth on each play.
DROP POLICY IF EXISTS "phonemes_select_public" ON storage.objects;
CREATE POLICY "phonemes_select_public"
ON storage.objects FOR SELECT
USING (bucket_id = 'phonemes');

-- Authenticated users may upload generated phoneme audio from the app.
DROP POLICY IF EXISTS "phonemes_insert_authenticated" ON storage.objects;
CREATE POLICY "phonemes_insert_authenticated"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'phonemes');
