import { supabase } from '../../lib/supabase';
import { getFlowerForWeek, getCreatureIndexForFlowerCount, CREATURES } from '../constants/gardenData';

export async function updateWordMastery(userId, wordId, weekLabel, isCorrect) {
  const { data: existing } = await supabase
    .from('word_mastery')
    .select('*')
    .eq('user_id', userId)
    .eq('word_id', wordId)
    .maybeSingle();

  const correct_count = (existing?.correct_count || 0) + (isCorrect ? 1 : 0);
  const attempt_count = (existing?.attempt_count || 0) + 1;

  let status;
  if (isCorrect) {
    status = 'bloom';
  } else if (attempt_count === 1) {
    status = 'wilt';
  } else {
    status = existing?.status === 'bloom' ? 'wilt' : (existing?.status || 'wilt');
  }

  await supabase.from('word_mastery').upsert({
    user_id: userId,
    word_id: wordId,
    week_label: weekLabel,
    status,
    correct_count,
    attempt_count,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,word_id' });
}

export async function completeWeek(userId, weekLabel) {
  const { data: existing } = await supabase
    .from('flower_collection')
    .select('id')
    .eq('user_id', userId)
    .eq('week_label', weekLabel)
    .maybeSingle();

  if (existing) return null;

  const { count } = await supabase
    .from('flower_collection')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId);

  const totalFlowers = count || 0;
  const flower = getFlowerForWeek(totalFlowers);

  await supabase.from('flower_collection').insert({
    user_id: userId,
    week_label: weekLabel,
    flower_emoji: flower.emoji,
    flower_name: flower.name,
  });

  const newFlowerCount = totalFlowers + 1;

  let newCreature = null;
  const creatureIndex = getCreatureIndexForFlowerCount(newFlowerCount);
  if (creatureIndex !== null) {
    const isGold = creatureIndex >= CREATURES.length;
    const realIndex = creatureIndex % CREATURES.length;
    const creature = CREATURES[realIndex];
    await supabase.from('creature_collection').insert({
      user_id: userId,
      creature_emoji: isGold ? '⭐' + creature.emoji : creature.emoji,
      creature_name: isGold ? 'Golden ' + creature.name : creature.name,
      category: creature.category,
      week_unlocked: Math.floor(newFlowerCount / 4),
    });
    newCreature = { ...creature, isGold };
  }

  return { flower, newCreature, totalFlowers: newFlowerCount };
}

export async function getWeekMastery(userId, weekLabel) {
  const { data } = await supabase
    .from('word_mastery')
    .select('*')
    .eq('user_id', userId)
    .eq('week_label', weekLabel);
  return data || [];
}

export async function getCollection(userId) {
  const [flowersRes, creaturesRes] = await Promise.all([
    supabase
      .from('flower_collection')
      .select('*')
      .eq('user_id', userId)
      .order('collected_at'),
    supabase
      .from('creature_collection')
      .select('*')
      .eq('user_id', userId)
      .order('unlocked_at'),
  ]);
  return {
    flowers: flowersRes.data || [],
    creatures: creaturesRes.data || [],
  };
}

export default { updateWordMastery, completeWeek, getWeekMastery, getCollection };
