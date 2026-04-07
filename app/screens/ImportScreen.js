import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  InteractionManager,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImagePicker from 'expo-image-picker';

import { extractTextFromPdfPage1Base64 } from '../../lib/pdfPage1Text';
import { supabase } from '../../lib/supabase';

const OCR_MIN_INTERVAL_MS = 2000;

function guessImageMimeFromFileName(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.heic') || n.endsWith('.heif')) return 'image/heic';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/jpeg';
}

export default function ImportScreen() {
  const router = useRouter();
  const [showManual, setShowManual] = useState(false);
  const [wordInput, setWordInput] = useState('');

  const [saving, setSaving] = useState(false);
  const [loadingWords, setLoadingWords] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const [savedWords, setSavedWords] = useState([]);
  const [photoUri, setPhotoUri] = useState('');
  // Camera queue: photos added first, processed only when user taps "Process All Photos".
  const [photoQueue, setPhotoQueue] = useState([]);
  const [pdfPreviewName, setPdfPreviewName] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedWords, setExtractedWords] = useState([]);
  const [extractedPassage, setExtractedPassage] = useState('');
  const [weekLabel, setWeekLabel] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(null);

  const openAIApiKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;
  const lastOcrAtRef = useRef(0);
  const scrollRef = useRef(null);
  const scrollToReviewPendingRef = useRef(false);

  const scheduleScrollToReviewSection = () => {
    scrollToReviewPendingRef.current = true;
    InteractionManager.runAfterInteractions(() => {
      setTimeout(() => {
        if (scrollToReviewPendingRef.current) {
          scrollToReviewPendingRef.current = false;
          scrollRef.current?.scrollToEnd({ animated: true });
        }
      }, 400);
    });
  };

  const onReviewSectionLayout = (e) => {
    const y = e.nativeEvent.layout.y;
    if (!scrollToReviewPendingRef.current) return;
    scrollToReviewPendingRef.current = false;
    InteractionManager.runAfterInteractions(() => {
      scrollRef.current?.scrollTo({ y: Math.max(0, y - 16), animated: true });
    });
  };

  const waitOcrRateLimit = async () => {
    const now = Date.now();
    const wait = OCR_MIN_INTERVAL_MS - (now - lastOcrAtRef.current);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    lastOcrAtRef.current = Date.now();
  };

  const wordKey = useMemo(() => {
    // Prefer common column names; fall back to stringified row.
    return (row) => row?.id ?? row?.word ?? row?.text ?? row?.value ?? JSON.stringify(row);
  }, []);

  const normalizeWords = (words) => {
    const seen = new Set();
    const cleaned = [];

    for (const rawWord of words) {
      const word = String(rawWord ?? '').trim();
      if (!word) continue;

      const dedupeKey = word.toLowerCase();
      if (seen.has(dedupeKey)) continue;

      seen.add(dedupeKey);
      cleaned.push(word);
    }

    return cleaned;
  };

  const parseOcrFromOpenAIContent = (content) => {
    const empty = { words: [], passage: '' };

    const fromObject = (parsed) => {
      if (!parsed || typeof parsed !== 'object') return empty;
      const words = Array.isArray(parsed.words)
        ? normalizeWords(parsed.words)
        : Array.isArray(parsed)
          ? normalizeWords(parsed)
          : [];
      const passageRaw =
        typeof parsed.passage === 'string'
          ? parsed.passage
          : typeof parsed.dictation_passage === 'string'
            ? parsed.dictation_passage
            : '';
      const passage = passageRaw.trim();
      return { words, passage };
    };

    try {
      const parsed = JSON.parse(content);
      const result = fromObject(parsed);
      if (result.words.length || result.passage) return result;
    } catch {
      // continue
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const result = fromObject(parsed);
        if (result.words.length || result.passage) return result;
      } catch {
        // ignore
      }
    }

    return {
      words: normalizeWords(
        content
          .split('\n')
          .map((line) => line.replace(/^[\-\d\.\)\s]+/, '').trim())
          .filter(Boolean),
      ),
      passage: '',
    };
  };

  const loadSavedWords = async () => {
    setLoadingWords(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.from('words').select('*');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      console.log('Setting words:', rows);
      setSavedWords(rows);
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to load words.');
    } finally {
      setLoadingWords(false);
    }
  };

  const WORKSHEET_SYSTEM_PROMPT =
    'You read photos of primary-school spelling worksheets. Separate two kinds of text and return ONLY valid JSON with this exact shape: {"words":["..."],"passage":"..."}. ' +
    '(1) words: numbered spelling list items only — each numbered line is one string entry; preserve full phrases exactly as printed (e.g. "round the corner"); do not split multi-word phrases; strip leading numbers/bullets from the stored text only; dedupe; omit empty strings. ' +
    '(2) passage: the dictation paragraph(s) or continuous prose block(s) for reading/dictation — NOT the numbered list. If there is no dictation passage, use an empty string "". ' +
    'Keep original spelling and casing from the source. No markdown, no explanation outside JSON.';

  const fetchOpenAIVisionOcr = async (base64, mimeType = 'image/jpeg') => {
    if (!openAIApiKey) {
      throw new Error('Missing EXPO_PUBLIC_OPENAI_API_KEY in .env');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAIApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: WORKSHEET_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  'Return strict JSON only: {"words":["entry1","entry2"],"passage":"full paragraph text or empty string"}. Put numbered spelling items in words; put the dictation story/paragraph in passage.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mimeType};base64,${base64}`,
                },
              },
            ],
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message ?? 'OpenAI Vision request failed.';
      throw new Error(message);
    }

    const content = payload?.choices?.[0]?.message?.content ?? '';
    return parseOcrFromOpenAIContent(content);
  };

  const tryOpenAIVisionOcr = async (base64, mimeType) => {
    try {
      return await fetchOpenAIVisionOcr(base64, mimeType);
    } catch {
      return null;
    }
  };

  const extractOcrFromPlainTextWithOpenAI = async (pageText) => {
    if (!openAIApiKey) {
      throw new Error('Missing EXPO_PUBLIC_OPENAI_API_KEY in .env');
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAIApiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: WORKSHEET_SYSTEM_PROMPT,
          },
          {
            role: 'user',
            content:
              'Return strict JSON only: {"words":["entry1","entry2"],"passage":"full paragraph text or empty string"}. ' +
              'The text below was extracted from page 1 of a worksheet PDF (line breaks may be imperfect). Infer the numbered spelling list and dictation passage from it.\n\n---\n' +
              String(pageText ?? '').slice(0, 48000) +
              '\n---',
          },
        ],
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message ?? 'OpenAI text request failed.';
      throw new Error(message);
    }

    const content = payload?.choices?.[0]?.message?.content ?? '';
    return parseOcrFromOpenAIContent(content);
  };

  const runVisionOcrPipeline = async (base64, mimeType, previewUri) => {
    setPdfPreviewName('');
    setPhotoUri(previewUri ?? '');
    setExtractedPassage('');
    setErrorMsg(null);
    setIsExtracting(true);
    try {
      await waitOcrRateLimit();
      const result = await fetchOpenAIVisionOcr(base64, mimeType);
      console.log('OCR result:', JSON.stringify(result));
      const words = Array.isArray(result?.words) ? result.words : [];
      const passage = typeof result?.passage === 'string' ? result.passage : '';
      console.log('Setting words:', words);
      setExtractedWords(words);
      setExtractedPassage(passage);
      if (!words.length && !passage.trim()) {
        setErrorMsg('No spelling list or dictation passage was detected. Please try another photo.');
      } else {
        scheduleScrollToReviewSection();
      }
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to extract content from image.');
    } finally {
      setIsExtracting(false);
    }
  };

  const runPdfOcrPipeline = async (base64Pdf, displayName) => {
    setPdfPreviewName(displayName);
    setPhotoUri('');
    setExtractedPassage('');
    setErrorMsg(null);
    setIsExtracting(true);
    try {
      await waitOcrRateLimit();
      let parsed = await tryOpenAIVisionOcr(base64Pdf, 'application/pdf');

      const visionEmpty = !parsed || (!parsed.words.length && !String(parsed.passage ?? '').trim());
      if (visionEmpty) {
        const pageText = await extractTextFromPdfPage1Base64(base64Pdf);
        if (!pageText.trim()) {
          throw new Error(
            'Could not read this PDF (Vision + text extract failed). Export page 1 as an image or use Take a Photo.',
          );
        }
        await waitOcrRateLimit();
        parsed = await extractOcrFromPlainTextWithOpenAI(pageText);
      }

      const pdfWords = Array.isArray(parsed?.words) ? parsed.words : [];
      const pdfPassage = typeof parsed?.passage === 'string' ? parsed.passage : '';
      console.log('OCR result:', JSON.stringify({ words: pdfWords, passage: pdfPassage }));
      console.log('Setting words:', pdfWords);
      setExtractedWords(pdfWords);
      setExtractedPassage(pdfPassage);
      if (!pdfWords.length && !pdfPassage.trim()) {
        setErrorMsg('No spelling list or dictation passage was detected in the PDF.');
      } else {
        scheduleScrollToReviewSection();
      }
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to extract from PDF.');
    } finally {
      setIsExtracting(false);
    }
  };

  /** Same OCR path for camera + library; falls back to reading base64 from uri if picker omits it. */
  const processImageWithOCR = async (uri, opts = {}) => {
    let base64 = opts.base64;
    if (!base64 && uri) {
      try {
        base64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
      } catch {
        setErrorMsg('Could not read image data from the photo.');
        return;
      }
    }
    if (!base64) {
      setErrorMsg('Could not read image data from the photo.');
      return;
    }
    let mime =
      opts.mimeType && String(opts.mimeType).startsWith('image/')
        ? opts.mimeType
        : 'image/jpeg';
    // Picker often returns JPEG base64 while asset.mimeType is still image/heic — Vision data URL must match bytes.
    if (
      opts.base64 &&
      (mime === 'image/heic' || mime === 'image/heif')
    ) {
      mime = 'image/jpeg';
    }
    await runVisionOcrPipeline(base64, mime, uri ?? '');
  };

  const processPhotoQueueWithOCR = async () => {
    if (!photoQueue?.length) return;
    setErrorMsg(null);
    setIsExtracting(true);
    setPdfPreviewName('');
    setPhotoUri(photoQueue?.[0]?.uri ?? '');
    setExtractedPassage('');
    setExtractedWords([]);
    try {
      const allWordsRaw = [];
      const passages = [];

      for (const photo of photoQueue) {
        if (!photo?.uri) continue;
        let base64 = photo.base64;
        if (!base64) {
          try {
            base64 = await FileSystem.readAsStringAsync(photo.uri, {
              encoding: FileSystem.EncodingType.Base64,
            });
          } catch {
            // Skip photos that can't be read as base64.
            continue;
          }
        }
        if (!base64) continue;

        let mimeType = photo.mimeType;
        if (!mimeType || !String(mimeType).startsWith('image/')) mimeType = 'image/jpeg';

        await waitOcrRateLimit();
        const result = await fetchOpenAIVisionOcr(base64, mimeType);
        if (Array.isArray(result?.words)) allWordsRaw.push(...result.words);
        if (typeof result?.passage === 'string' && result.passage.trim()) passages.push(result.passage.trim());
      }

      const mergedWords = normalizeWords(allWordsRaw);
      const mergedPassage = passages.join('\n\n').trim();

      setExtractedWords(mergedWords);
      setExtractedPassage(mergedPassage);

      if (!mergedWords.length && !mergedPassage) {
        setErrorMsg('No spelling list or dictation passage was detected. Please try another photo.');
      } else {
        scheduleScrollToReviewSection();
      }
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to extract content from photos.');
    } finally {
      setIsExtracting(false);
    }
  };

  const onTakePhoto = async () => {
    setErrorMsg(null);
    setSaveSuccess(null);

    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setErrorMsg('Camera permission is required to take a photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.7,
        base64: true,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setErrorMsg('Could not read photo data from the camera.');
        return;
      }

      // Queue it; do not OCR yet.
      setPdfPreviewName('');
      setPhotoUri('');
      setExtractedWords([]);
      setExtractedPassage('');
      setPhotoQueue((prev) => [
        ...prev,
        {
          uri: asset.uri,
          base64: asset.base64,
          mimeType: 'image/jpeg',
        },
      ]);
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to open camera.');
    }
  };

  const onChooseFromLibrary = async () => {
    setErrorMsg(null);
    setSaveSuccess(null);

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setErrorMsg('Photo library permission is required to choose a photo.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.8,
        base64: true,
      });

      if (result.canceled) return;

      const assets = Array.isArray(result.assets) ? result.assets : [];
      const queuedPhotos = assets
        .filter((asset) => Boolean(asset?.uri))
        .map((asset) => ({
          uri: asset.uri,
          base64: asset.base64,
          mimeType:
            asset.mimeType && String(asset.mimeType).startsWith('image/')
              ? asset.mimeType
              : 'image/jpeg',
        }));

      if (!queuedPhotos.length) {
        setErrorMsg('Could not read image data from the photo.');
        return;
      }

      setPdfPreviewName('');
      setPhotoUri('');
      setExtractedWords([]);
      setExtractedPassage('');
      setPhotoQueue((prev) => [...prev, ...queuedPhotos]);
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to open photo library.');
    }
  };

  const onUploadFromFiles = async () => {
    setErrorMsg(null);
    setSaveSuccess(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        copyToCacheDirectory: true,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setErrorMsg('No file was selected.');
        return;
      }

      const name = asset.name ?? 'file';
      const mimeRaw = asset.mimeType ?? '';
      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const isPdf =
        mimeRaw === 'application/pdf' || String(name).toLowerCase().endsWith('.pdf');

      if (isPdf) {
        await runPdfOcrPipeline(base64, name);
        return;
      }

      const imageMime =
        mimeRaw && mimeRaw.startsWith('image/')
          ? mimeRaw
          : guessImageMimeFromFileName(name);
      await runVisionOcrPipeline(base64, imageMime, asset.uri);
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to read the selected file.');
    }
  };

  const onEditExtractedWord = (index, value) => {
    setExtractedWords((prev) => prev.map((word, i) => (i === index ? value : word)));
  };

  const onDeleteExtractedWord = (index) => {
    setExtractedWords((prev) => prev.filter((_, i) => i !== index));
  };

  const onSaveOcrReview = async () => {
    Keyboard.dismiss();
    const wl = weekLabel.trim();
    setSaveSuccess(null);
    if (!wl) {
      setErrorMsg('Please enter a week label (e.g. Week 5).');
      return;
    }

    const confirmedWords = normalizeWords(extractedWords);
    /** Full dictation text comes from state `extractedPassage` (multiline input). */
    const passageText = extractedPassage.trim();

    if (!confirmedWords.length && !passageText) {
      setErrorMsg('Add at least one spelling entry or dictation passage before saving.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      console.log('Passage text to save:', passageText);
      console.log('Week label:', weekLabel);
      console.log('Week label (trimmed, used for DB):', wl);
      console.log('User ID:', userId ?? '(null)');
      if (!userId) {
        setErrorMsg('You must be logged in to save.');
        return;
      }

      let insertedWordRows = [];
      if (confirmedWords.length) {
        const rows = confirmedWords.map((word) => ({
          word,
          user_id: userId,
          week_label: wl,
        }));
        const { data: insertedData, error: wordsError } = await supabase
          .from('words')
          .insert(rows)
          .select('id, word, user_id, week_label');
        if (wordsError) throw wordsError;
        insertedWordRows = Array.isArray(insertedData) ? insertedData : [];
      }

      if (passageText) {
        console.log('[ImportScreen] Calling passages.insert with body, user_id, week_label (same wl as words).');
        const { error: passageError } = await supabase.from('passages').insert({
          body: passageText,
          user_id: userId,
          week_label: wl,
        });
        if (passageError) {
          console.log('Passage save error:', passageError);
          throw passageError;
        }
        console.log('Passage saved successfully');
      } else {
        console.log('[ImportScreen] Skipping passages insert — passageText is empty after trim.');
      }

      setSaveSuccess({
        count: confirmedWords.length,
        weekLabel: wl,
        words: insertedWordRows,
        passageSaved: Boolean(passageText),
      });
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to save words or passage.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    // Load list when user chooses manual input mode (does not clear OCR extract state).
    if (showManual) loadSavedWords();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showManual]);

  const onSaveWord = async () => {
    const trimmed = wordInput.trim();
    if (!trimmed) {
      setErrorMsg('Please enter a word.');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (!userId) {
        setErrorMsg('You must be logged in to save words.');
        return;
      }

      // Assumes your `words` table uses `word` and `user_id` columns.
      const { error } = await supabase.from('words').insert({ word: trimmed, user_id: userId });
      if (error) throw error;

      setWordInput('');
      await loadSavedWords();
    } catch (e) {
      // Likely cause: mismatched table/column schema (e.g. column is not named `word`).
      setErrorMsg(e?.message ?? 'Failed to save word.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: 300 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
      <Text style={styles.title}>Import Word List</Text>

      {photoQueue.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.photoStrip}
          contentContainerStyle={styles.photoStripContent}
          keyboardShouldPersistTaps="handled"
        >
          {photoQueue.map((p, idx) => (
            <View key={`${p.uri}-${idx}`} style={styles.thumbWrap}>
              <Image source={{ uri: p.uri }} style={styles.thumbImage} />
            </View>
          ))}
        </ScrollView>
      ) : null}

      {photoQueue.length === 0 ? (
        <TouchableOpacity style={styles.button} onPress={onTakePhoto} disabled={isExtracting}>
          <Text style={styles.buttonText}>📷 Take a Photo</Text>
        </TouchableOpacity>
      ) : (
        <>
          <TouchableOpacity
            style={styles.button}
            onPress={onTakePhoto}
            disabled={isExtracting}
          >
            <Text style={styles.buttonText}>＋ Add Another Photo</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.button, styles.secondButton]}
            onPress={processPhotoQueueWithOCR}
            disabled={isExtracting}
          >
            {isExtracting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.buttonText}>✅ Process All Photos</Text>
            )}
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity
        style={[styles.button, styles.secondButton]}
        onPress={onChooseFromLibrary}
      >
        <Text style={styles.buttonText}>🖼️ Choose from Library</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.button, styles.filesButton]} onPress={onUploadFromFiles}>
        <Text style={styles.buttonText}>📄 Upload from Files</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.button, styles.secondButton]}
        onPress={() => setShowManual(true)}
      >
        <Text style={styles.buttonText}>✏️ Type Manually</Text>
      </TouchableOpacity>

      {isExtracting ? (
        <View style={styles.processingBox}>
          <ActivityIndicator />
          <Text style={styles.processingText}>Extracting spelling list and dictation passage...</Text>
        </View>
      ) : null}

      {photoUri ? (
        <Image source={{ uri: photoUri }} style={styles.previewImage} />
      ) : null}

      {pdfPreviewName ? (
        <View style={styles.pdfPreviewBox}>
          <Text style={styles.pdfPreviewTitle}>📄 {pdfPreviewName}</Text>
          <Text style={styles.pdfPreviewSub}>PDF — page 1 processed (Vision or text extract)</Text>
        </View>
      ) : null}

      {extractedWords.length > 0 || extractedPassage.trim().length > 0 || showManual ? (
        <View style={styles.extractedSection} onLayout={onReviewSectionLayout}>
          <Text style={styles.manualTitle}>Review before saving</Text>

          <Text style={styles.sectionLabel}>Week label</Text>
          <TextInput
            style={styles.input}
            value={weekLabel}
            placeholder="e.g. Week 5, Term 2"
            onChangeText={setWeekLabel}
          />

          <Text style={styles.sectionLabel}>Spelling words & phrases</Text>
          {extractedWords.length ? (
            extractedWords.map((word, index) => (
              <View key={`extracted-${index}`} style={styles.extractedRow}>
                <TextInput
                  style={[styles.input, styles.extractedInput]}
                  value={word}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(value) => onEditExtractedWord(index, value)}
                />
                <TouchableOpacity
                  style={styles.deleteWordButton}
                  onPress={() => onDeleteExtractedWord(index)}
                >
                  <Text style={styles.deleteWordButtonText}>Delete</Text>
                </TouchableOpacity>
              </View>
            ))
          ) : (
            <Text style={styles.hintText}>No list items detected — you can add words manually below or retake the photo.</Text>
          )}

          <Text style={styles.sectionLabel}>Dictation passage (sentences)</Text>
          <Text style={styles.hintText}>
            Full dictation text for this week — type, paste, or edit what OCR extracted. Saved to your passages list.
          </Text>
          <TextInput
            style={[styles.input, styles.passageInput]}
            value={extractedPassage}
            multiline
            textAlignVertical="top"
            placeholder="Paste or type the full passage / sentences for dictation…"
            onChangeText={setExtractedPassage}
          />

          {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

          <TouchableOpacity style={styles.saveButton} onPress={onSaveOcrReview} disabled={saving}>
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save words, phrases & sentences</Text>
            )}
          </TouchableOpacity>

          {saveSuccess ? (
            <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()}>
              <View style={styles.successBox}>
                <Text style={styles.successText}>
                  {saveSuccess.passageSaved && saveSuccess.count === 0
                    ? '✓ Sentences saved.'
                    : saveSuccess.passageSaved
                      ? `✓ ${saveSuccess.count} words saved! Sentences saved.`
                      : `✓ ${saveSuccess.count} words saved!`}
                </Text>
                <TouchableWithoutFeedback onPress={() => Keyboard.dismiss()}>
                  <TouchableOpacity
                    style={styles.successStartBtn}
                    onPress={() =>
                      router.push({
                        pathname: '/learn',
                        params: {
                          weekLabel: String(saveSuccess.weekLabel ?? ''),
                          wordsJSON: JSON.stringify(saveSuccess.words ?? []),
                        },
                      })
                    }
                  >
                    <Text style={styles.successStartBtnText}>Start Learning →</Text>
                  </TouchableOpacity>
                </TouchableWithoutFeedback>
              </View>
            </TouchableWithoutFeedback>
          ) : null}
        </View>
      ) : null}

      {showManual ? (
        <View style={styles.manualSection}>
          <Text style={styles.manualTitle}>Add a word</Text>

          <TextInput
            style={styles.input}
            value={wordInput}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Enter word (e.g. enormous)"
            onChangeText={setWordInput}
          />

          {errorMsg &&
          !(extractedWords.length > 0 || extractedPassage.trim().length > 0 || showManual) ? (
            <Text style={styles.errorText}>{errorMsg}</Text>
          ) : null}

          <TouchableOpacity style={styles.saveButton} onPress={onSaveWord} disabled={saving}>
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save</Text>
            )}
          </TouchableOpacity>

          <View style={styles.wordsHeaderRow}>
            <Text style={styles.wordsTitle}>Saved Words</Text>
            {loadingWords ? <ActivityIndicator /> : null}
          </View>

          <View style={styles.wordsList}>
            {savedWords.map((item) => {
              const key = String(wordKey(item));
              const word = item?.word ?? item?.text ?? item?.value ?? '';
              return (
                <View key={key} style={styles.wordRow}>
                  <Text style={styles.wordText}>{word || '(unrecognized row)'}</Text>
                </View>
              );
            })}
            {!loadingWords && savedWords.length === 0 ? (
              <Text style={styles.emptyText}>No words saved yet</Text>
            ) : null}
          </View>

          <TouchableOpacity style={styles.backButton} onPress={() => setShowManual(false)}>
            <Text style={styles.backText}>← Back to options</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => router.back()}
      >
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    width: '100%',
    backgroundColor: '#fff',
  },
  scrollContent: {
    alignItems: 'center',
    paddingTop: 70,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#4A90E2',
    paddingHorizontal: 40,
    paddingVertical: 15,
    borderRadius: 25,
    marginBottom: 15,
    width: 250,
    alignItems: 'center',
  },
  secondButton: {
    backgroundColor: '#7ED321',
  },
  filesButton: {
    backgroundColor: '#F5A623',
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  photoStrip: {
    width: '100%',
    marginTop: 10,
    marginBottom: 10,
  },
  photoStripContent: {
    paddingHorizontal: 16,
    alignItems: 'center',
    gap: 12,
  },
  thumbWrap: {
    width: 64,
    height: 64,
    borderRadius: 10,
    backgroundColor: '#f4f4f4',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e4e4e4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumbImage: {
    width: '100%',
    height: '100%',
  },
  manualSection: {
    marginTop: 25,
    width: '90%',
  },
  extractedSection: {
    marginTop: 20,
    width: '90%',
  },
  sectionLabel: {
    alignSelf: 'stretch',
    fontSize: 14,
    fontWeight: '600',
    color: '#444',
    marginBottom: 6,
    marginTop: 8,
  },
  hintText: {
    color: '#888',
    fontSize: 14,
    marginBottom: 12,
  },
  passageInput: {
    minHeight: 120,
    marginBottom: 12,
  },
  extractedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
  },
  extractedInput: {
    flex: 1,
    marginBottom: 0,
  },
  deleteWordButton: {
    backgroundColor: '#f1f1f1',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
  },
  deleteWordButtonText: {
    color: '#555',
    fontWeight: '600',
  },
  processingBox: {
    marginTop: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  processingText: {
    marginTop: 8,
    color: '#555',
  },
  previewImage: {
    width: '90%',
    height: 200,
    borderRadius: 12,
    marginTop: 16,
    backgroundColor: '#f4f4f4',
  },
  pdfPreviewBox: {
    width: '90%',
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    backgroundColor: '#fff8ee',
    borderWidth: 1,
    borderColor: '#F5A623',
  },
  pdfPreviewTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
  },
  pdfPreviewSub: {
    marginTop: 6,
    fontSize: 13,
    color: '#666',
  },
  manualTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  errorText: {
    color: '#d00',
    marginBottom: 10,
  },
  saveButton: {
    backgroundColor: '#4A90E2',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 16,
  },
  saveButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  successBox: {
    borderWidth: 1,
    borderColor: '#7ED321',
    backgroundColor: '#F1FAE8',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  successText: {
    color: '#2D7A16',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  successStartBtn: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: '#7ED321',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  successStartBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  wordsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  wordsTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#333',
  },
  wordsList: {
    alignSelf: 'stretch',
    marginBottom: 10,
  },
  wordRow: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  wordText: {
    fontSize: 16,
    color: '#333',
  },
  emptyText: {
    color: '#888',
    paddingVertical: 14,
    textAlign: 'center',
  },
  backButton: {
    marginTop: 20,
  },
  backText: {
    color: '#4A90E2',
    fontSize: 16,
  },
});