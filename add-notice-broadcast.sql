-- WhatsApp broadcast + saved groups for the Notices page.
CREATE TABLE IF NOT EXISTS wa_groups (
  id         SERIAL PRIMARY KEY,
  year_id    INT REFERENCES year_config(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  created_by INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notice_sends (
  id               SERIAL PRIMARY KEY,
  year_id          INT,
  notice_id        INT REFERENCES notices(id) ON DELETE SET NULL,
  channel          TEXT NOT NULL,            -- 'whatsapp' | 'wa_group'
  audience         TEXT,
  message          TEXT,
  total_recipients INT DEFAULT 0,
  sent             INT DEFAULT 0,
  failed           INT DEFAULT 0,
  failed_numbers   JSONB,
  status           TEXT DEFAULT 'sending',   -- 'sending' | 'done'
  created_by       INT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notice_sends_year ON notice_sends(year_id, created_at DESC);
