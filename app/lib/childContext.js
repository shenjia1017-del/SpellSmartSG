import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { supabase } from '../../lib/supabase';

const SELECTED_CHILD_KEY = 'selectedChildId';
const MAX_CHILDREN = 5;

const ChildContext = createContext(null);

export function ChildProvider({ children: appChildren }) {
  const [children, setChildren] = useState([]);
  const [currentChild, setCurrentChildState] = useState(null);
  const [loading, setLoading] = useState(true);

  const setCurrentChild = useCallback(async (child) => {
    setCurrentChildState(child ?? null);
    if (child?.id) {
      await AsyncStorage.setItem(SELECTED_CHILD_KEY, String(child.id));
    } else {
      await AsyncStorage.removeItem(SELECTED_CHILD_KEY);
    }
  }, []);

  const refreshChildren = useCallback(async () => {
    const { data: authData } = await supabase.auth.getUser();
    const userId = authData?.user?.id;
    if (!userId) {
      setChildren([]);
      await setCurrentChild(null);
      return [];
    }

    const { data, error } = await supabase
      .from('children')
      .select('id, name, gender, created_at')
      .order('created_at', { ascending: true });
    if (error) throw error;

    const nextChildren = Array.isArray(data) ? data : [];
    setChildren(nextChildren);
    return nextChildren;
  }, [setCurrentChild]);

  const addChild = useCallback(
    async (name, gender) => {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) throw new Error('Child name is required.');
      if (children.length >= MAX_CHILDREN) throw new Error('Maximum 5 children allowed.');
      const { data: authData } = await supabase.auth.getUser();
      const user = authData?.user;
      if (!user) throw new Error('Not authenticated');

      const { error } = await supabase.from('children').insert([{
        name: trimmed,
        gender: gender === 'girl' ? 'girl' : 'boy',
        user_id: user.id,
      }]);
      if (error) throw error;

      const nextChildren = await refreshChildren();
      return nextChildren;
    },
    [children.length, refreshChildren],
  );

  const updateChild = useCallback(
    async (id, name, gender) => {
      const trimmed = String(name ?? '').trim();
      if (!id) throw new Error('Missing child id.');
      if (!trimmed) throw new Error('Child name is required.');
      const { error } = await supabase
        .from('children')
        .update({
          name: trimmed,
          gender: gender === 'girl' ? 'girl' : 'boy',
        })
        .eq('id', id);
      if (error) throw error;

      const nextChildren = await refreshChildren();
      const refreshedCurrent = nextChildren.find((c) => c.id === currentChild?.id) ?? null;
      await setCurrentChild(refreshedCurrent);
      return nextChildren;
    },
    [currentChild?.id, refreshChildren, setCurrentChild],
  );

  const deleteChild = useCallback(
    async (id) => {
      if (!id) throw new Error('Missing child id.');
      const wasCurrent = currentChild?.id === id;
      const { error } = await supabase.from('children').delete().eq('id', id);
      if (error) throw error;

      const nextChildren = await refreshChildren();
      if (wasCurrent) {
        await setCurrentChild(null);
      } else {
        const refreshedCurrent = nextChildren.find((c) => c.id === currentChild?.id) ?? null;
        await setCurrentChild(refreshedCurrent);
      }
      return nextChildren;
    },
    [currentChild?.id, refreshChildren, setCurrentChild],
  );

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const nextChildren = await refreshChildren();
        if (cancelled) return;

        const savedId = await AsyncStorage.getItem(SELECTED_CHILD_KEY);
        const matched = nextChildren.find((c) => String(c.id) === String(savedId ?? '')) ?? null;
        setCurrentChildState(matched);
      } catch {
        if (!cancelled) {
          setChildren([]);
          setCurrentChildState(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshChildren]);

  const value = useMemo(
    () => ({
      currentChild,
      children,
      loading,
      setCurrentChild,
      refreshChildren,
      addChild,
      updateChild,
      deleteChild,
    }),
    [currentChild, children, loading, setCurrentChild, refreshChildren, addChild, updateChild, deleteChild],
  );

  return <ChildContext.Provider value={value}>{appChildren}</ChildContext.Provider>;
}

export function useChild() {
  const ctx = useContext(ChildContext);
  if (!ctx) {
    throw new Error('useChild must be used inside ChildProvider.');
  }
  return ctx;
}
