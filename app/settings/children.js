import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChild } from '../lib/childContext';

const MAX_CHILDREN = 5;

function avatarForGender(gender) {
  return gender === 'girl'
    ? { emoji: '👧', bg: '#FCE7F3' }
    : { emoji: '👦', bg: '#DBEAFE' };
}

function GenderToggle({ value, onChange }) {
  return (
    <View style={styles.genderRow}>
      <TouchableOpacity
        style={[styles.genderBtn, value === 'boy' && styles.genderBtnActive]}
        onPress={() => onChange('boy')}
      >
        <Text style={[styles.genderText, value === 'boy' && styles.genderTextActive]}>Boy</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.genderBtn, value === 'girl' && styles.genderBtnActive]}
        onPress={() => onChange('girl')}
      >
        <Text style={[styles.genderText, value === 'girl' && styles.genderTextActive]}>Girl</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function ChildrenSettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { children, addChild, updateChild, deleteChild, refreshChildren } = useChild();
  const [creating, setCreating] = useState(false);
  const [editingChild, setEditingChild] = useState(null);
  const [name, setName] = useState('');
  const [gender, setGender] = useState('boy');
  const [busy, setBusy] = useState(false);

  const subtitle = useMemo(() => `${children.length} / ${MAX_CHILDREN} children`, [children.length]);
  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/select-child');
    }
  };

  const openAdd = () => {
    setName('');
    setGender('boy');
    setCreating(true);
  };

  const openEdit = (child) => {
    setEditingChild(child);
    setName(String(child?.name ?? ''));
    setGender(child?.gender === 'girl' ? 'girl' : 'boy');
  };

  const closeModal = () => {
    setCreating(false);
    setEditingChild(null);
    setBusy(false);
    setName('');
    setGender('boy');
  };

  return (
    <LinearGradient colors={['#FFF4E8', '#FFF8F0', '#FFFBF5']} style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity onPress={handleBack}>
          <Text style={styles.backText}>← Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Children</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.listWrap}>
        {children.map((child) => {
          const avatar = avatarForGender(child.gender);
          return (
            <View key={child.id} style={styles.row}>
              <View style={[styles.avatar, { backgroundColor: avatar.bg }]}>
                <Text style={styles.avatarEmoji}>{avatar.emoji}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{child.name}</Text>
                <Text style={styles.rowGender}>{child.gender === 'girl' ? 'Girl' : 'Boy'}</Text>
              </View>
              <TouchableOpacity style={styles.editBtn} onPress={() => openEdit(child)}>
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <TouchableOpacity
          style={[styles.addBtn, children.length >= MAX_CHILDREN && styles.addBtnDisabled]}
          disabled={children.length >= MAX_CHILDREN}
          onPress={openAdd}
        >
          <Text style={[styles.addBtnText, children.length >= MAX_CHILDREN && styles.addBtnTextDisabled]}>
            {children.length >= MAX_CHILDREN ? 'Maximum 5 children reached' : '+ Add a child'}
          </Text>
        </TouchableOpacity>
      </ScrollView>

      <Modal visible={creating || Boolean(editingChild)} transparent animationType="fade" onRequestClose={closeModal}>
        <Pressable style={styles.modalBackdrop} onPress={closeModal}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{creating ? 'Add child' : 'Edit child'}</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Child name"
            />
            <GenderToggle value={gender} onChange={setGender} />

            <TouchableOpacity
              style={styles.primaryBtn}
              disabled={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  if (creating) await addChild(name, gender);
                  else if (editingChild?.id) await updateChild(editingChild.id, name, gender);
                  await refreshChildren();
                  closeModal();
                } catch (e) {
                  Alert.alert('Error', e?.message ?? 'Failed to save child.');
                  setBusy(false);
                }
              }}
            >
              <Text style={styles.primaryBtnText}>{creating ? 'Add' : 'Save'}</Text>
            </TouchableOpacity>

            {!creating ? (
              <TouchableOpacity
                onPress={() => {
                  Alert.alert(
                    'Delete child?',
                    'Are you sure? All learning data for this child will be deleted.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete child',
                        style: 'destructive',
                        onPress: async () => {
                          try {
                            if (editingChild?.id) await deleteChild(editingChild.id);
                            closeModal();
                          } catch (e) {
                            Alert.alert('Error', e?.message ?? 'Failed to delete child.');
                          }
                        },
                      },
                    ],
                  );
                }}
              >
                <Text style={styles.deleteText}>Delete child</Text>
              </TouchableOpacity>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingTop: 0, paddingHorizontal: 16, marginBottom: 10 },
  backText: { color: '#F97316', fontWeight: '700', fontSize: 16, marginBottom: 10 },
  title: { fontSize: 24, fontWeight: '900', color: '#1A1A1A' },
  subtitle: { fontSize: 13, color: '#666', marginTop: 4 },
  listWrap: { padding: 16, gap: 10 },
  row: {
    backgroundColor: '#fff',
    borderWidth: 1.5,
    borderColor: '#F0E8DC',
    borderRadius: 14,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarEmoji: { fontSize: 22 },
  rowName: { fontSize: 16, fontWeight: '700', color: '#222' },
  rowGender: { fontSize: 12, color: '#999', marginTop: 2 },
  editBtn: { borderWidth: 1, borderColor: '#F0E8DC', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  editBtnText: { color: '#F97316', fontWeight: '700' },
  addBtn: {
    marginTop: 8,
    borderStyle: 'dashed',
    borderWidth: 2,
    borderColor: '#F97316',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: '#FFF8F0',
  },
  addBtnDisabled: { borderColor: '#ccc', backgroundColor: '#f3f3f3' },
  addBtnText: { color: '#F97316', fontWeight: '700' },
  addBtnTextDisabled: { color: '#999' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.28)', justifyContent: 'center', padding: 18 },
  modalCard: { backgroundColor: '#fff', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#F0E8DC' },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#1A1A1A', marginBottom: 10 },
  input: { borderWidth: 1, borderColor: '#ddd', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 },
  genderRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  genderBtn: { flex: 1, borderWidth: 1.5, borderColor: '#F0E8DC', borderRadius: 10, paddingVertical: 10, alignItems: 'center', backgroundColor: '#fff' },
  genderBtnActive: { borderColor: '#F97316', backgroundColor: '#FFF3E0' },
  genderText: { color: '#777', fontWeight: '700' },
  genderTextActive: { color: '#F97316' },
  primaryBtn: { backgroundColor: '#F97316', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  deleteText: { textAlign: 'center', marginTop: 14, color: '#D14343', fontWeight: '700' },
});
