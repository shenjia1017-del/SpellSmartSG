import { useNavigation, useRouter } from 'expo-router';
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
import { useChild } from '../lib/childContext';

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
  const navigation = useNavigation();
  const { currentChild } = useChild();
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [wordInput, setWordInput] = useState('');

  const [saving, setSaving] = useState(false);
  const [loadingWords, setLoadingWords] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const [savedWords, setSavedWords] = useState([]);
  const [photoUri, setPhotoUri] = useState('');
  const [pdfPreviewName, setPdfPreviewName] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedWords, setExtractedWords] = useState([]);
  const [extractedPassage, setExtractedPassage] = useState('');
  const [extractedWeekGroups, setExtractedWeekGroups] = useState([]);
  const [selectedWeekGroupLabel, setSelectedWeekGroupLabel] = useState('');
  const [editingWeekGroupIndex, setEditingWeekGroupIndex] = useState(-1);
  const [editingWeekGroupLabel, setEditingWeekGroupLabel] = useState('');
  const [manualWordToAdd, setManualWordToAdd] = useState('');
  const [weekLabel, setWeekLabel] = useState('');
  const [existingWeekLabels, setExistingWeekLabels] = useState([]);
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

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, () => {
      setIsKeyboardVisible(true);
      navigation.setOptions({
        tabBarStyle: { display: 'none' },
      });
    });

    const hideSub = Keyboard.addListener(hideEvent, () => {
      setIsKeyboardVisible(false);
      navigation.setOptions({
        tabBarStyle: undefined,
      });
    });

    return () => {
      showSub.remove();
      hideSub.remove();
      navigation.setOptions({
        tabBarStyle: undefined,
      });
    };
  }, [navigation]);

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
    const empty = { words: [], passage: '', weekGroups: [] };

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
      const weekGroups = Array.isArray(parsed.weekGroups)
        ? parsed.weekGroups
            .map((group) => {
              const weekLabel = String(group?.weekLabel ?? '').trim();
              const groupWords = normalizeWords(Array.isArray(group?.words) ? group.words : []);
              return { weekLabel, words: groupWords };
            })
            .filter((group) => group.weekLabel && group.words.length > 0)
        : [];
      return { words, passage, weekGroups };
    };

    try {
      const parsed = JSON.parse(content);
      const result = fromObject(parsed);
      if (result.words.length || result.passage || result.weekGroups.length) return result;
    } catch {
      // continue
    }

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch?.[0]) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        const result = fromObject(parsed);
        if (result.words.length || result.passage || result.weekGroups.length) return result;
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
      weekGroups: [],
    };
  };

  const loadSavedWords = async () => {
    setLoadingWords(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase
        .from('words')
        .select('*')
        .eq('child_id', currentChild?.id ?? '');
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

  const loadExistingWeekLabels = async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const userId = sessionData?.session?.user?.id;
      if (!userId) {
        setExistingWeekLabels([]);
        return;
      }
      const { data, error } = await supabase
        .from('words')
        .select('week_label')
        .eq('user_id', userId)
        .eq('child_id', currentChild?.id ?? '')
        .not('week_label', 'is', null);
      if (error) throw error;
      const seen = new Set();
      const labels = [];
      for (const row of Array.isArray(data) ? data : []) {
        const label = String(row?.week_label ?? '').trim();
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        labels.push(label);
      }
      setExistingWeekLabels(labels);
    } catch {
      setExistingWeekLabels([]);
    }
  };

  const WORKSHEET_SYSTEM_PROMPT = 'You are reading a photo of a Singapore primary school spelling worksheet. Return ONLY valid JSON with this exact shape: {"words":["..."],"passage":"","weekGroups":[]} No markdown, no explanation outside JSON. == STEP 0: Split the page into two zones == BEFORE extracting anything, mentally divide the page into: ZONE 1 (SPELLING ZONE): the top portion containing numbered items (1. 2. 3...) or a word column with example sentences. ZONE 2 (PASSAGE ZONE): the bottom portion under a heading like "Dictation", "Week __ Dictation", or a continuous prose block with no item numbers. The boundary between the two zones is usually marked by the "Dictation" heading or a clear visual separator. Words go ONLY from ZONE 1. Passage goes ONLY from ZONE 2. == STEP 1: Classify ZONE 1 structure == TYPE A - NUMBERED SENTENCES: ZONE 1 has numbered sentences where each contains one underlined or bold target word/phrase. TYPE C - WORD COLUMN LIST: ZONE 1 has a dedicated left column of words/phrases separate from example sentences on the right. TYPE D - MULTI-WEEK GRID: ZONE 1 is a grid with multiple week columns (Week 1, Week 2...) each containing words. == STEP 2: Extract spelling words from ZONE 1 ONLY == ABSOLUTE RULE: Words/phrases from ZONE 2 (the passage) are FORBIDDEN from entering the words array, even if they appear underlined, highlighted in yellow/green, or bold. Highlighter marks in the passage are for emphasis during dictation, NOT spelling targets. For TYPE A: extract ONLY the underlined or bold target word/phrase from each numbered sentence. Always extract the COMPLETE underlined span. If the underline covers multiple words, extract all as one phrase (e.g. "visit our relatives", "Mother whispered softly into my ear"), never only part. If entire sentence is underlined, extract whole sentence as one phrase. Do NOT extract surrounding sentence words. Do NOT put TYPE A sentences into passage. For TYPE C: extract ONLY from the dedicated word column. Preserve full multi-line phrases as one entry (e.g. scrambled up the ladder, approached with caution). Do NOT extract from example sentences column. For TYPE D: put empty array in words and fill weekGroups as array of objects like [{"weekLabel":"Week 1","words":["bridge","mountains"]},{"weekLabel":"Week 2","words":["first","second"]}]. Day names (Monday-Sunday) are valid spelling words; include them normally. == STEP 3: Extract dictation passage from ZONE 2 ONLY == CRITICAL: First locate the "Dictation" or "Week __ Dictation" heading. Start passage extraction from the VERY FIRST sentence IMMEDIATELY AFTER that heading. The first sentence after "Dictation" is often a quoted sentence (e.g. "This is beautiful," I thought out loud.) — this quoted sentence is ALWAYS the first sentence of the passage, never treat it as a caption or annotation. Do NOT skip it. Extract the COMPLETE prose block as one string, from the first sentence after the heading all the way to the last sentence before any footer/quote/decorative element. Handwritten notes in the margins are NOT part of the passage — ignore them. Before returning, verify: (a) does the passage start with the very first sentence after "Dictation"? (b) have you included the opening quoted sentence if there is one? If no ZONE 2 exists, passage must be empty string. TYPE A numbered sentences are NOT a dictation passage. == STEP 4: Final validation == Remove duplicate words case-insensitively. Keep original spelling and casing. Double-check: no word in the words array comes from the passage zone. If you find any, remove them.';

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
    setExtractedWeekGroups([]);
    setSelectedWeekGroupLabel('');
    setErrorMsg(null);
    setIsExtracting(true);
    try {
      await waitOcrRateLimit();
      const result = await fetchOpenAIVisionOcr(base64, mimeType);
      console.log('OCR result:', JSON.stringify(result));
      const words = Array.isArray(result?.words) ? result.words : [];
      const passage = typeof result?.passage === 'string' ? result.passage : '';
      const weekGroups = Array.isArray(result?.weekGroups) ? result.weekGroups : [];
      const singleWeekWords = weekGroups.length === 1 && Array.isArray(weekGroups[0]?.words)
        ? weekGroups[0].words
        : null;
      console.log('Setting words:', singleWeekWords ?? words);
      setExtractedWords(singleWeekWords ?? words);
      setExtractedPassage(passage);
      setExtractedWeekGroups(weekGroups);
      setSelectedWeekGroupLabel(weekGroups.length === 1 ? String(weekGroups[0]?.weekLabel ?? '') : '');
      if (!words.length && !passage.trim() && !weekGroups.length) {
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
    setExtractedWeekGroups([]);
    setSelectedWeekGroupLabel('');
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
      const pdfWeekGroups = Array.isArray(parsed?.weekGroups) ? parsed.weekGroups : [];
      const singleWeekWords = pdfWeekGroups.length === 1 && Array.isArray(pdfWeekGroups[0]?.words)
        ? pdfWeekGroups[0].words
        : null;
      console.log('OCR result:', JSON.stringify({ words: pdfWords, passage: pdfPassage }));
      console.log('Setting words:', singleWeekWords ?? pdfWords);
      setExtractedWords(singleWeekWords ?? pdfWords);
      setExtractedPassage(pdfPassage);
      setExtractedWeekGroups(pdfWeekGroups);
      setSelectedWeekGroupLabel(pdfWeekGroups.length === 1 ? String(pdfWeekGroups[0]?.weekLabel ?? '') : '');
      if (!pdfWords.length && !pdfPassage.trim() && !pdfWeekGroups.length) {
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

      await processImageWithOCR(asset.uri, {
        base64: asset.base64,
        mimeType: 'image/jpeg',
      });
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
        allowsMultipleSelection: false,
        quality: 0.8,
        base64: true,
      });

      if (result.canceled) return;

      const asset = result.assets?.[0];
      if (!asset?.uri) {
        setErrorMsg('Could not read image data from the photo.');
        return;
      }
      const mimeType =
        asset.mimeType && String(asset.mimeType).startsWith('image/')
          ? asset.mimeType
          : 'image/jpeg';
      await processImageWithOCR(asset.uri, { base64: asset.base64, mimeType });
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

  const onAddManualExtractedWord = () => {
    const next = String(manualWordToAdd ?? '').trim();
    if (!next) return;
    setExtractedWords((prev) => [...prev, next]);
    setManualWordToAdd('');
  };

  const onConfirmWeekGroupLabelEdit = (index) => {
    const nextLabel = String(editingWeekGroupLabel ?? '').trim();
    if (!nextLabel) {
      setEditingWeekGroupIndex(-1);
      setEditingWeekGroupLabel('');
      return;
    }
    setExtractedWeekGroups((prev) => {
      const current = Array.isArray(prev) ? prev : [];
      return current.map((group, i) => (i === index ? { ...group, weekLabel: nextLabel } : group));
    });
    if (selectedWeekGroupLabel === String(extractedWeekGroups[index]?.weekLabel ?? '')) {
      setSelectedWeekGroupLabel(nextLabel);
    }
    setWeekLabel(nextLabel);
    setEditingWeekGroupIndex(-1);
    setEditingWeekGroupLabel('');
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
      if (!currentChild?.id) {
        setErrorMsg('Please select a child profile first.');
        return;
      }

      let wordsToInsert = confirmedWords;
      if (confirmedWords.length) {
        const { data: existingWords, error: fetchError } = await supabase
          .from('words')
          .select('word')
          .eq('user_id', userId)
          .eq('child_id', currentChild.id)
          .eq('week_label', wl);
        
        if (fetchError) {
          console.log('Error fetching existing words:', fetchError);
          throw fetchError;
        }
        
        const existingLowercase = new Set(
          (existingWords || []).map(w => w.word.toLowerCase().trim())
        );
        
        wordsToInsert = confirmedWords.filter(
          w => !existingLowercase.has(w.toLowerCase().trim())
        );
        
        console.log(`[ImportScreen] Existing words in this week: ${existingLowercase.size}`);
        console.log(`[ImportScreen] New words to insert: ${wordsToInsert.length} (filtered from ${confirmedWords.length})`);
      }

      let insertedWordRows = [];
      if (wordsToInsert.length) {
        const rows = wordsToInsert.map((word) => ({
          word,
          user_id: userId,
          child_id: currentChild.id,
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
        console.log('[ImportScreen] Checking for existing passage in this week...');
        const { data: existingPassages, error: fetchPassageError } = await supabase
          .from('passages')
          .select('id, body')
          .eq('user_id', userId)
          .eq('child_id', currentChild.id)
          .eq('week_label', wl);
        
        if (fetchPassageError) {
          console.log('Error fetching existing passage:', fetchPassageError);
          throw fetchPassageError;
        }
        
        if (existingPassages && existingPassages.length > 0) {
          const existing = existingPassages[0];
          const existingBody = (existing.body || '').trim();
          
          // Merge: if existing is empty, use new. Otherwise append with newline.
          const mergedBody = existingBody 
            ? `${existingBody}\n\n${passageText}` 
            : passageText;
          
          console.log('[ImportScreen] Updating existing passage (merging content)');
          const { error: updateError } = await supabase
            .from('passages')
            .update({ body: mergedBody })
            .eq('id', existing.id);
          
          if (updateError) {
            console.log('Passage update error:', updateError);
            throw updateError;
          }
          console.log('Passage merged successfully');
        } else {
          console.log('[ImportScreen] No existing passage, inserting new one');
          const { error: passageError } = await supabase.from('passages').insert({
            body: passageText,
            user_id: userId,
            child_id: currentChild.id,
            week_label: wl,
          });
          if (passageError) {
            console.log('Passage save error:', passageError);
            throw passageError;
          }
          console.log('Passage saved successfully');
        }
      } else {
        console.log('[ImportScreen] Skipping passages — passageText is empty after trim.');
      }

      setSaveSuccess({
        count: wordsToInsert.length,
        totalWords: confirmedWords.length,
        skipped: confirmedWords.length - wordsToInsert.length,
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

  useEffect(() => {
    const hasReviewData =
      extractedWords.length > 0 ||
      extractedPassage.trim().length > 0 ||
      extractedWeekGroups.length > 0 ||
      showManual;
    if (!hasReviewData) return;
    loadExistingWeekLabels();
  }, [extractedWords.length, extractedPassage, extractedWeekGroups.length, showManual]);

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
      if (!currentChild?.id) {
        setErrorMsg('Please select a child profile first.');
        return;
      }

      // Assumes your `words` table uses `word` and `user_id` columns.
      const { error } = await supabase.from('words').insert({
        word: trimmed,
        user_id: userId,
        child_id: currentChild.id,
      });
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
      <View style={styles.container}>
        <View style={styles.pageHeader}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backBtnText}>←</Text>
          </TouchableOpacity>
          <View>
            <Text style={styles.pageTitle}>Import Word List</Text>
            <Text style={styles.pageSubtitle}>Choose how to add words</Text>
          </View>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.scrollArea}
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 100 }]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator
        >
          <TouchableOpacity
            style={styles.importCardPrimary}
            onPress={onTakePhoto}
            disabled={isExtracting}
          >
            <Text style={styles.importIcon}>📷</Text>
            <View style={styles.importInfo}>
              <Text style={styles.importTitlePrimary}>Take a Photo</Text>
              <Text style={styles.importSubPrimary}>Scan your school word list</Text>
            </View>
            <Text style={styles.importArrowPrimary}>→</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.importCard} onPress={onChooseFromLibrary}>
            <Text style={styles.importIcon}>🖼️</Text>
            <View style={styles.importInfo}>
              <Text style={styles.importTitle}>Choose from Library</Text>
              <Text style={styles.importSub}>Select an existing photo</Text>
            </View>
            <Text style={styles.importArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.importCard} onPress={onUploadFromFiles}>
            <Text style={styles.importIcon}>📄</Text>
            <View style={styles.importInfo}>
              <Text style={styles.importTitle}>Upload from Files</Text>
              <Text style={styles.importSub}>PDF or image file</Text>
            </View>
            <Text style={styles.importArrow}>›</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.importCard} onPress={() => setShowManual(true)}>
            <Text style={styles.importIcon}>✏️</Text>
            <View style={styles.importInfo}>
              <Text style={styles.importTitle}>Type Manually</Text>
              <Text style={styles.importSub}>Enter words one by one</Text>
            </View>
            <Text style={styles.importArrow}>›</Text>
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

      {extractedWords.length > 0 || extractedPassage.trim().length > 0 || extractedWeekGroups.length > 0 || showManual ? (
        <View style={styles.extractedSection} onLayout={onReviewSectionLayout}>
          <Text style={styles.manualTitle}>Review before saving</Text>

          <Text style={styles.sectionLabel}>Week label</Text>
          {existingWeekLabels.length > 0 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.weekChipsRow}
              contentContainerStyle={styles.weekChipsContent}
              keyboardShouldPersistTaps="handled"
            >
              {existingWeekLabels.map((label) => (
                <TouchableOpacity
                  key={`week-chip-${label}`}
                  style={[
                    styles.weekChip,
                    weekLabel.trim().toLowerCase() === label.toLowerCase() && styles.weekChipActive,
                  ]}
                  onPress={() => setWeekLabel(label)}
                >
                  <Text
                    style={[
                      styles.weekChipText,
                      weekLabel.trim().toLowerCase() === label.toLowerCase() && styles.weekChipTextActive,
                    ]}
                  >
                    {label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          ) : null}
          <TextInput
            style={styles.input}
            value={weekLabel}
            placeholder="e.g. Week 5, Term 2"
            onChangeText={setWeekLabel}
          />

          <Text style={styles.sectionLabel}>Spelling words & phrases</Text>
          {extractedWeekGroups.length > 1 ? (
            <View style={styles.weekGroupSelectorWrap}>
              <Text style={styles.hintText}>This page has multiple weeks — tap the week you need:</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.weekChipsRow}
                contentContainerStyle={styles.weekChipsContent}
                keyboardShouldPersistTaps="handled"
              >
                {extractedWeekGroups.map((group, index) => (
                  <TouchableOpacity
                    key={`ocr-week-group-${index}`}
                    style={[
                      styles.weekGroupChip,
                      selectedWeekGroupLabel === group.weekLabel && styles.weekGroupChipActive,
                    ]}
                    onPress={() => {
                      setSelectedWeekGroupLabel(group.weekLabel);
                      setWeekLabel(group.weekLabel);
                      setExtractedWords(Array.isArray(group.words) ? group.words : []);
                    }}
                  >
                    {editingWeekGroupIndex === index ? (
                      <View style={styles.weekGroupEditRow}>
                        <TextInput
                          style={styles.weekGroupEditInput}
                          value={editingWeekGroupLabel}
                          onChangeText={setEditingWeekGroupLabel}
                          autoFocus
                          onSubmitEditing={() => onConfirmWeekGroupLabelEdit(index)}
                          onBlur={() => onConfirmWeekGroupLabelEdit(index)}
                          returnKeyType="done"
                        />
                        <TouchableOpacity
                          onPress={() => onConfirmWeekGroupLabelEdit(index)}
                          style={styles.weekGroupDoneBtn}
                        >
                          <Text style={styles.weekGroupDoneBtnText}>Done</Text>
                        </TouchableOpacity>
                      </View>
                    ) : (
                      <View style={styles.weekGroupLabelRow}>
                        <Text
                          style={[
                            styles.weekGroupChipText,
                            selectedWeekGroupLabel === group.weekLabel && styles.weekGroupChipTextActive,
                          ]}
                        >
                          {group.weekLabel}
                        </Text>
                        <TouchableOpacity
                          onPress={() => {
                            setEditingWeekGroupIndex(index);
                            setEditingWeekGroupLabel(String(group.weekLabel ?? ''));
                          }}
                          style={styles.weekGroupEditIconBtn}
                        >
                          <Text
                            style={[
                              styles.weekGroupEditIcon,
                              selectedWeekGroupLabel === group.weekLabel && styles.weekGroupChipTextActive,
                            ]}
                          >
                            ✏️
                          </Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : null}
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

          <View style={styles.addWordRow}>
            <TextInput
              style={[styles.input, styles.addWordInput]}
              value={manualWordToAdd}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="Add a missing word or phrase"
              onChangeText={setManualWordToAdd}
            />
            <TouchableOpacity style={styles.addWordButton} onPress={onAddManualExtractedWord}>
              <Text style={styles.addWordButtonText}>Add</Text>
            </TouchableOpacity>
          </View>

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
                  {`Saved ${saveSuccess.count} new words to ${String(saveSuccess.weekLabel ?? '')}`}
                </Text>
                {Number(saveSuccess.skipped ?? 0) > 0 ? (
                  <Text style={styles.successMetaText}>
                    {`${saveSuccess.skipped} words already existed in this week and were skipped.`}
                  </Text>
                ) : null}
                {saveSuccess.passageSaved ? (
                  <Text style={styles.successMetaText}>Dictation passage merged.</Text>
                ) : null}
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

        </ScrollView>

        {!isKeyboardVisible ? (
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
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FFF8F0' },
  pageHeader: {
    backgroundColor: '#FFF8F0',
    paddingHorizontal: 16,
    paddingTop: 56,
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
  scrollContent: { padding: 14, gap: 8, alignItems: 'stretch' },
  importCardPrimary: {
    backgroundColor: '#F97316',
    borderRadius: 14,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    shadowColor: '#F97316',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  importCard: {
    backgroundColor: 'white',
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: '#F0E8DC',
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  importIcon: { fontSize: 24 },
  importInfo: { flex: 1 },
  importTitlePrimary: { fontSize: 14, fontWeight: '700', color: 'white' },
  importTitle: { fontSize: 14, fontWeight: '700', color: '#1A1A1A' },
  importSubPrimary: { fontSize: 10, color: 'rgba(255,255,255,0.75)', marginTop: 2 },
  importSub: { fontSize: 10, color: '#999', marginTop: 2 },
  importArrowPrimary: { fontSize: 18, color: 'white', fontWeight: '700' },
  importArrow: { fontSize: 18, color: '#F97316', fontWeight: '700' },
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

  manualSection: {
    marginTop: 25,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
  },
  extractedSection: {
    marginTop: 20,
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
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
  weekChipsRow: {
    marginBottom: 10,
  },
  weekChipsContent: {
    gap: 8,
    paddingRight: 8,
  },
  weekChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#F0E8DC',
    backgroundColor: '#fff',
  },
  weekChipActive: {
    borderColor: '#F97316',
    backgroundColor: '#FFF3E0',
  },
  weekChipText: {
    color: '#666',
    fontSize: 13,
    fontWeight: '600',
  },
  weekChipTextActive: {
    color: '#F97316',
  },
  weekGroupSelectorWrap: {
    marginBottom: 6,
  },
  weekGroupChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#F97316',
    backgroundColor: '#FFF3E0',
  },
  weekGroupChipActive: {
    backgroundColor: '#F97316',
  },
  weekGroupChipText: {
    color: '#F97316',
    fontSize: 13,
    fontWeight: '700',
  },
  weekGroupChipTextActive: {
    color: '#fff',
  },
  weekGroupLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  weekGroupEditIconBtn: {
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  weekGroupEditIcon: {
    color: '#F97316',
    fontSize: 12,
  },
  weekGroupEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  weekGroupEditInput: {
    minWidth: 80,
    borderWidth: 1,
    borderColor: '#F0E8DC',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    fontSize: 13,
    color: '#333',
    backgroundColor: '#fff',
  },
  weekGroupDoneBtn: {
    backgroundColor: '#F97316',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  weekGroupDoneBtnText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
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
  addWordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  addWordInput: {
    flex: 1,
    marginBottom: 0,
  },
  addWordButton: {
    backgroundColor: '#F97316',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addWordButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
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
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    height: 200,
    borderRadius: 12,
    marginTop: 16,
    backgroundColor: '#f4f4f4',
  },
  pdfPreviewBox: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
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
    backgroundColor: '#FFA726',
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
    marginBottom: 8,
  },
  successMetaText: {
    color: '#2D7A16',
    fontSize: 14,
    marginBottom: 8,
  },
  successStartBtn: {
    width: '100%',
    alignItems: 'center',
    backgroundColor: '#66BB6A',
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