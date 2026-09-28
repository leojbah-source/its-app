-- Post-registration consolidation of the entry lists (merge / cancel / split),
-- run per event + age-group after the Initial list is published. Every action is
-- recorded here with the exact registrations it moved, so it can be reverted.

-- Mark system-created events (a "(Common)" merge target or a split child) and
-- carry a human note of where they came from.
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_generated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE events ADD COLUMN IF NOT EXISTS origin_note TEXT;

-- Final list publication flag (mirrors initial_list_published).
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS final_list_published BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS final_list_published_at TIMESTAMPTZ;

-- One row per consolidation action.
--   kind: 'merge' | 'cancel' | 'split'
--   source_event_ids: events the action acted on
--   target_event_ids: events created/kept as the destination (none for cancel)
--   age_group_id: the age-group cell the action applied to
--   moved: JSONB array of { reg_id, from_event_id, to_event_id } for exact revert
--   reverted_at / reverted_by: set when the action is undone
CREATE TABLE IF NOT EXISTS event_consolidations (
  id                SERIAL PRIMARY KEY,
  year_id           INTEGER NOT NULL REFERENCES year_config(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('merge','cancel','split')),
  source_event_ids  INTEGER[] NOT NULL DEFAULT '{}',
  target_event_ids  INTEGER[] NOT NULL DEFAULT '{}',
  age_group_id      INTEGER REFERENCES age_groups(id),
  moved             JSONB NOT NULL DEFAULT '[]',
  note              TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reverted_at       TIMESTAMPTZ,
  reverted_by       INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_event_consolidations_year ON event_consolidations (year_id, reverted_at);
CREATE INDEX IF NOT EXISTS idx_event_consolidations_ag ON event_consolidations (age_group_id);
