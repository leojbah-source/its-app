-- Free-text house rules / announcements for MCs to read out (editable per year),
-- replacing the previously hard-coded line in the MC script.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS mc_rules_text TEXT;
