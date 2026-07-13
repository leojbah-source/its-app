# ITS App — Project Context for Claude

## What This App Is
Indian Talent Scan (ITS) — a competition management platform for KCA Bahrain.
Admin dashboard (React + Vite, port 5173) + Express backend (port 4000) + PostgreSQL.

Repo: `C:\ITS-APP`  
Backend: `C:\ITS-APP\backend\src\routes\`  
Frontend pages: `C:\ITS-APP\frontend\src\pages\`  
API client: `C:\ITS-APP\frontend\src\api\client.js`

---

## MANDATORY RULES — Follow Before Writing Any Code

### Rule 1: Verify DB schema before writing any route
Before touching a backend route, run:
```sql
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'YOUR_TABLE'
ORDER BY ordinal_position;
```
Never assume column names. The actual names often differ from what seems logical.

### Rule 2: Check NOT NULL constraints
Before any INSERT, identify NOT NULL columns without defaults. Either provide values or add `COALESCE($n, default)` in SQL. Never rely on JS default parameters to handle null — use SQL COALESCE.

### Rule 3: Trace the full data flow before coding
For every feature: Frontend form field → API payload field → Backend extraction → DB column name → GET response field → Table/display field. All must match. Mismatches in any layer cause silent failures.

### Rule 4: Use transactions for multi-table writes
Any operation touching more than one table (events + criteria + age_groups, etc.) must use `pool.connect()` + BEGIN/COMMIT/ROLLBACK with `finally { client.release() }`.

### Rule 5: Enum types need checking
If a column is `USER-DEFINED`, check its values:
```sql
SELECT unnest(enum_range(NULL::your_enum_type));
```

### Rule 6: Junction tables store IDs, not strings
`event_age_groups` stores `age_group_id` (integer), not codes like 'G1'. Always look up IDs:
```sql
SELECT id FROM age_groups WHERE year_id = $1 AND code = ANY($2)
```

### Rule 7: File uploads return full URLs
Upload route must return `${req.protocol}://${req.get('host')}/uploads/filename` not `/uploads/filename`. React dev server (5173) can't serve Express static files (4000).

---

## DB Source of Truth
The database = `db/schema.sql` + every file in `db/migrations/` applied in
numeric order. When adding tables/columns, write a NEW idempotent migration
file (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) — do not edit
schema.sql retroactively.

Applied so far:
- `001_fees_payments_finance.sql` (fees, payments, refunds, finance_* tables)
- `002_timer_role_dq.sql` ('Timer' user_role enum value — Addendum 1)
- `003_gender_teamsize_domain.sql` (events.gender_split; year_config
  team_size_min/max, website_domain, event_start/end_date, its_logo_url,
  grade_c_pct, tiebreaker_scale_max; teams.fee_amount)
- `004_age_group_duration.sql` (event_age_groups.allotted_time_seconds —
  per-age-group duration override; event-level value is the default)

## Scheduling controls — per-event & per-category (July 2026)
Migration 015 (015_scheduling_controls.sql) adds:
- events.preferred_venue_id (FK venues, ON DELETE SET NULL) — SOFT pin: the
  scheduler orders allowed_venues to try this venue first, falls back to other
  suitable venues if it can't fit. e.g. Fashion Show / Fancy Dress -> VKL Hall.
- events.keep_groups_together (bool) — all age groups scheduled as ONE
  continuous block in one venue; OVERRIDES the age-group split limit (ramp/
  setup reuse). Emitted as a single unit in getActiveEventsForYear (branch A).
- events.requires_tables (bool) — TABLE event (drawing, spelling, handwriting,
  clay modelling...). All age groups in one seated unit (branch B), and the
  scheduler service runs a TABLE-EVENTS PRE-PASS: table units placed FIRST,
  each on the LEAST-BUSY venue in the block so they run in parallel (concurrent
  tables) at a shared start, clustered at the front of the day; main greedy
  loop then skips table units. Spread-wide venue pick lives in the pre-pass.
- categories.not_before_date (date) — earliest date a category's events may be
  scheduled (dance late for practice time). Scheduler gates: `if
  (event.not_before && day.date < event.not_before) continue;` in BOTH the
  table pre-pass and the main loop. Units carry not_before from c.not_before_date.

Wiring:
- getActiveEventsForYear query now selects keep_groups_together, requires_tables,
  pv.name AS preferred_venue, c.not_before_date; orderByPreference() puts the
  pinned venue first; every unit carries {preferred_venue, table_event,
  not_before, keep_together}.
