import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { supabase } from '../../lib/supabase';

export default function LoginScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState(null);

  useEffect(() => {
    let isActive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (isActive && data?.session) {
          router.replace('/');
        }
      } catch {
        // Ignore and allow user to manually login.
      }
    })();

    return () => {
      isActive = false;
    };
  }, [router]);

  const onLogin = async () => {
    const trimmedEmail = email.trim();
    const trimmedPassword = password;

    if (!trimmedEmail) {
      setErrorMsg('Please enter your email.');
      return;
    }

    if (!trimmedPassword) {
      setErrorMsg('Please enter your password.');
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password: trimmedPassword,
      });

      if (error) throw error;

      router.replace('/');
    } catch (e) {
      setErrorMsg(e?.message ?? 'Failed to log in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <LinearGradient
      colors={['#E3F2FD', '#F1F8FF', '#FFF8F0']}
      style={[styles.container, { paddingTop: insets.top + 12 }]}
    >
      <View style={styles.bgDecor} pointerEvents="none">
        <View style={[styles.cloud, { top: 38, left: 18, width: 80, height: 36 }]} />
        <View style={[styles.cloud, { top: 28, left: 55, width: 60, height: 28 }]} />
        <View style={styles.sun} />
      </View>
      <Text style={styles.title}>SpellSmart SG</Text>
      <Text style={styles.subtitle}>Log in to your account</Text>

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

      <TouchableOpacity style={styles.button} onPress={onLogin} disabled={loading}>
        {loading ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Log In</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={styles.linkButton} onPress={() => router.push('/register')}>
        <Text style={styles.linkText}>New here? Create an account</Text>
      </TouchableOpacity>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
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
  title: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#4A90E2',
    marginBottom: 10,
  },
  subtitle: {
    fontSize: 16,
    color: '#666',
    marginBottom: 40,
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
    backgroundColor: '#FFA726',
    width: '100%',
    paddingVertical: 14,
    borderRadius: 25,
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