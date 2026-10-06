-- Registration source: at sign-up a parent may indicate how they heard about
-- ITS this year (Facebook, Instagram, WhatsApp group, a friend's status, a
-- newspaper ad/report, a school flyer/notice, etc.). Multi-select; an optional
-- free-text note captures "Other". Additive + idempotent — safe on live data;
-- existing parents simply have NULL (they are not re-asked).
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_about_sources TEXT[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_about_other   TEXT;
