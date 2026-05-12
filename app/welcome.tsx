import { useLocalSearchParams } from 'expo-router';
import WelcomeScreen from './screens/WelcomeScreen';

export default function Welcome() {
  const { childName } = useLocalSearchParams();
  return <WelcomeScreen childName={String(childName || 'Friend')} />;
}
