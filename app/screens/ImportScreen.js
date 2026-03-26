import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function ImportScreen({ navigation }) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Import Word List</Text>

      <TouchableOpacity style={styles.button}>
        <Text style={styles.buttonText}>📷 Take a Photo</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.button, styles.secondButton]}>
        <Text style={styles.buttonText}>✏️ Type Manually</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.backButton}
        onPress={() => navigation.goBack()}
      >
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#fff',
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
  backButton: {
    marginTop: 20,
  },
  backText: {
    color: '#4A90E2',
    fontSize: 16,
  },
});