-- Free-text list of all sponsors (names + sponsorship category) shown in the MC script.
ALTER TABLE year_config ADD COLUMN IF NOT EXISTS sponsors_text TEXT;
