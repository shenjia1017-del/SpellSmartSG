import { useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LottieView from 'lottie-react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

/**
 * One-time welcome after a child's name is set, before home.
 * @param {{ childName?: string }} props
 */
export default function WelcomeScreen({ childName = 'Friend' }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const displayName = String(childName ?? 'Friend').trim() || 'Friend';

  const [scene, setScene] = useState(1);
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const textOpacity = useRef(new Animated.Value(1)).current;
  const buttonOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(contentOpacity, {
      toValue: 1,
      duration: 400,
      useNativeDriver: true,
    }).start();
  }, [contentOpacity]);

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(textOpacity, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (!finished) return;
        setScene(2);
        Animated.timing(textOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      });
    }, 2500);
    return () => clearTimeout(timer);
  }, [textOpacity]);

  useEffect(() => {
    if (scene !== 2) return;
    buttonOpacity.setValue(0);
    const t = setTimeout(() => {
      Animated.timing(buttonOpacity, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    }, 1000);
    return () => clearTimeout(t);
  }, [scene, buttonOpacity]);

  const onLetsGo = () => {
    // App home route (see app/home.tsx); Expo group (home) is not in the URL path.
    router.replace('/home');
  };

  return (
    <SafeAreaView
      style={[styles.safe, { paddingLeft: Math.max(insets.left, 20), paddingRight: Math.max(insets.right, 20) }]}
      edges={['top', 'bottom']}
    >
      <Animated.View style={[styles.center, { opacity: contentOpacity }]}>
        <View style={styles.bubbleStack}>
          <View style={styles.bubble}>
            <Animated.View style={{ opacity: textOpacity }}>
              {scene === 1 ? (
                <Text style={styles.bubbleLine}>
                  <Text style={styles.bubbleHey}>Hey </Text>
                  <Text style={styles.bubbleName}>{displayName}</Text>
                  <Text style={styles.bubbleRest}>{"! I'm Bloom! 👋"}</Text>
                </Text>
              ) : (
                <Text style={styles.bubbleRestFull}>
                  {"Let's be spelling buddies! Together we'll nail it! 💪"}
                </Text>
              )}
            </Animated.View>
          </View>
          <View style={styles.pointerOuter}>
            <View style={styles.pointerBorder} />
            <View style={styles.pointerInner} />
          </View>
        </View>

        <LottieView
          key={scene === 1 ? 'wave' : 'cheer'}
          source={
            scene === 1
              ? require('../../assets/animations/Trilo-wave.json')
              : require('../../assets/animations/Trilo-cheer.json')
          }
          autoPlay
          loop
          style={styles.lottie}
        />

        {scene === 2 ? (
          <Animated.View style={[styles.buttonWrap, { opacity: buttonOpacity }]}>
            <Pressable style={styles.button} onPress={onLetsGo}>
              <Text style={styles.buttonText}>{"LET'S GO! →"}</Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#FFFBF5',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  bubbleStack: {
    alignItems: 'center',
    marginBottom: 8,
    maxWidth: 320,
    width: '100%',
  },
  bubble: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E0D8CC',
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    width: '100%',
  },
  bubbleLine: {
    fontSize: 17,
    lineHeight: 24,
    textAlign: 'center',
  },
  bubbleHey: {
    color: '#444444',
  },
  bubbleName: {
    color: '#CC5500',
    fontWeight: '800',
  },
  bubbleRest: {
    color: '#444444',
  },
  bubbleRestFull: {
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
    color: '#444444',
  },
  pointerOuter: {
    alignItems: 'center',
    marginTop: -1,
    height: 12,
    justifyContent: 'flex-start',
  },
  pointerBorder: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 11,
    borderRightWidth: 11,
    borderTopWidth: 13,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#E0D8CC',
  },
  pointerInner: {
    position: 'absolute',
    top: 0,
    width: 0,
    height: 0,
    marginTop: -1,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderTopWidth: 11,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#FFFFFF',
  },
  lottie: {
    width: 160,
    height: 160,
  },
  buttonWrap: {
    marginTop: 28,
    width: '100%',
    maxWidth: 320,
  },
  button: {
    backgroundColor: '#FF7B1C',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    shadowColor: '#CC5500',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.9,
    shadowRadius: 0,
    elevation: 6,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
