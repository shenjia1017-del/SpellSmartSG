import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { supabase } from '../../lib/supabase';

export default function ImportScreen({ navigation }) {
  const [showManual, setShowManual] = useState(false);
  const [wordInput, setWordInput] = useState('');

  const [saving, setSaving] = useState(false);
  const [loadingWords, setLoadingWords] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const [savedWords, setSavedWords] = useState([]);
  const [photoUri, setPhotoUri] = useState('');
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractedWords, setExtractedWords] = useState([]);

  const openAIApiKey = process.env.EXPO_PUBLIC_OPENAI_API_KEY;

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

  const parseWordsFromOpenAIContent = (content) => {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) return normalizeWords(parsed);
      if (Array.isArray(parsed?.words)) return normalizeWords(parsed.words);
    } catch {
      // If content is not raw JSON, try to parse fenced/embedded JSON below.
    }

    const jsonMatch = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch?.[0]) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) return normalizeWords(parsed);
        if (Array.isArray(parsed?.words)) return normalizeWords(parsed.words);
      } catch {
        // Ignore and fallback to line parsing.
      }
    }

    return normalizeWords(
      content
        .split('\n')
        .map((line) => line.replace(/^[\-\d\.\)\s]+/, '').trim())
        .filter(Boolean),
    );
  };

  const loadSavedWords = async () => {
    setLoadingWords(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.from('words').select('*');
      if (error) throw error;
      setSavedWords(Array.isArray(data) ? data : []);
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to load words.');
    } finally {
      setLoadingWords(false);
    }
  };

  const extractWordsFromImageWithOpenAI = async (base64Image) => {
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
            content:
              'You extract spelling entries from photos of spelling lists. Return only JSON in this format: {"words":["entry1","entry2"]}. Preserve each full entry exactly as it appears, including multi-word phrases (for example: "round the corner", "squinted my eyes", "organising a contest"). Do not split phrases into single words. Keep original casing, remove punctuation-only entries, and avoid duplicates.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Extract the complete spelling entries from this image. Each line/phrase in the list should remain one entry. Return strict JSON only: {"words":["..."]}. Do not split multi-word phrases.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Image}`,
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
    const words = parseWordsFromOpenAIContent(content);
    return words;
  };

  const onTakePhoto = async () => {
    setErrorMsg(null);

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
    if (!asset?.base64) {
      setErrorMsg('Could not read image data from the captured photo.');
      return;
    }

    setPhotoUri(asset.uri ?? '');
    setIsExtracting(true);
    try {
      const words = await extractWordsFromImageWithOpenAI(asset.base64);
      setExtractedWords(words);
      if (!words.length) {
        setErrorMsg('No words were detected. Please try another photo.');
      }
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to extract words from image.');
    } finally {
      setIsExtracting(false);
    }
  };

  const onEditExtractedWord = (index, value) => {
    setExtractedWords((prev) => prev.map((word, i) => (i === index ? value : word)));
  };

  const onDeleteExtractedWord = (index) => {
    setExtractedWords((prev) => prev.filter((_, i) => i !== index));
  };

  const onSaveExtractedWords = async () => {
    const confirmedWords = normalizeWords(extractedWords);
    if (!confirmedWords.length) {
      setErrorMsg('Please keep at least one word before saving.');
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

      const rows = confirmedWords.map((word) => ({ word, user_id: userId }));
      const { error } = await supabase.from('words').insert(rows);
      if (error) throw error;

      setExtractedWords([]);
      await loadSavedWords();
      setShowManual(true);
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to save extracted words.');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    // Load list when user chooses manual input mode.
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
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Import Word List</Text>

      <TouchableOpacity style={styles.button} onPress={onTakePhoto}>
        <Text style={styles.buttonText}>📷 Take a Photo</Text>
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
          <Text style={styles.processingText}>Extracting words from image...</Text>
        </View>
      ) : null}

      {photoUri ? (
        <Image source={{ uri: photoUri }} style={styles.previewImage} />
      ) : null}

      {extractedWords.length ? (
        <View style={styles.extractedSection}>
          <Text style={styles.manualTitle}>Review extracted words</Text>
          {extractedWords.map((word, index) => (
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
          ))}

          <TouchableOpacity
            style={styles.saveButton}
            onPress={onSaveExtractedWords}
            disabled={saving}
          >
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.saveButtonText}>Save Confirmed Words</Text>
            )}
          </TouchableOpacity>
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

          {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

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

          <FlatList
            style={styles.wordsList}
            data={savedWords}
            keyExtractor={(item) => String(wordKey(item))}
            renderItem={({ item }) => {
              const word = item?.word ?? item?.text ?? item?.value ?? '';
              return (
                <View style={styles.wordRow}>
                  <Text style={styles.wordText}>{word || '(unrecognized row)'}</Text>
                </View>
              );
            }}
            ListEmptyComponent={
              !loadingWords ? (
                <Text style={styles.emptyText}>No words saved yet</Text>
              ) : null
            }
          />

          <TouchableOpacity style={styles.backButton} onPress={() => setShowManual(false)}>
            <Text style={styles.backText}>← Back to options</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    backgroundColor: '#fff',
    paddingTop: 70,
    paddingBottom: 30,
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
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  manualSection: {
    marginTop: 25,
    width: '90%',
  },
  extractedSection: {
    marginTop: 20,
    width: '90%',
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
    flexGrow: 0,
    maxHeight: 280,
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