- Backend routes: admin.events POST/PUT carry preferred_venue_id (CASE-based so
  clearing works), keep_groups_together, requires_tables (boolOrNull so
  unchecking saves). GET uses e.* so columns return automatically.
  admin.schedule GET/PUT /category-dates set categories.not_before_date
  ({ dates: { <catId>: 'YYYY-MM-DD'|null } }), audited SET_CATEGORY_DATES.
- Frontend: EventDetailsForm gains a "Scheduling" block — Preferred venue
  <Select> (needs `venues` prop) + Keep-groups-together + Table-event
  checkboxes. Venues loaded in Events.jsx (venuesApi.list) and passed via
  EventEditDrawer. Schedule.jsx generate panel: "Earliest date per category"
  date inputs (catDates state, scheduleApi.categoryDates/saveCategoryDates);
  dates are saved just before generate-draft runs.
- Verified: scheduler service unit-tested in isolation (6/6) — not_before
  gating, table pre-pass concurrency (different venues, same start), baseline.
  All changed frontend files parse via esbuild (Vite build can't run in the
  Linux sandbox: node_modules has Windows-only rolldown native binary).

## Age-group-wise scheduling units (July 2026)
- Scheduling unit = event × AGE-GROUP BATCH (migration 014:
  schedule.age_groups label 'G1, G2'). generate-draft splits each event per
  age group and greedy-combines CONSECUTIVE groups up to
  max_groups_per_session (1–3, default 3, UI select) while the batch still
  fits the longest available session — judges take 2–3 groups per sitting.
  Unit ids are synthetic '<eventId>|<codes>' strings mapped back in
  saveScheduleDraft; per-row entries counts reflect the batch's groups.
  Full-dataset check: 78 sessions, 0 unplaced (previously the whole-event
  model couldn't place large events at all).

### Over-clubbing fix (July 2026)
- BUG: batching used fitLimit = longestSessionFor(allowed) — the single
  longest block ANY suitable venue offers. If one venue had a rare all-day
  block (e.g. Fri 10:00–20:00 = 600 min), 2–3 groups were clubbed into one
  oversized session that then couldn't fit the SHORT blocks available on most
  days. Symptom: ~7 events wrongly combined age groups instead of running each
  group individually to fit the timings.
- FIX (admin.schedule.routes.js getActiveEventsForYear):
  * blockLengthsFor(allowed) → all available block lengths.
  * typicalSessionFor(allowed) = MEDIAN block → the limit a COMBINED batch must
    fit (combineLimit). Groups are only clubbed while the combined sitting fits
    a block that's common in the schedule, not a rare outlier.
  * longestSessionFor(allowed) = MAX block → placeLimit, used only to judge
    whether a SINGLE group can be placed at all (never to justify clubbing).
  * Batcher auto-splits: when adding the next group would exceed combineLimit
    (or hit max_groups), the batch flushes so that group starts its own
    session → over-long combos become one-group-per-session automatically.
  Verified in isolation: with 90-min typical / 600-min longest blocks, small
  events still club (G1–G3 + G4–G5) while large events split to one group each,
  and a single oversized group stays placeable (fits the longest block) rather
  than being falsely reported unplaced.
- NOTE: the working copy of admin.schedule.routes.js had also been left
  TRUNCATED mid-file (PUT /:id + publish routes cut off) from a prior
  interrupted session — restored from HEAD; backend now parses.

## Scheduler duration model & diagnostics (July 2026)
- STAGE events (is_stage_event) are sequential: entries × per-participant
  allotted time + setup. NON-STAGE events (arts/literary) run
  SIMULTANEOUSLY: sessions = ceil(entries / best allowed venue capacity),
  duration = sessions × allotted (default 60 min) + setup. Capacity no
  longer excludes venues for non-stage events — it drives session count.
- generate-draft returns unplaced[] enriched with event_code/name/entries/
  needed_minutes and a human reason: no suitable venue / suitable venues
  have NO availability days / needs ~N min vs longest session M min at
  venue X / no conflict-free slot. Schedule page renders these; venue
  summary shows an amber 'NO DAYS SET — will never be used' warning.
- Verified with the full 2025 dataset (1,697 regs): all 53 events place
  when venues have weekend hours; Mon/Wed-evenings-only setup explains
  each failure specifically.

## Venues & report formats (July 2026)
- venues table (migration 013, max 4 enforced): has_stage, capacity
  (NULL = unlimited), suitable_for {dance,music,arts,literary} (empty = all),
  weekday_hours JSONB {"fri":{"start","end"},…} — missing weekday = closed.
  GET/PUT /api/admin/schedule/venues; VenuesCard in Year Setup.
- generate-draft no longer takes venues/blocks: it builds per-date blocks
  from each venue's weekday hours, and restricts each event to venues that
  match its category tag (categoryTag regex), capacity ≥ entries, and stage
  requirement. scheduler service gained optional event.allowed_venues filter
  (one-line change, tests untouched). Body: {start_date?, end_date?, buffer}.
- Report formats: NO CPR numbers or schools on printed lists; ITS logo
  centred in the header (its_logo_url); 'by event' print restructured to
  Age group (asc) → event name (alpha) → participant names (alpha);
  final list shows events one per row (code + name; /final now returns an
  events json array per participant).

## Lists & Schedule (July 2026)
- Lists (routes/admin.lists.routes.js, /api/admin/lists/*): by-event (entries
  grouped by age group), by-participant (with parent + signature line),
  final (roster + totals), publish-initial (stamps
  year_config.initial_list_published). Admin page /admin/lists prints via a
  popup window with year label + KCA/sponsor logos (openPrint()).
- Schedule (routes/admin.schedule.routes.js, /api/admin/schedule/*): the OLD
  endpoints in admin.config.routes were broken (wrong import name, wrong
  call signature, non-existent columns) and are removed. generate-draft
  builds a db adapter for services/scheduler.generateScheduleDraft
  (duration = participants × allotted_time + setup, min 20 min; constraints:
  no double-booking, ≤2 events/day/participant, category clustering);
  draft rows replace previous drafts; GET returns event_date via to_char
  (pg DATE + toISOString shifts a day in +03 — always format dates locally,
  see localISO()); PUT /:id adjusts rows (audited, generated_by_scheduler
  → FALSE); publish flips draft→confirmed (audited). Admin page
  /admin/schedule: venues + daily blocks + buffer inputs, unplaced report,
  per-row adjust, publish. Sidebar: Lists + Schedule now active.

## Team member entry & captain (July 2026)
- Team form is CPR-FIRST per member: Check → participantLookup; if already
  registered the details come from file (parent confirms); else type, scan
  per-row (CprScanner), or upload bulk CPR PDF post-registration.
- Member 1 = Team Captain (team_members.is_captain, migration 012);
  teams.captain_phone collected on the form; CAPTAIN tag in member lists.
- Dance/song team events collect a teacher name → stored on the team's
  registrations row (dance_teacher/music_teacher by category regex).
- TEACHER_PURPOSE_NOTE (TeamRegister export) shown wherever teacher names
  are accepted (team form + ParticipantDetail): names are used ONLY for the
  Best Dance/Music Teacher awards.
- FIX: drawer onUpdated() with no args crashed handleRegUpdated
  (updated.id on undefined → blank page). Now refreshes the list instead.

## Verification visibility on the registrations list (July 2026)
- List rows now include admin_verified_status and computed payment_status
  ('verified' if any confirmed payment, 'pending' if any pending, else
  'none'); grouped view shows CPR ✓/issue/pending + Paid ✓/pending/none
  badges per participant.
- New filters: 'CPR check' (verified / not verified / issue) and 'Payment'
  status (verified / pending / none); the old OCR/manual filter is relabelled
  'Entry'.
- GET /registrations/export CSV enriched: fee, CPR admin-verified + note,
  entry method, scan uploaded, payment status/methods/confirmed total,
  parent name/contact, KCA membership; team rows included (LEFT JOINs).
  The Export button now sends the JWT (the old plain <a> got 401s).

## Admin verification workflow (July 2026)
- AUDIT FIX: utils/audit.js previously wrote to non-existent audit_log
  columns — every logAudit silently failed. Now maps to the real columns
  (table_name, record_id, action, old_value, new_value, changed_by, reason);
  migration 011 drops the INSERT/UPDATE/DELETE-only CHECK so semantic
  actions ('CONFIRM_PAYMENT', 'ADMIN_VERIFY_CPR', …) are stored. logAudit
  accepts optional before/reason for before/after logging. DB triggers also
  write UPDATE/INSERT rows independently.
- Participant verification (migration 011: admin_verified_status
  pending|verified|issue + by/at/note):
  GET /api/admin/participants/:id/detail (identity+scans, regs, payments,
  audit trail), POST /api/admin/participants/:id/verify (verified | issue —
  issue requires note, notifies parent via WhatsApp + email).
  Parent corrects via PATCH /api/register/participant/:id (owner-only,
  CPR-DOB revalidated, resets status to pending, audited before/after);
  ParticipantDetail shows the issue note + correction form with CprScanner.
- Payment verification: RegistrationDrawer shows proof screenshots with
  Confirm / Reject-with-reason; rejection now notifies the parent
  (WhatsApp + email, e.g. wrong transfer amount).
- Chairman-only event corrections: PUT /api/admin/participants/:id/events
  (Chairman/SuperAdmin, mandatory reason, no deadline check, refund rows for
  removals, before/after audit). Admin gets 403.
- RegistrationDrawer rewritten as the verification panel: identity + CPR
  front/back/photo previews, verify/flag, payments, chairman event editor,
  audit trail list.

## Admin registration filters & participant ownership (July 2026)
- participants.created_by (migration 010) is THE link to the parent account.
  participants.pwa_username is trigger-owned (name+CPR PWA login,
  fn_generate_pwa_username overwrites it) — NEVER use it to reference users.
  my-participants and parent-membership lookups now use created_by.
- participants.cpr_verified_method 'ocr'|'manual' (migration 010): 'ocr' when
  the camera scan filled details without mismatch, else 'manual'.
- Admin GET /registrations rows include payment_methods (distinct methods,
  participant or team payments), parent_membership_status, cpr_verified_method.
- Registrations filter bar: search, status (All/Registered only — attended/
  absent/withdrawn/swapped removed), payment method (KCA office cash /
  BenefitPay / bank / none), CPR verified (OCR/manual), KCA member (yes/no),
  age group, school (dropdowns built from loaded rows, client-side filtering).

## CPR capture & team documents (July 2026)
- Team CPR scans (migration 008, team_documents): POST/GET
  /api/register/team/:id/documents — images OR PDFs up to 10 MB, one file
  may contain several members' CPRs; verified manually by KCA
  (verified_by/verified_at columns for later admin UI). Parent uploads from
  the team card; admin sees them in GET /api/admin/teams/:id/members
  (NOTE: that response is now {members, documents}, no longer a bare array).
- Individual entry: CprScanner.jsx — TWO-SIDED camera capture (front →
  cpr_scan_url, back → cpr_scan_back_url, migration 009). The DOB is on the
  BACK of the Bahrain CPR card, which also carries a TD1 MRZ
  (IDBHR<cpr>… / YYMMDD?M… / SURNAME<<GIVEN) — parseMrz() decodes CPR, DOB
  (century pivot on current YY), gender and name from it; parseCprText()
  falls back to labelled text ('Personal Number', 'Date of Birth', 'Name /
  الاسم' bilingual labels) and NEVER trusts unlabelled dates (front carries
  EXP/issue dates). Handles OCR noise (« for <, injected spaces) and 8-digit
  CPRs (leading 0 dropped). tesseract.js is a frontend dependency (run
  `npm install` in frontend/); lang data downloads on first scan. Parent
  always reviews; server re-validates CPR-vs-DOB prefix on submit.

## Team registration flow (July 2026)
- Individual selection EXCLUDES team events (GET /events?kind=, POST/PUT
  enforce event_kind='individual'); max_individual_events applies only to
  individual events (team regs are team-level rows, never counted).
- Teams (migration 007: teams.created_by, payments.team_id): POST /team
  registers with event + team_name + >=1 member given as details
  {full_name, dob, cpr_number, school_id}; members validated against the
  EVENT's eligible age-group DOB ranges; participants auto-created by CPR
  (no scan required for team-sheet members). Min size enforced later (note
  returned), max enforced always. GET /my-teams, GET /team/:id,
  POST /team/:id/members (until team_reg_deadline), POST /team/:id/payment
  (per-team fee; member rate when the registering parent is active).
- Parent portal: Dashboard offers Individual (Add Participant) and Team
  Event Entry (/register/team → TeamRegister.jsx: my-teams cards with member
  list + add-later + fee payment, new-team form).
- Completion: POST /participant/:id/confirm sends the summary email +
  WhatsApp 'registration received'; ParticipantDetail shows a green
  'Registration received & saved' panel (Complete Registration button,
  disabled while unsaved changes exist).
- Admin Registrations: Individual / Team tabs; team rows show TEAM badge
  with member count (admin GET includes team_member_count).

## Parent membership & participant identity (July 2026)
- Membership is PARENT-level (migration 006): users.kca_member_no /
  membership_status (none|active|lapsed|pending) / whatsapp_number, verified
  at signup against mem.kcabah.com incl. paid-up-to check vs
  year_config.member_subscription_upto ('YYYY-MM', set in Year Setup).
  POST /api/register/membership/refresh re-verifies after renewal.
  Fee calc (events POST/PUT, /fees) uses parentMemberActive(req.user.id);
  /fees returns membership{status,note} → amber alert + Re-check button in
  PaymentSection.
- Participant creation: CPR must be 8/9 digits, prefix YYMM matching DOB
  (leading 0 may drop, e.g. 2008 → '80312345'); cpr_scan_url is COMPULSORY,
  photo_url collected for result cards; guardian name/phone inherited from
  the parent account (not re-entered).
- Admin Registrations page defaults to By-participant view (one row per
  child, event code chips); toggle to By-event-entry. GET /registrations
  now LEFT JOINs participants/teams so team rows appear (team_name).

## Registration screen rules (July 2026)
- category_cap is an AWARDS-ONLY rule (top-N per category count towards
  championships). Migration 005 removed it from the registration trigger;
  only max_individual_events limits selection. Trigger errors now use the
  child's name, not participant ids.
- Event list is grouped by category (collapsible), shows per-category
  selected counts, per-event fee (member rate when active) and a running
  total bar.
- Teacher names: ONLY dance (Natya) and music (Sangeet) events. PUT
  /api/register/participant/:id/teacher accepts apply_to_all=true to copy a
  name to all of the participant's events in that category (regex
  natya|dance / sangeet|music|song on category name/code).
- Registration summary email (utils/email.js, nodemailer — new dependency,
  run `npm install` in backend; SMTP_* vars in .env.example) sent after
  payment submission; response includes email_sent, surfaced in the UI.
  Skips gracefully when SMTP unconfigured, like WhatsApp.

## Events module notes (July 2026 fixes)
- Year Setup publish no longer DELETEs age_groups (FK violation once
  participants exist) — upserts by (year_id, code); removed codes deleted
  only when unreferenced.
- Time slots now persist: saveSlots() upserts event_time_slots by
  (event_id, slot_label) and GETs attach `slots` (aliased label/capacity to
  match the frontend). Slots referenced by registrations are never deleted.
- Event timing (allotted/grace/yellow seconds) editable in the event editor,
  plus per-age-group duration overrides (event_age_groups.allotted_time_seconds).
  Timer module must read: override ?? events.allotted_time_seconds.
- Events CSV round-trip: GET /api/admin/events/export (UTF-8 BOM CSV) and
  POST /api/admin/events/import (text/csv, upsert by event_code, all-or-
  nothing validation: criteria must sum to 100, known category/age codes).
  Multi-value cells use pipes: age_groups "G1|G2", criteria "Name:25|Name:75",
  age_group_durations "G1:420".

## §4.1 Year Setup audit (July 2026) — resolved
All §4.1 variables are now in year_config, editable in Year Setup UI
(BrandingCard identity fields; LimitsCard caps/thresholds/team sizes;
PaymentDeadlinesCard IBAN/BenefitPay/deadlines; Grading/Divergence/AgeGroups
as before), and enforced. Per-event fees + gender_split editable in the
Events page (EventDetailsForm). Bugs fixed in this pass:
- PUT /api/admin/config/active referenced 5 columns missing from schema.sql
  (event_start/end_date, its_logo_url, grade_c_pct, tiebreaker_scale_max) —
  EVERY Year Setup save silently failed until migration 003.
- Team registration violated registrations_check (participant XOR team):
  now ONE team-level registrations row; members via team_members only.
- Gender split enforced in event list + selection; team max size enforced
  (min enforced at final submission); per-team fee snapshot on teams.fee_amount
  (member rate only when ALL members have active membership).

## Addendum 1 (Timing System & Disqualifications) — status
Schema: DONE. participant_timings, timer_assignments, events timing columns,
scores.is_void/voided_reason/voided_by/voided_at, event_results
is_disqualified/disqualification_reason/disqualified_by/disqualified_at/
dq_reversed/dq_reversal_reason (see schema.sql §14.4/14.5) + 'Timer' role (002).
NOTE: schema uses `voided_reason` and `disqualification_reason` — use these
exact names, and both have CHECK constraints requiring a reason when set.
Still to build: /api/timer/* routes, admin timing & DQ endpoints, Timer UI
(full-screen stopwatch), Timing & DQ admin tab, judge DQ banner, PWA DQ display.

## WARNING — admin.judging.routes.js is schema-mismatched
It queries s.judge_id / s.score / s.assignment_id / `criteria` table /
year_config.grade_config — NONE of these exist. Real names: scores.judge_assignment_id,
scores.score_value, scores.criterion_id, event_criteria, year_config.grade_a_pct etc.
These routes will crash at runtime and must be rewritten against the real schema
(and must filter `WHERE s.is_void = FALSE`) when building the Judging module.

## Established DB Schema (key tables)

### year_config
`id, year, event_year_label, is_active, event_start_date, event_end_date,
kca_logo_url, its_logo_url, sponsor_logo_url, sponsor_name, kca_iban, benefit_pay_number,
max_individual_events, category_cap, kca_special_min_points,
min_entries_threshold, split_threshold, no_prize_below,
rank_pts_first, rank_pts_second, rank_pts_third, participation_bonus_pts,
grade_a_pct, grade_b_pct, grade_c_pct, grade_a_pts, grade_b_pts, grade_c_pts,
divergence_threshold_pct, tiebreaker_scale_max,
reg_deadline, team_reg_deadline, teacher_name_deadline,
result_template_url, photo_crop_width, photo_crop_height,
initial_list_published, initial_list_published_at, created_at, updated_at`

### categories
`id, year_id (FK→year_config), code (text), name (text), sort_order`
Current values: NAT/Natya, SAN/Sangeeta, SAH/Sahitya, KAL/Kala, ADD/Add-on, TEAM/Team Event

### age_groups
`id, year_id (FK→year_config), code (text: G1-G5), label, dob_from (date), dob_to (date), sort_order`

### events
`id, year_id, category_id (FK→categories), event_code, event_name,
event_kind (enum: individual|team), is_stage_event (bool), time_slot_mode (bool),
is_cancelled (bool), cancelled_at, cancel_reason, cancelled_by,
sort_order (integer, default 0), allotted_time_seconds, grace_period_seconds, yellow_alert_seconds,
max_participants_per_team, min_participants_per_team, created_at, updated_at`

### Fees (migration 001) — Rule 22
`events.fee_amount` = standard rate; `events.member_fee_amount` = KCA member
rate (NULL = same). Member rate applies when `participants.membership_status
= 'active'`. `registrations.fee_amount` snapshots the charged fee. BHD = 3
decimal places, NUMERIC(10,3).

### payments (migration 001)
`id, year_id, parent_user_id, participant_id, amount, discount_applied,
method (enum: cash|benefitpay|bank_transfer), status (enum: pending|confirmed|rejected),
reference, proof_url, notes, confirmed_by, confirmed_at, created_at, updated_at`

### refunds (migration 001)
`id, year_id, participant_id, registration_id, events_withdrawn, reason,
original_amount, refund_amount, method, status (pending|confirmed|rejected),
refunded_at, requested_by, logged_by, created_at`
Withdrawing an event via PUT /api/register/participant/:id/events requires
`removal_reason` and auto-creates a pending refund row.

### event_criteria
`id, event_id (FK→events), criterion_name (text), max_score (numeric), sequence_order (integer)`

### event_age_groups
`event_id (FK→events), age_group_id (FK→age_groups)` — pure junction, no PK id

---

## Frontend Field Name Conventions
The frontend uses these names; backend responses must match:

| Frontend         | DB column       |
|-----------------|-----------------|
| `event_code`    | `event_code`    |
| `event_name`    | `event_name`    |
| `category_id`   | `category_id`   |
| `category_name` | joined from categories.name |
| `event_kind`    | `event_kind`    |
| `is_cancelled`  | `is_cancelled`  |
| `age_groups`    | array of codes (assembled from junction) |
| `criteria`      | array of {label, max_score} (assembled from event_criteria) |

---

## Established Patterns

### GET response for events — always include joined data
```javascript
// Always attach criteria + age_groups to event rows
await attachCriteriaAndAgeGroups(client, rows);
```

### Saving events — always use transactions
```javascript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  // ... inserts/updates
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => null);
  next(err);
} finally { client.release(); }
```

### Null sanitiser for PUT routes
```javascript
const n = v => (v === '' || v === undefined || v === null) ? null : v;
```

### Active year lookup pattern
```javascript
const { rows: cfg } = await pool.query(
  `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`
);
const year_id = cfg[0]?.id;
```

### Categories are year-scoped
Always filter by `year_id` when querying categories or age_groups.

---

#