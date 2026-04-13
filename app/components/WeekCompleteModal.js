import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity } from 'react-native';

export default function WeekCompleteModal({ visible, flower, newCreature, totalFlowers, onViewAlbum, onClose }) {
  if (!flower) return null;

  const nextCreatureIn = 4 - (totalFlowers % 4);

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={styles.overlay}>
        <View style={styles.card}>
          <Text style={styles.weekDone}>Week complete! 🎉</Text>

          <Text style={styles.bigEmoji}>{flower.emoji}</Text>
          <Text style={styles.flowerName}>{flower.name} collected</Text>
          <Text style={styles.flowerTotal}>{totalFlowers} flowers total</Text>

          {newCreature ? (
            <View style={styles.creatureBox}>
              <Text style={styles.newLabel}>New creature unlocked!</Text>
              <Text style={styles.creatureBig}>{newCreature.isGold ? '⭐' + newCreature.emoji : newCreature.emoji}</Text>
              <Text style={styles.creatureName}>{newCreature.isGold ? 'Golden ' + newCreature.name : newCreature.name}</Text>
              <Text style={styles.creatureCategory}>{newCreature.category}</Text>
            </View>
          ) : (
            <View style={styles.nextBox}>
              <Text style={styles.nextLabel}>
                {nextCreatureIn === 1
                  ? '🔥 1 more flower → new creature!'
                  : `${nextCreatureIn} more flowers → new creature`}
              </Text>
            </View>
          )}

          {newCreature && (
            <TouchableOpacity style={styles.btnPrimary} onPress={onViewAlbum}>
              <Text style={styles.btnPrimaryText}>View in album</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.btnOutline} onPress={onClose}>
            <Text style={styles.btnOutlineText}>
              {newCreature ? 'Back to home' : 'Keep going! 💪'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 24,
    padding: 28,
    width: '84%',
    alignItems: 'center',
  },
  weekDone: { fontSize: 15, color: '#888', marginBottom: 12 },
  bigEmoji: { fontSize: 56, marginBottom: 8 },
  flowerName: { fontSize: 20, fontWeight: '600', color: '#1a1a1a' },
  flowerTotal: { fontSize: 13, color: '#aaa', marginBottom: 20 },
  creatureBox: {
    backgroundColor: '#fff9e6',
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    width: '100%',
    marginBottom: 20,
  },
  newLabel: { fontSize: 12, color: '#888', marginBottom: 6 },
  creatureBig: { fontSize: 52, marginBottom: 6 },
  creatureName: { fontSize: 17, fontWeight: '600', color: '#1a1a1a' },
  creatureCategory: { fontSize: 12, color: '#aaa', marginTop: 2 },
  nextBox: {
    backgroundColor: '#f5f5f5',
    borderRadius: 14,
    padding: 14,
    width: '100%',
    alignItems: 'center',
    marginBottom: 20,
  },
  nextLabel: { fontSize: 14, color: '#555' },
  btnPrimary: {
    backgroundColor: '#1a1a1a',
    borderRadius: 12,
    padding: 14,
    width: '100%',
    alignItems: 'center',
    marginBottom: 10,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '600', fontSize: 15 },
  btnOutline: {
    borderWidth: 0.5,
    borderColor: '#ccc',
    borderRadius: 12,
    padding: 14,
    width: '100%',
    alignItems: 'center',
  },
  btnOutlineText: { color: '#1a1a1a', fontSize: 15 },
});
