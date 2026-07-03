-- =============================================================================
-- ITS 2025 SEED SCRIPT
-- Kerala Catholic Association — Indian Talent Scan 2025
-- Events · Categories · Age Groups · Judging Criteria
-- =============================================================================
-- Prerequisites:
--   • year_config must have exactly one row with is_active = TRUE
--   • Run ONCE on a clean year (all INSERTs use ON CONFLICT DO NOTHING)
--
-- Tables touched:
--   categories, age_groups, events, event_age_groups, event_criteria
--
-- Fee structure (Rule 22, for reference in the portal):
--   Individual non-dance  : BD 2 (KCA member) / BD 3 (non-member)
--   Individual dance      : BD 3 (KCA member) / BD 4 (non-member)
--   Team events           : BD 5 (all KCA members) / BD 10 (otherwise)
--   At time of payment everyone pays non-member rate; member discount
--   credited back to KCA membership account.
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1: CATEGORIES
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO categories (year_id, code, name, sort_order)
SELECT y.id, t.code, t.name, t.ord
FROM year_config y
CROSS JOIN (VALUES
  ('NATYA',   'Natya Ratna (Dance Events)',      1),
  ('SANGEET', 'Sangeet Ratna (Song Events)',     2),
  ('KALA',    'Kala Ratna (Arts & Crafts)',      3),
  ('SAHITYA', 'Sahitya Ratna (Literary Events)', 4),
  ('ADDON',   'Add-On Events',                   5),
  ('TEAM',    'Team Events',                     6)
) AS t(code, name, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2: AGE GROUPS  (DOB ranges per Rule 1.1)
-- ─────────────────────────────────────────────────────────────────────────────
-- Group 1 : born 01-Oct-2018 → 30-Sep-2020  (approx. 5-6 yrs)
-- Group 2 : born 01-Oct-2016 → 30-Sep-2018  (approx. 7-8 yrs)
-- Group 3 : born 01-Oct-2014 → 30-Sep-2016  (approx. 9-10 yrs)
-- Group 4 : born 01-Oct-2011 → 30-Sep-2014  (approx. 11-13 yrs)
-- Group 5 : born 01-Oct-2007 → 30-Sep-2011  (approx. 14-17 yrs)

INSERT INTO age_groups (year_id, code, label, dob_from, dob_to, sort_order)
SELECT y.id, t.code, t.label, t.df::date, t.dt::date, t.ord
FROM year_config y
CROSS JOIN (VALUES
  ('G1', 'Group 1 (Age 5-6, born Oct 2018 – Sep 2020)', '2018-10-01', '2020-09-30', 1),
  ('G2', 'Group 2 (Age 7-8, born Oct 2016 – Sep 2018)', '2016-10-01', '2018-09-30', 2),
  ('G3', 'Group 3 (Age 9-10, born Oct 2014 – Sep 2016)', '2014-10-01', '2016-09-30', 3),
  ('G4', 'Group 4 (Age 11-13, born Oct 2011 – Sep 2014)', '2011-10-01', '2014-09-30', 4),
  ('G5', 'Group 5 (Age 14-17, born Oct 2007 – Sep 2011)', '2007-10-01', '2011-09-30', 5)
) AS t(code, label, df, dt, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3A: EVENTS — NATYA RATNA (Dance)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO events (year_id, category_id, event_code, event_name, event_kind, is_stage_event, sort_order)
SELECT y.id, c.id, t.code, t.name, 'individual', TRUE, t.ord
FROM year_config y
JOIN categories c ON c.year_id = y.id AND c.code = 'NATYA'
CROSS JOIN (VALUES
  ('D01', 'Bharathanatyam', 1),
  ('D02', 'Cinematic Dance', 2),
  ('D03', 'Folk Dance', 3),
  ('D04', 'Kathak Dance', 4),
  ('D05', 'Kuchipudi', 5),
  ('D06', 'Mohiniyattam', 6),
  ('D07', 'Western Dance', 7)
) AS t(code, name, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, event_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3B: EVENTS — SANGEET RATNA (Song)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO events (year_id, category_id, event_code, event_name, event_kind, is_stage_event, sort_order)
SELECT y.id, c.id, t.code, t.name, 'individual', TRUE, t.ord
FROM year_config y
JOIN categories c ON c.year_id = y.id AND c.code = 'SANGEET'
CROSS JOIN (VALUES
  ('S01',  'Carnatic Music (Vocal) – Boys',             1),
  ('S02',  'Carnatic Music (Vocal) – Girls',            2),
  ('S03',  'Christian Devotional Song (Mal.) – Boys',   3),
  ('S04',  'Christian Devotional Song (Mal.) – Common', 4),
  ('S05',  'Christian Devotional Song (Mal.) – Girls',  5),
  ('S06',  'English Song – Boys',                       6),
  ('S07',  'English Song – Girls',                      7),
  ('S08',  'Film Song (Hindi) – Boys',                  8),
  ('S09',  'Film Song (Hindi) – Common',                9),
  ('S10',  'Film Song (Hindi) – Girls',                 10),
  ('S11',  'Film Song (Malayalam) – Boys',              11),
  ('S12',  'Film Song (Malayalam) – Common',            12),
  ('S13',  'Film Song (Malayalam) – Girls',             13),
  ('S14',  'Hindustani Music – Boys',                   14),
  ('S15',  'Hindustani Music – Girls',                  15),
  ('S16',  'Instrumental Music',                        16),
  ('S17',  'Karaoke Singing (Hindi) – Boys',            17),
  ('S18',  'Karaoke Singing (Hindi) – Girls',           18),
  ('S19',  'Light Music (Malayalam) – Boys',            19),
  ('S20',  'Light Music (Malayalam) – Girls',           20),
  ('S21',  'Nadanpattu (Malayalam) – Common',           21)
) AS t(code, name, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, event_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3C: EVENTS — KALA RATNA (Arts & Crafts)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO events (year_id, category_id, event_code, event_name, event_kind, is_stage_event, sort_order)
SELECT y.id, c.id, t.code, t.name, 'individual', FALSE, t.ord
FROM year_config y
JOIN categories c ON c.year_id = y.id AND c.code = 'KALA'
CROSS JOIN (VALUES
  ('K01', 'Cartoon Drawing',     1),
  ('K02', 'Clay Modeling',       2),
  ('K03', 'Drawing & Painting',  3),
  ('K04', 'Flower Arrangement',  4),
  ('K05', 'Pencil Drawing',      5),
  ('K06', 'Vegetable Carving',   6)
) AS t(code, name, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, event_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3D: EVENTS — SAHITYA RATNA (Literary)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO events (year_id, category_id, event_code, event_name, event_kind, is_stage_event, sort_order)
SELECT y.id, c.id, t.code, t.name, 'individual', t.stage, t.ord
FROM year_config y
JOIN categories c ON c.year_id = y.id AND c.code = 'SAHITYA'
CROSS JOIN (VALUES
  ('L01', 'Caption Writing – English',        FALSE, 1),
  ('L02', 'Essay Writing – English',          FALSE, 2),
  ('L03', 'Poem Recitation – English',        TRUE,  3),
  ('L04', 'Poem Recitation – Hindi',          TRUE,  4),
  ('L05', 'Poem Recitation – Malayalam',      TRUE,  5),
  ('L06', 'Poem Writing – English',           FALSE, 6),
  ('L07', 'Speech – English',                 TRUE,  7),
  ('L08', 'Speech – Malayalam',               TRUE,  8),
  ('L09', 'Story Telling – English',          TRUE,  9),
  ('L10', 'Story Telling – Malayalam',        TRUE,  10)
) AS t(code, name, stage, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, event_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3E: EVENTS — ADD-ON EVENTS
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO events (year_id, category_id, event_code, event_name, event_kind, is_stage_event, sort_order)
SELECT y.id, c.id, t.code, t.name, 'individual', t.stage, t.ord
FROM year_config y
JOIN categories c ON c.year_id = y.id AND c.code = 'ADDON'
CROSS JOIN (VALUES
  ('X01', 'Action Song',          TRUE,  1),
  ('X02', 'Fancy Dress',          TRUE,  2),
  ('X03', 'Fashion Show',         TRUE,  3),
  ('X04', 'General Knowledge',    FALSE, 4),
  ('X05', 'Handwriting',          FALSE, 5),
  ('X06', 'Intelligence Test',    FALSE, 6),
  ('X07', 'Memory Test (Oral)',   TRUE,  7),
  ('X08', 'Mono Act',             TRUE,  8),
  ('X09', 'Spelling Bee',         TRUE,  9)
) AS t(code, name, stage, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, event_code) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3F: EVENTS — TEAM EVENTS
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO events (year_id, category_id, event_code, event_name, event_kind, is_stage_event, sort_order)
SELECT y.id, c.id, t.code, t.name, 'team', TRUE, t.ord
FROM year_config y
JOIN categories c ON c.year_id = y.id AND c.code = 'TEAM'
CROSS JOIN (VALUES
  ('T01', 'Cinematic Dance – Juniors (Groups 1 & 2)',    1),
  ('T02', 'Cinematic Dance – Seniors (Groups 3-5)',      2),
  ('T03', 'Folk Dance – Juniors (Groups 1 & 2)',         3),
  ('T04', 'Folk Dance – Seniors (Groups 3-5)',           4),
  ('T05', 'Western Dance – Juniors (Groups 1 & 2)',      5),
  ('T06', 'Western Dance – Seniors (Groups 3-5)',        6),
  ('T07', 'Arabic Dance (Groups 3-5)',                   7),
  ('T08', 'Group Song (Hindi/Mal.) – Juniors',           8),
  ('T09', 'Group Song (Hindi/Mal.) – Seniors',          9),
  ('T10', 'Patriotic Song – Hindi – Juniors',            10),
  ('T11', 'Patriotic Song – Hindi – Seniors',           11),
  ('T12', 'Nadanpattu (Malayalam) – Seniors',           12),
  ('T13', 'Mime',                                        13),
  ('T14', 'Tableau',                                     14)
) AS t(code, name, ord)
WHERE y.is_active = TRUE
ON CONFLICT (year_id, event_code) DO NOTHING;

-- =============================================================================
-- SECTION 4: EVENT ↔ AGE GROUP MAPPINGS
-- =============================================================================

-- ── G3, G4, G5 — Classical dance + carnatic + hindustani + instrumental ──────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN (
  'D01','D04','D05','D06',           -- Bharathanatyam, Kathak, Kuchipudi, Mohiniyattam
  'S01','S02','S14','S15','S16',     -- Carnatic Boys/Girls, Hindustani Boys/Girls, Instrumental
  'S21',                             -- Nadanpattu Common
  'K01','K04',                       -- Cartoon Drawing, Flower Arrangement
  'L01','L02','L06','L07','L08',     -- Caption/Essay/Poem Writing/Speech
  'X08'                              -- Mono Act
)
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G3','G4','G5')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── G1, G2, G3, G4, G5 — All groups ─────────────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN (
  'D02','D03','D07',                 -- Cinematic, Folk, Western Dance
  'K02','K03',                       -- Clay Modeling, Drawing & Painting
  'L03','L04','L05',                 -- Poem Recitation (Eng/Hindi/Mal)
  'X02','X03','X04','X06','X09'      -- Fancy Dress, Fashion Show, GK, Intelligence, Spelling Bee
)
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G1','G2','G3','G4','G5')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── G2, G3, G4, G5 — Song events with Boys/Girls split ──────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN (
  'S03','S05',                       -- Christian Devotional Boys/Girls
  'S06','S07',                       -- English Song Boys/Girls
  'S08','S10',                       -- Film Song Hindi Boys/Girls
  'S11','S13',                       -- Film Song Malayalam Boys/Girls
  'S17','S18',                       -- Karaoke Hindi Boys/Girls
  'S19','S20',                       -- Light Music Mal Boys/Girls
  'K05',                             -- Pencil Drawing
  'X05'                              -- Handwriting
)
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G2','G3','G4','G5')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── G1 only — Common/youngest group events ───────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN (
  'S04','S09','S12'                  -- Christian Devotional/Film Song Hindi/Mal Common
)
JOIN age_groups ag ON ag.year_id = y.id AND ag.code = 'G1'
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── G1, G2 — Juniors only ────────────────────────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN (
  'L09','L10',                       -- Story Telling Eng/Mal
  'X01','X07'                        -- Action Song, Memory Test
)
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G1','G2')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── G4, G5 only ──────────────────────────────────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code = 'K06'   -- Vegetable Carving
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G4','G5')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Team: Juniors (G1, G2) ────────────────────────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN ('T01','T03','T05','T08','T10')
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G1','G2')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Team: Seniors (G3, G4, G5) ────────────────────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code IN ('T02','T04','T06','T07','T09','T11','T12','T13')
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G3','G4','G5')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- ── Team: All groups (Tableau) ────────────────────────────────────────────────
INSERT INTO event_age_groups (event_id, age_group_id)
SELECT e.id, ag.id
FROM year_config y
JOIN events e    ON e.year_id = y.id AND e.event_code = 'T14'
JOIN age_groups ag ON ag.year_id = y.id AND ag.code IN ('G1','G2','G3','G4','G5')
WHERE y.is_active = TRUE
ON CONFLICT DO NOTHING;

-- =============================================================================
-- SECTION 5: JUDGING CRITERIA
-- NOTE: max_score values MUST sum to exactly 100 per event
--       (enforced by trg_event_criteria_check)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 5A: NATYA RATNA criteria
-- ─────────────────────────────────────────────────────────────────────────────

-- Classical Indian Dance: Bharathanatyam (D01), Kuchipudi (D05), Mohiniyattam (D06)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('D01','D05','D06')
CROSS JOIN (VALUES
  ('Angasudhi & Interpretation', 17::numeric, 1),
  ('Costume',                    17::numeric, 2),
  ('Expression',                 17::numeric, 3),
  ('Mudra',                      17::numeric, 4),
  ('Thalam',                     16::numeric, 5),
  ('Steps / Advavu',             16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Cinematic Dance individual (D02)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'D02'
CROSS JOIN (VALUES
  ('Rhythm & Steps',          20::numeric, 1),
  ('Expression',              20::numeric, 2),
  ('Choreography',            20::numeric, 3),
  ('Appearance & Costume',    20::numeric, 4),
  ('Overall performance',     20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Folk Dance individual (D03)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'D03'
CROSS JOIN (VALUES
  ('Appropriate Costume',     20::numeric, 1),
  ('Rhythm',                  20::numeric, 2),
  ('Expression',              20::numeric, 3),
  ('Steps & Body Language',   20::numeric, 4),
  ('Overall performance',     20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Kathak Dance (D04)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'D04'
CROSS JOIN (VALUES
  ('Abhinaya / Bhav',             17::numeric, 1),
  ('TaalPaksha',                  17::numeric, 2),
  ('Hand movement',               17::numeric, 3),
  ('Grace',                       17::numeric, 4),
  ('Space usage & confidence',    16::numeric, 5),
  ('Overall performance',         16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Western Dance individual (D07)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'D07'
CROSS JOIN (VALUES
  ('Music',                              20::numeric, 1),
  ('Rhythm',                             20::numeric, 2),
  ('Choreography',                       20::numeric, 3),
  ('Costume (Appropriateness & Decency)',20::numeric, 4),
  ('Overall performance',                20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5B: SANGEET RATNA criteria
-- ─────────────────────────────────────────────────────────────────────────────

-- Carnatic Music: Boys (S01), Girls (S02)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('S01','S02')
CROSS JOIN (VALUES
  ('Sruthi',                        20::numeric, 1),
  ('Layam & Ragabhavam',            20::numeric, 2),
  ('Thalam',                        20::numeric, 3),
  ('Manodharmam & Involvement',     20::numeric, 4),
  ('Sahityashudhi',                 20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Christian Devotional (S03, S04, S05), Film Song Hindi (S08, S09, S10),
-- Film Song Malayalam (S11, S12, S13), Karaoke Hindi (S17, S18)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN (
  'S03','S04','S05','S08','S09','S10','S11','S12','S13','S17','S18'
)
CROSS JOIN (VALUES
  ('Sruthilayam',            20::numeric, 1),
  ('Thalam',                 20::numeric, 2),
  ('Clarity & Memorization', 20::numeric, 3),
  ('Sahithyasudhi',          20::numeric, 4),
  ('Overall performance',    20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- English Song: Boys (S06), Girls (S07)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('S06','S07')
CROSS JOIN (VALUES
  ('Sruthilayam / Pitch & Melody',        17::numeric, 1),
  ('Thalam / Rhythm & Timing',            17::numeric, 2),
  ('Pronunciation & Diction',             17::numeric, 3),
  ('Expression & Feel',                   17::numeric, 4),
  ('Voice Quality & Control',             16::numeric, 5),
  ('Overall Performance & Stage Presence',16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Hindustani Music: Boys (S14), Girls (S15)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('S14','S15')
CROSS JOIN (VALUES
  ('Aaroha',                   20::numeric, 1),
  ('Avaroha',                  20::numeric, 2),
  ('Chota Khayal',             20::numeric, 3),
  ('Aalap & Taan',             20::numeric, 4),
  ('Bol Aalap & Bol Taan',     20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Instrumental Music (S16)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'S16'
CROSS JOIN (VALUES
  ('Thalam / Timing / Naadam (Tone clarity)',   17::numeric, 1),
  ('Sruthy',                                    17::numeric, 2),
  ('Layam / Melody',                            17::numeric, 3),
  ('Tempo, Improvisation & Stage Presence',     17::numeric, 4),
  ('Fingering / Left & Right hand usage',       16::numeric, 5),
  ('Overall performance',                       16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Light Music Malayalam: Boys (S19), Girls (S20)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('S19','S20')
CROSS JOIN (VALUES
  ('Shruthilayam',            20::numeric, 1),
  ('Bhavam & Memorisation',   20::numeric, 2),
  ('Sahithyasudhi',           20::numeric, 3),
  ('Thalam',                  20::numeric, 4),
  ('Overall Performance',     20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Nadanpattu (Malayalam) – Common (S21)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'S21'
CROSS JOIN (VALUES
  ('Shruthilayam',               17::numeric, 1),
  ('Bhavam & Memorisation',      17::numeric, 2),
  ('Sahithyasudhi',              17::numeric, 3),
  ('Thalam',                     17::numeric, 4),
  ('Originality / Nadan Thanima',16::numeric, 5),
  ('Overall presentation',       16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5C: KALA RATNA criteria
-- ─────────────────────────────────────────────────────────────────────────────

-- Cartoon Drawing (K01)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'K01'
CROSS JOIN (VALUES
  ('Imagination',         17::numeric, 1),
  ('Quality of work',     17::numeric, 2),
  ('Neatness & Finishing',17::numeric, 3),
  ('Clarity',             17::numeric, 4),
  ('Message Expression',  16::numeric, 5),
  ('Humor sense',         16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Clay Modeling (K02)
-- 4 criteria → 25×4 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'K02'
CROSS JOIN (VALUES
  ('Theme',       25::numeric, 1),
  ('Novelty',     25::numeric, 2),
  ('Creativity',  25::numeric, 3),
  ('Finishing',   25::numeric, 4)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Drawing & Painting (K03)
-- 4 criteria → 25×4 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'K03'
CROSS JOIN (VALUES
  ('Imagination',          25::numeric, 1),
  ('Quality of work',      25::numeric, 2),
  ('Neatness & Finishing', 25::numeric, 3),
  ('Colour combination',   25::numeric, 4)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Flower Arrangement (K04)
-- 4 criteria → 25×4 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'K04'
CROSS JOIN (VALUES
  ('Creativity',                    25::numeric, 1),
  ('Composition & use of colour',   25::numeric, 2),
  ('Floral design techniques',      25::numeric, 3),
  ('Balance & Overall presentation',25::numeric, 4)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Pencil Drawing (K05)
-- 4 criteria → 25×4 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'K05'
CROSS JOIN (VALUES
  ('Imagination',          25::numeric, 1),
  ('Quality of work',      25::numeric, 2),
  ('Neatness & Finishing', 25::numeric, 3),
  ('Clarity',              25::numeric, 4)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Vegetable Carving (K06)
-- 4 criteria → 25×4 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'K06'
CROSS JOIN (VALUES
  ('Idea',                       25::numeric, 1),
  ('Neatness & Finishing',       25::numeric, 2),
  ('Creativity & Imagination',   25::numeric, 3),
  ('Overall Presentation',       25::numeric, 4)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5D: SAHITYA RATNA criteria
-- ─────────────────────────────────────────────────────────────────────────────

-- Caption Writing – English (L01)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'L01'
CROSS JOIN (VALUES
  ('Creativity',      17::numeric, 1),
  ('Language',        17::numeric, 2),
  ('Structure',       17::numeric, 3),
  ('Theme',           17::numeric, 4),
  ('Expressions',     16::numeric, 5),
  ('Attractiveness',  16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Essay Writing – English (L02)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'L02'
CROSS JOIN (VALUES
  ('Introduction',            20::numeric, 1),
  ('Structure & Organization',20::numeric, 2),
  ('Content',                 20::numeric, 3),
  ('Language',                20::numeric, 4),
  ('Conclusion',              20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Poem Recitation: English (L03), Hindi (L04), Malayalam (L05)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('L03','L04','L05')
CROSS JOIN (VALUES
  ('Clarity',                         20::numeric, 1),
  ('Memorization',                    20::numeric, 2),
  ('Appropriateness of body language',20::numeric, 3),
  ('Bhavam / Involvement',            20::numeric, 4),
  ('Overall performance',             20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Poem Writing – English (L06)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'L06'
CROSS JOIN (VALUES
  ('Introduction', 20::numeric, 1),
  ('Imagination',  20::numeric, 2),
  ('Content',      20::numeric, 3),
  ('Language',     20::numeric, 4),
  ('Conclusion',   20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Speech: English (L07), Malayalam (L08)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('L07','L08')
CROSS JOIN (VALUES
  ('Introduction',                                 17::numeric, 1),
  ('Structure & Organization',                     17::numeric, 2),
  ('Language (Grammar, Pronunciation, Vocabulary)',17::numeric, 3),
  ('Voice modulation',                             17::numeric, 4),
  ('Body language',                                16::numeric, 5),
  ('Overall performance',                          16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Story Telling: English (L09), Malayalam (L10)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('L09','L10')
CROSS JOIN (VALUES
  ('Clarity',                         17::numeric, 1),
  ('Memorization',                    17::numeric, 2),
  ('Appropriateness of body language',17::numeric, 3),
  ('Voice modulation',                17::numeric, 4),
  ('Conclusion',                      16::numeric, 5),
  ('Overall performance',             16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5E: ADD-ON EVENTS criteria
-- ─────────────────────────────────────────────────────────────────────────────

-- Action Song (X01)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'X01'
CROSS JOIN (VALUES
  ('Language Proficiency',                      20::numeric, 1),
  ('Delivery & Presentation',                   20::numeric, 2),
  ('Theme',                                     20::numeric, 3),
  ('Overall Performance',                       20::numeric, 4),
  ('Costumes & Props (suitability & creativity)',20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Fancy Dress (X02)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'X02'
CROSS JOIN (VALUES
  ('Make-up',             20::numeric, 1),
  ('Costume',             20::numeric, 2),
  ('Theme',               20::numeric, 3),
  ('Novelty',             20::numeric, 4),
  ('Overall performance', 20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Fashion Show (X03)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'X03'
CROSS JOIN (VALUES
  ('Costume & Accessories',                 20::numeric, 1),
  ('Walking Style & Confidence',            20::numeric, 2),
  ('Suitability of Costume as per theme',   20::numeric, 3),
  ('Modeling, Posture & Balance',           20::numeric, 4),
  ('Overall performance',                   20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Objective tests: General Knowledge (X04), Intelligence Test (X06),
--                  Memory Test (X07), Spelling Bee (X09)
-- 1 criterion → 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, 'Total Score', 100::numeric, 1
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('X04','X06','X07','X09')
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Handwriting (X05)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'X05'
CROSS JOIN (VALUES
  ('Letter formation',                    20::numeric, 1),
  ('Neatness & legibility',               20::numeric, 2),
  ('Spelling & punctuation',              20::numeric, 3),
  ('Spacing & alignment',                 20::numeric, 4),
  ('Uniformity of slope / size of letters',20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Mono Act (X08)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'X08'
CROSS JOIN (VALUES
  ('Acting Skill',                20::numeric, 1),
  ('Novelty / Theme / Relevance', 20::numeric, 2),
  ('Characterization',            20::numeric, 3),
  ('Voice modulation',            20::numeric, 4),
  ('Overall Performance',         20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5F: TEAM EVENTS criteria
-- ─────────────────────────────────────────────────────────────────────────────

-- Team Cinematic Dance: Juniors (T01), Seniors (T02)
-- Team Western Dance:   Juniors (T05), Seniors (T06)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('T01','T02','T05','T06')
CROSS JOIN (VALUES
  ('Rhythm & Steps',                  17::numeric, 1),
  ('Choreography',                    17::numeric, 2),
  ('Expression',                      17::numeric, 3),
  ('Costume (Appropriateness)',        17::numeric, 4),
  ('Synchronization',                 16::numeric, 5),
  ('Formation & Overall performance', 16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Team Folk Dance: Juniors (T03), Seniors (T04)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('T03','T04')
CROSS JOIN (VALUES
  ('Appropriate Costume',             20::numeric, 1),
  ('Rhythm & Synchronization',        20::numeric, 2),
  ('Expression',                      20::numeric, 3),
  ('Steps & Body Language',           20::numeric, 4),
  ('Formation & Overall performance', 20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Arabic Dance (T07)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'T07'
CROSS JOIN (VALUES
  ('Rhythm & Steps',                  17::numeric, 1),
  ('Choreography',                    17::numeric, 2),
  ('Expression',                      17::numeric, 3),
  ('Costume & Make-up',               17::numeric, 4),
  ('Synchronization',                 16::numeric, 5),
  ('Formation & Overall performance', 16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Group Song (T08, T09) and Patriotic Song (T10, T11)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code IN ('T08','T09','T10','T11')
CROSS JOIN (VALUES
  ('Song Selection',              17::numeric, 1),
  ('Sahityasudhi',                17::numeric, 2),
  ('Thalam',                      17::numeric, 3),
  ('Involvement',                 17::numeric, 4),
  ('Synchronization of the team', 16::numeric, 5),
  ('Sruthilayam',                 16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Nadanpattu (Malayalam) – Seniors Team (T12)
-- 6 criteria → 17+17+17+17+16+16 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'T12'
CROSS JOIN (VALUES
  ('Shruthilayam',                        17::numeric, 1),
  ('Bhavam & Memorisation',               17::numeric, 2),
  ('Sahithyasudhi & Overall presentation',17::numeric, 3),
  ('Thalam',                              17::numeric, 4),
  ('Originality / Nadan Thanima',         16::numeric, 5),
  ('Use of traditional instruments',      16::numeric, 6)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Mime (T13)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'T13'
CROSS JOIN (VALUES
  ('Acting skill',            20::numeric, 1),
  ('Variety of Characters',   20::numeric, 2),
  ('Novelty',                 20::numeric, 3),
  ('Theme',                   20::numeric, 4),
  ('Clarity of message',      20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- Tableau (T14)
-- 5 criteria → 20×5 = 100
INSERT INTO event_criteria (event_id, criterion_name, max_score, sequence_order)
SELECT e.id, v.n, v.s, v.o
FROM year_config y
JOIN events e ON e.year_id = y.id AND e.event_code = 'T14'
CROSS JOIN (VALUES
  ('Theme & Message',           20::numeric, 1),
  ('Costume & Make-up',         20::numeric, 2),
  ('Arrangement & Formation',   20::numeric, 3),
  ('Synchronization',           20::numeric, 4),
  ('Overall presentation',      20::numeric, 5)
) AS v(n, s, o)
WHERE y.is_active = TRUE
ON CONFLICT (event_id, sequence_order) DO NOTHING;

-- =============================================================================
-- VERIFICATION QUERIES (run after import to check everything looks right)
-- =============================================================================
/*
-- Count events inserted
SELECT c.code, c.name, COUNT(e.id) AS event_count
FROM categories c LEFT JOIN events e ON e.category_id = c.id
GROUP BY c.id, c.code, c.name ORDER BY c.sort_order;

-- Check criteria sums (all should be 100)
SELECT e.event_code, e.event_name, SUM(ec.max_score) AS total
FROM events e JOIN event_criteria ec ON ec.event_id = e.id
GROUP BY e.id, e.event_code, e.event_name
HAVING SUM(ec.max_score) <> 100
ORDER BY e.event_code;
-- (Should return 0 rows if all criteria sum to 100)

-- Check age group coverage
SELECT e.event_code, e.event_name, COUNT(eag.age_group_id) AS age_group_count
FROM events e LEFT JOIN event_age_groups eag ON eag.event_id = e.id
GROUP BY e.id, e.event_code, e.event_name
HAVING COUNT(eag.age_group_id) = 0
ORDER BY e.event_code;
-- (Should return 0 rows if all events have age groups)
*/
