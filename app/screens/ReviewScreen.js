import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const BLUE = '#378ADD';

function parseWrongWordsParam(params) {
  const raw = params.wrongWords;
  if (raw == null) return [];
  const s = Array.isArray(raw) ? raw[0] : String(raw);
  if (!String(s).trim()) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

export default function ReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const wrongWords = parseWrongWordsParam(params);
  const n = wrongWords.length;

  return (
    <LinearGradient colors={['#E3F2FD', '#F1F8FF', '#FFF8F0']} style={styles.safe}>
      <View style={styles.bgDecor} pointerEvents="none">
        <View style={[styles.cloud, { top: 38, left: 18, width: 80, height: 36 }]} />
        <View style={[styles.cloud, { top: 28, left: 55, width: 60, height: 28 }]} />
        <View style={styles.sun} />
      </View>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + 12 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>Review</Text>
        <Text style={styles.subtitle}>
          {n} wrong word{n === 1 ? '' : 's'}
        </Text>

        <View style={styles.chipsWrap}>
          {wrongWords.map((w, i) => (
            <View key={`${i}-${w}`} style={styles.chip}>
              <Text style={styles.chipText}>{w}</Text>
            </View>
          ))}
        </View>
        {n === 0 ? <Text style={styles.emptyHint}>No words in this list.</Text> : null}

        <TouchableOpacity
          style={[styles.primaryBtn, n === 0 && styles.btnDisabled]}
          disabled={n === 0}
          onPress={() =>
            router.push({
              pathname: '/learn',
              params: { wordsJSON: JSON.stringify(wrongWords) },
            })
          }
          activeOpacity={0.85}
        >
          <Text style={styles.primaryBtnText}>Re-learn these words →</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.secondaryBtn, n === 0 && styles.btnDisabled]}
          disabled={n === 0}
          onPress={() =>
            router.push({
              pathname: '/dictation',
              params: {
                wordsJSON: JSON.stringify(wrongWords),
                autoStartWords: '1',
              },
            })
          }
          activeOpacity={0.85}
        >
          <Text style={styles.secondaryBtnText}>Dictation — wrong words only</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.homeGrayBtn}
          onPress={() => router.push('/home')}
          activeOpacity={0.85}
        >
          <Text style={styles.homeGrayBtnText}>← Back to home</Text>
        </TouchableOpacity>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  bgDecor: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  cloud: { position: 'absolute', backgroundColor: 'white', borderRadius: 99, opacity: 0.85 },
  sun: {
    position: 'absolute',
    top: 32,
    right: 24,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFD740',
    opacity: 0.8,
  },
  scroll: {
    padding: 20,
    paddingBottom: 40,
    gap: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    color: '#222',
  },
  subtitle: {
    fontSize: 17,
    color: '#666',
    marginBottom: 4,
  },
  chipsWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 8,
  },
  chip: {
    backgroundColor: '#ffebee',
    borderWidth: 1,
    borderColor: '#e57373',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chipText: {
    color: '#b71c1c',
    fontSize: 16,
    fontWeight: '600',
  },
  emptyHint: {
    fontSize: 15,
    color: '#888',
  },
  btnDisabled: {
    opacity: 0.45,
  },
  primaryBtn: {
    backgroundColor: BLUE,
    borderRadius: 14,
    paddingVertical: 18,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  secondaryBtn: {
    borderWidth: 2,
    borderColor: BLUE,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: BLUE,
    fontSize: 17,
    fontWeight: '700',
  },
  homeGrayBtn: {
    backgroundColor: '#9e9e9e',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  homeGrayBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
});
