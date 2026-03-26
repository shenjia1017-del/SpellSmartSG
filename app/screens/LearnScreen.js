import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export default function LearnScreen({ navigation }) {
  return (
    <View style={styles.container}>
      <Text style={styles.word}>ENORMOUS</Text>
      <Text style={styles.phonics}>e • NOR • mous</Text>
      <Text style={styles.definition}>Very large in size or amount</Text>
      <Text style={styles.example}>"The elephant was enormous."</Text>

      <TouchableOpacity style={styles.button}>
        <Text style={styles.buttonText}>🔊 Play Sound</Text>
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
    padding: 20,
  },
  word: {
    fontSize: 40,
    fontWeight: 'bold',
    color: '#4A90E2',
    marginBottom: 10,
  },
  phonics: {
    fontSize: 20,
    color: '#7ED321',
    marginBottom: 20,
  },
  definition: {
    fontSize: 18,
    color: '#333',
    textAlign: 'center',
    marginBottom: 10,
  },
  example: {
    fontSize: 16,
    color: '#666',
    fontStyle: 'italic',
    textAlign: 'center',
    marginBottom: 40,
  },
  button: {
    backgroundColor: '#4A90E2',
    paddingHorizontal: 40,
    paddingVertical: 15,
    borderRadius: 25,
    marginBottom: 15,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  backButton: {
    marginTop: 10,
  },
  backText: {
    color: '#4A90E2',
    fontSize: 16,
  },
});