-- Migration 062 — shareable key for the public judge-invitation tool.
-- A random per-year secret baked into the link (/invite/judges?k=...) so the
-- 2-3 people finalising judges can use the invitation generator without a
-- login, while the page still isn't wide-open to the whole internet.
-- Idempotent: adds the column, fills a random key only where missing.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS invite_tool_key TEXT;

UPDATE year_config
   SET invite_tool_key = md5(random()::text || clock_timestamp()::text || id::text)
 WHERE invite_tool_key IS NULL OR btrim(invite_tool_key) = '';
