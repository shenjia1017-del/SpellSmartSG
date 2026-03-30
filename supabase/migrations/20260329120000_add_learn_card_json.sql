-- Learn tab: cache Claude card JSON (graphemesPronunciation, definitions, etc.) per word row.
alter table public.words add column if not exists learn_card_json jsonb;
