import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { supabase } from '../../lib/supabase';

export default function RegisterScreen({ navigation }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  const onRegister = async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password;

    if (!trimmedEmail) {
      setErrorMsg('Please enter your email.');
      return;
    }

    if (trimmedPassword.length < 6) {
      setErrorMsg('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const { error } = await supabase.auth.signUp({
        email: trimmedEmail,
        password: trimmedPassword,
      });

      if (error) throw error;

      // Supabase may require email confirmation depending on project settings.
      // After successful signUp, guide users back to login.
      navigation.navigate('Login');
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to register.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Create Account</Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        placeholder="you@example.com"
        onChangeText={setEmail}
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        placeholder="Your password"
        onChangeText={setPassword}
      />

      {errorMsg ? <Text style={styles.errorText}>{errorMsg}</Text> : null}

      <TouchableOpacity style={styles.button} onPress={onRegister} disabled={loading}>
        <Text style={styles.buttonText}>{loading ? 'Registering...' : 'Register'}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.linkButton} onPress={() => navigation.navigate('Login')}>
        <Text style={styles.linkText}>Already have an account? Log in</Text>
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
    paddingHorizontal: 20,
  },
  title: {
    fontSize: 30,
    fontWeight: 'bold',
    color: '#4A90E2',
    marginBottom: 24,
  },
  label: {
    width: '100%',
    fontSize: 14,
    color: '#333',
    marginBottom: 6,
  },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 14,
    backgroundColor: '#fff',
  },
  errorText: {
    width: '100%',
    color: '#d00',
    marginBottom: 14,
  },
  button: {
    width: '100%',
    backgroundColor: '#4A90E2',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 14,
  },
  buttonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  linkButton: {
    paddingVertical: 8,
  },
  linkText: {
    color: '#4A90E2',
    fontSize: 14,
    fontWeight: '600',
  },
});

