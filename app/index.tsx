import { Redirect } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { useChild } from './lib/childContext';
import { supabase } from '../lib/supabase';

export default function Index() {
  const { children, currentChild, loading } = useChild();
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (mounted) setHasSession(Boolean(data?.session));
    })();
    return () => {
      mounted = false;
    };
  }, []);

  if (loading || hasSession === null) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FFF8F0' }}>
        <ActivityIndicator color="#F97316" />
      </View>
    );
  }

  if (!hasSession) return <Redirect href="/login" />;
  if (children.length === 0) return <Redirect href="/settings/children" />;
  if (!currentChild) return <Redirect href="/select-child" />;
  return <Redirect href="/home" />;
}
