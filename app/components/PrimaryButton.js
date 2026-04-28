import React, { useRef } from 'react';
import { 
  TouchableWithoutFeedback, 
  View, 
  Text, 
  Animated, 
  Platform 
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Colors, Radius, Spacing, FontSize } from '../lib/theme';

/**
 * PrimaryButton - Duolingo-style 3D button
 * 
 * Props:
 * - title: string (button text, will be UPPERCASED)
 * - onPress: function
 * - variant: 'primary' | 'secondary' | 'success' | 'danger' (default 'primary')
 * - disabled: boolean
 * - fullWidth: boolean (default true)
 * - style: extra container styles
 */
export default function PrimaryButton({ 
  title, 
  onPress, 
  variant = 'primary', 
  disabled = false,
  fullWidth = true,
  style,
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  
  // Pick colors based on variant
  const variantColors = {
    primary: { bg: Colors.primary, shadow: Colors.primaryDark, text: '#fff' },
    secondary: { bg: Colors.secondary, shadow: Colors.secondaryDark, text: '#fff' },
    success: { bg: Colors.success, shadow: Colors.successDark, text: '#fff' },
    danger: { bg: Colors.danger, shadow: Colors.dangerDark, text: '#fff' },
  };
  
  const colors = variantColors[variant] || variantColors.primary;
  
  const handlePressIn = () => {
    if (disabled) return;
    if (Platform.OS === 'ios') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    Animated.timing(translateY, {
      toValue: 5,
      duration: 80,
      useNativeDriver: true,
    }).start();
  };
  
  const handlePressOut = () => {
    if (disabled) return;
    Animated.timing(translateY, {
      toValue: 0,
      duration: 80,
      useNativeDriver: true,
    }).start();
  };
  
  return (
    <TouchableWithoutFeedback
      onPress={disabled ? undefined : onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
    >
      <View style={[
        { 
          width: fullWidth ? '100%' : undefined,
          marginVertical: Spacing.xs,
        },
        style,
      ]}>
        {/* Shadow layer (bottom) */}
        <View style={{
          position: 'absolute',
          top: 5,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: disabled ? '#BDBDBD' : colors.shadow,
          borderRadius: Radius.button,
        }} />
        
        {/* Button layer (top, animated) */}
        <Animated.View style={{
          backgroundColor: disabled ? '#E0E0E0' : colors.bg,
          borderRadius: Radius.button,
          paddingVertical: 14,
          paddingHorizontal: Spacing.lg,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{ translateY }],
        }}>
          <Text style={{
            color: disabled ? '#9E9E9E' : colors.text,
            fontSize: FontSize.medium,
            fontWeight: '700',
            letterSpacing: 0.8,
            textTransform: 'uppercase',
          }}>
            {title}
          </Text>
        </Animated.View>
      </View>
    </TouchableWithoutFeedback>
  );
}
