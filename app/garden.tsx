import { useLocalSearchParams } from 'expo-router';
import GardenScreen from './screens/GardenScreen';

export default function GardenPage() {
  const p = useLocalSearchParams();
  const raw = p.weekLabel;
  const weekLabel = raw == null ? '' : Array.isArray(raw) ? String(raw[0] ?? '') : String(raw);
  return <GardenScreen weekLabel={weekLabel} />;
}
