SET search_path = ag_catalog, "$user", public;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

CREATE SCHEMA IF NOT EXISTS maus;

-- unaccent() is STABLE; a generated column needs an IMMUTABLE wrapper bound to one dictionary.
CREATE OR REPLACE FUNCTION maus.fold(value text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT lower(public.unaccent('public.unaccent'::regdictionary, value)) $$;

CREATE TABLE IF NOT EXISTS maus.bots (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  criteria text,
  cursor bigint NOT NULL DEFAULT 0,
  last_dream_at timestamptz,
  last_report jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS maus.episodes (
  id bigserial PRIMARY KEY,
  bot_id text NOT NULL REFERENCES maus.bots(id) ON DELETE CASCADE,
  thread_id text NOT NULL,
  turn_id text NOT NULL,
  person text NOT NULL,
  reply text NOT NULL DEFAULT '',
  room jsonb,
  owner boolean NOT NULL DEFAULT true,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, turn_id)
);
CREATE INDEX IF NOT EXISTS episodes_bot_id_idx ON maus.episodes (bot_id, id);

CREATE TABLE IF NOT EXISTS maus.facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id text NOT NULL REFERENCES maus.bots(id) ON DELETE CASCADE,
  text text NOT NULL,
  kind text NOT NULL DEFAULT 'fact' CHECK (kind IN ('preference', 'fact', 'decision', 'rule', 'event')),
  subject text,
  core boolean NOT NULL DEFAULT false,
  about_user boolean NOT NULL DEFAULT false,
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz,
  superseded_by uuid REFERENCES maus.facts(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'dream' CHECK (source IN ('dream', 'tool', 'api', 'import')),
  episode_ids bigint[] NOT NULL DEFAULT '{}',
  evidence text[] NOT NULL DEFAULT '{}',
  confidence real,
  embedding vector,
  embed_model text,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', maus.fold(coalesce(subject, '') || ' ' || text))) STORED
);
CREATE INDEX IF NOT EXISTS facts_current_idx ON maus.facts (bot_id) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS facts_search_idx ON maus.facts USING gin (search);

CREATE TABLE IF NOT EXISTS maus.entities (
  bot_id text NOT NULL REFERENCES maus.bots(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'thing',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, key)
);

CREATE TABLE IF NOT EXISTS maus.fact_entities (
  fact_id uuid NOT NULL REFERENCES maus.facts(id) ON DELETE CASCADE,
  bot_id text NOT NULL,
  entity_key text NOT NULL,
  PRIMARY KEY (fact_id, entity_key),
  FOREIGN KEY (bot_id, entity_key) REFERENCES maus.entities(bot_id, key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS fact_entities_entity_idx ON maus.fact_entities (bot_id, entity_key);

CREATE TABLE IF NOT EXISTS maus.forgotten (
  bot_id text NOT NULL REFERENCES maus.bots(id) ON DELETE CASCADE,
  words text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, words)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'maus_graph') THEN
    PERFORM ag_catalog.create_graph('maus_graph');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'maus_graph' AND l.name = 'Entity') THEN
    PERFORM ag_catalog.create_vlabel('maus_graph', 'Entity');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM ag_catalog.ag_label l JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name = 'maus_graph' AND l.name = 'REL') THEN
    PERFORM ag_catalog.create_elabel('maus_graph', 'REL');
  END IF;
END
$$;
