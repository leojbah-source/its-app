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

## Judges' briefing sheet after login (July 2026)
The judge portal now opens on a BRIEFING screen (the "Judges briefing sheet"),
then Continue → scoring.
- Backend judge.routes: GET /briefing/:assignment_id → { event (+ allotted/
  grace/yellow seconds, is_stage_event), criteria, weightages_locked, agreement }.
- Frontend JudgeApp restructured: after login (auto-opens the OTP'd event) →
  Briefing (criteria list + total, agree/adjust weightages moved here from the
  grid, timing line for stage events, "Agreed by X/Y" + I-agree) → "Continue to
  scoring" → GroupPicker → ScoreGrid. The grid no longer carries the weightage
  panel; it keeps the agreement gate (inputs disabled until all_agreed).
  client.js judgeApi.briefing added.
- Verified: judge route load; JudgeApp + client parse.

## Weightage save bug + shared-weightage clarity (July 2026)
- BUG: saving reordered weightages hit UNIQUE(event_id, sequence_order)
  ("event_criteria_event_id_sequence_order_key") — the single UPDATE reassigning
  sequence_order transiently duplicated a position. FIX (judge.routes /criteria):
  update max_score in one statement (sum trigger sees final 100), then reorder
  sequence_order in TWO steps: bump all +1000, then set final 1..n → no transient
  collision. So the save FAILING is why weightages appeared to "revert" to the DB
  values (25/25/25/25).
- CLARITY: weightages are ONE SHARED set per event (single event_criteria row
  set), agreed by the whole panel — NOT per-judge. Any judge's save overwrites
  the shared set + resets agreements + proposer auto-agrees. Judges differ in
  their SCORES, not the weightage structure. JudgeApp Briefing copy rewritten to
  say this ("shared by all three judges … one figure per criterion"); the
  briefing now POLLS every 5s (paused while a judge is editing) so judges see the
  others' saved figures + the "Agreed by X/Y" count live.
- Verified: judge route node -c; JudgeApp parses.

## Judge sees ALL assigned events (July 2026)
FIX: /api/judge/events previously FILTERED to judges.active_event_id (set only
by OTP send), so a newly-assigned event was hidden until its OTP was sent —
worse under OTP bypass (no OTP send at all), leaving judges stuck on the old
event. Now /events returns ALL the judge's assigned events with an is_active
flag (e.id = active_event_id), ordered active-first. JudgeApp auto-opens only
when there's exactly ONE event; with multiple it shows the list, the OTP'd one
badged "current" and listed first, and the judge chooses. active_event_id is now
a highlight/default, not a hard filter.

## Judge OTP bypass for testing (July 2026)
auth.routes verify-otp: if env JUDGE_OTP_BYPASS=true, judges log in with PHONE
ONLY (no WhatsApp/SMS OTP) — for testing before go-live. Default (unset/false) =
normal OTP enforced. Added to backend/.env.example. JudgeLogin.jsx made OTP
optional (validates phone only; label "(if required)"; note about testing).
REMOVE/set false before going live to re-enable OTP.

## Divergence review before finalise (July 2026)
Deferred judging item 1/4. When a participant's judge-ranks diverge beyond the
threshold (rule #7), a Chairman must review + note it before the group can be
finalised.
- admin.judging.routes: GET /results now merges stored event_results
  divergence_notes into each live result row. POST /results/:e/:ag/divergence
  {registration_id, note} upserts event_results.divergence_notes (not on
  published rows). finalise now 409s if any diverging participant lacks a note.
- Results.jsx: diverging rows show a red "review diverge" button (Chairman note
  prompt) → "diverge ✓" green once noted (note in tooltip); Finalise disabled +
  red hint while unreviewedDiv>0. resultsApi.reviewDivergence added.
- Verified: judging route node -c; client + Results parse.
Remaining deferred (user order): 2) tiebreaker resolution (rule #8), 3) prize-
eligibility (min_entries_threshold/no_prize_below), 4) extra/consolation prizes.

## Staff session persistence (July 2026)
AuthContext (staff/admin) now persists token + user in sessionStorage (keys
its_staff_token/its_staff_user) — a refresh or tablet sleep no longer signs out
(critical for MC/Timer day-of tablets); clears on tab close. Recovers user from
the JWT payload if the stored user is lost. Login response already includes
role, so landingFor()/ProtectedRoute allowedRoles work after refresh. (Judge +
parent portals already used sessionStorage.)

## Timer sequential start (July 2026)
Timer Start is now SEQUENTIAL: only the first not-yet-timed chest (chest order,
nextReg memo) shows an enabled Start; others show "next in line". Nothing
startable while a chest runs. A Chairman correction (pencil) sets a time → marks
that chest done → unblocks the next (also the skip path for a no-show).

## Timer/MC group selection + headers (July 2026)
Both portals were showing multiple age groups at once (chest numbers repeat per
group). Fixed:
- Timer backend: GET /api/timer/groups/:event_id (age groups w/ chest-assigned
  count); GET /participants/:event_id now takes ?age_group_id filter.
  timerApi.groups + participants(eventId, ageGroupId).
- Timer portal: event → GROUP picker → that group only. Header shows EVENT +
  "Group Gx". Switching group (or Back) while a timer is running prompts a
  confirm (the running timer keeps going in the DB).
- MC portal: Participants tab now has a GROUP picker (derived from the grouped
  data) → shows only that group. Clear EVENT header (code/name/category) at top;
  selected-group pill. Leaving an UNFINISHED group prompts a confirm. Done-tick
  detection + "call the next number" banner are scoped to the selected group.
- FIX: the MC done tick was rendering a literal "\u2713" (bad heredoc escape) —
  now a real checkmark.
- Verified: timer route node -c; TimerPortal + McPortal + client parse.

## Timer portal + MC done-tick (July 2026)
Timer is a staff 'Timer'-role account (enum already existed; timer_assignments +
participant_timings already existed). No migration.
- Backend timer.routes.js (/api/timer, staff + Timer/SA/Chairman): GET /my-events
  (+ event thresholds), GET /participants/:event_id (CHEST ONLY + latest timing
  state via LATERAL + event allotted/grace/yellow), POST /:event/start &
  /:event/stop (upsert participant_timings; generated cols compute time/DQ;
  BEFORE-INSERT trigger fills allotted/grace snapshots), POST /:event/override
  (Chairman email+password verified via bcrypt → set corrected seconds; audited
  TIMER_OVERRIDE). timed_by stamped.
- Frontend TimerPortal.jsx (/timer, ProtectedRoute Timer/SA/Chairman): my-events
  → big live stopwatch for the running chest (250ms tick + 3s poll), light state
  green→yellow(allotted−yellow)→red(allotted)→over(grace); per-chest Start
  (disabled while one runs)/Stop; done rows show time (+ 'over' if flag_for_dq);
  Pencil → OverrideModal (seconds + Chairman email/password). timerApi in client.
  Login already routes Timer → /timer.
- MC DONE-TICK (new feature): mc.routes /participants now returns `done`
  (latest timing end_time set). McPortal Participants POLLS every 5s; detects
  newly-completed chests vs previous set → green banner "Chest N finished — call
  the next number"; done rows show a green ✓ and struck-through name. So the MC
  knows which chest is complete and calls the next correctly.
- Admin: Event assignment page modal GENERALISED to MC + Timer (staffRole state;
  MC and Timer buttons, each gold + ✓ when assigned via mc_name/timer_name in
  event-assignments; create/assign/unassign are role-aware). eventStaffApi
  already role-generic (assign role: MC|Timer; timer_assignments trigger enforces
  the Timer role).
- Verified: all route modules + index node -c; all changed frontend parse.
- NOTE: admin AuthContext still in-memory (Timer/MC refresh = re-login) — persist
  for day-of tablets later. Timer times one performer at a time (Start disabled
  while another runs).

## MC role — built (July 2026)
MCs are STAFF accounts (migration 020 adds 'MC' user_role; 021 mc_assignments —
mirrors timer_assignments, role enforced in app). Same email+password login as
staff; assigned per event; see only their assigned event on the day.
- Backend: admin.eventstaff.routes.js (/api/admin/event-staff, Chairman/SA):
  GET /users?role=MC|Timer, POST /users (create MC/Timer w/ bcrypt), GET
  /event/:eventId ({mc,timer} assigned), POST /assign {role,user_id,event_id}
  (verifies user holds the role; timer_assignments' trigger also enforces Timer),
  DELETE /assign/:role/:assignmentId. mc.routes.js (/api/mc, staff + role
  MC/SA/Chairman): GET /my-events, GET /script/:event_id (event+timing, the 3
  judges' detailed_bio, criteria, schedule date/venue/time, year branding), GET
  /participants/:event_id (chest + NAME by group, chest order — MCs see names).
  Both mounted in index.js. Migration 020 must be its OWN file (ALTER TYPE ADD
  VALUE can't share a txn) — 021 creates the table.
- Frontend: src/pages/mc/McPortal.jsx (own layout; My events → tabs MC Script /
  Participants). Script renders welcome + judges' bios + criteria + timing +
  sponsors from the endpoint. mcApi + eventStaffApi in client.js. Route /mc
  (ProtectedRoute allowedRoles MC/SuperAdmin/Chairman). Login.jsx now redirects
  by role: MC → /mc, Timer → /timer (portal pending), else /admin/config/year.
  Admin MC assignment added to the Event assignment page: a "MC" button per
  event row → modal to pick/assign an existing MC or CREATE a new MC account.
- NOTE: admin AuthContext is IN-MEMORY (refresh signs out) — MC/Timer on tablets
  will re-login on refresh. Consider persisting admin auth (sessionStorage) for
  day-of tablet use later.
- Verified: route modules load; all changed frontend files parse (esbuild).
- MIGRATIONS 020 + 021 must be applied.
- TODO NEXT: Timer portal (staff Timer role + timer_assignments already exist;
  build the chest-only stopwatch: start/stop, yellow/red at yellow_alert/
  allotted, grace, record time per chest into participant_timings; Chairman
  password-verify to edit a missed stop). Also show assigned MC/Timer in the
  Event assignment table at a glance (currently only in the MC modal).

## Day-of roles decision — MC & Timer (July 2026)
Per user: MC and Timer are STAFF accounts with a ROLE (Timer role exists in the
enum; MC to be added), same password login as staff, ASSIGNED per event, and on
the day each sees ONLY their assigned event + role screen. Judges keep the OTP
portal. Timer schema already exists: timer_assignments(user_id must hold 'Timer'
role via trg_timer_assignments_check_role, event_id, year_id, otp_sent_at),
participant_timings(registration_id, event_id, chest_no, start_time, end_time,
allotted_time_s/grace_period_s snapshots, GENERATED time_taken/exceeded/
within_grace/flag_for_dq). events.allotted_time_seconds/grace_period_seconds/
yellow_alert_seconds drive the stopwatch.
TODO NEXT (MC slice): migration add 'MC' user_role + mc_assignments; admin
create MC/Timer users + assign per event (Event assignment page); MC portal
(role landing after staff login) showing the MC SCRIPT (event details + the 3
judges' detailed_bio + criteria + timing) and, after intros, chest numbers WITH
participant names in chest order. THEN Timer portal (chest-only stopwatch:
start/stop, yellow/red at yellow_alert/allotted, grace, record time per chest;
Chairman password-verify to edit a missed stop).

## Results module — rank aggregation + finalise/publish (July 2026)
Rewrote admin.judging.routes.js (was schema-broken) as the RESULTS module. No
migration (event_results already exists). Per (event, age group):
- MODEL (user rule: "results are based on the ranks given by each judge"):
  each judge ranks the group by their own totals (standard ranking, ties share);
  PLACEMENT = lowest SUM of the judges' ranks; ties broken by criteria order
  (C1 totals across judges desc, then C2 …) and tie_flag set. GRADE (A/B/C) by
  AVERAGE score % vs year_config grade_a/b/c_pct. Points: rank_pts_first/second/
  third for places 1–3, grade_a/b/c_pts for the grade, participation_bonus_pts
  for all. DIVERGENCE (rule #7): a participant's judge-ranks spread >
  round(participants × divergence_threshold_pct/100) → divergence_flag. Places
  capped at min(3, participant_count).
- Endpoints (mounted /api/admin, Chairman/SuperAdmin): GET /results/:event/groups
  (groups + computed/finalised/published state), GET /results/:event/:ag (LIVE
  compute + per-judge ranks + flags + state), POST .../compute (upsert
  event_results; never overwrites published rows), POST .../finalise (Stage 1;
  409 unless scoring complete = every judge scored every participant fully),
  POST .../publish (Stage 2, Chairman; 409 unless finalised; CHECK enforces).
- Frontend: src/pages/judging/Results.jsx (event picker from schedule → group
  chips w/ state → results table: Place | Chest | per-judge ranks | Rank sum |
  Avg% | Grade | Points | tie/diverge flags; Compute/Finalise/Publish buttons,
  finalise disabled until complete). resultsApi in client.js. Sidebar "Results"
  child activated → /admin/judging/results (Chairman/SuperAdmin route).
- Verified: judging route node -c + load; Results/Sidebar/App parse.
- DEFERRED: tiebreaker resolution (rule #8 Chairman-unlocked 1–10 marks),
  extra/consolation prizes (rule #14), min_entries_threshold gating, divergence
  "proceed/justify" review. Grade thresholds: defaults make B=C=50 (set
  grade_c_pct lower in Year Setup for a distinct C band).

## Judge scoring — score cap + all-judges-agree (July 2026)
- SCORE CAP: over-max entries were rejected by the server but still displayed +
  inflated the grid total. Fix (JudgeApp ScoreGrid): keep a `saved` map (server-
  confirmed) separate from the `vals` edit buffer. On cell blur, if value > the
  criterion weightage (or invalid) → flash + REVERT the cell to saved; only valid
  values save. Total & Rank compute from `saved` only, so they're always correct.
- ALL JUDGES AGREE (migration 019: judge_assignments.weightages_agreed_at):
  * judge.routes agreementStatus(eventId, myAssignmentId) → {total, agreed,
    i_agreed, all_agreed}. Sheet returns `agreement`.
  * POST /criteria (set weightages) now RESETS all agreements for the event and
    auto-agrees the proposer. New POST /criteria/:assignment_id/agree sets this
    judge's agreement.
  * POST /scores is BLOCKED (409) until all assigned judges agree.
  * Frontend: weightage panel shows "Agreed by X/Y judges" + an "I agree" button
    (or "You agreed"); grid inputs are DISABLED with an amber notice until
    all_agreed. Editing weightages tells judges all must agree again.
- Verified: judge route node -c + load; JudgeApp + client parse.
- MIGRATION 019 must be applied.

## Judge scoring — weightage fix, event focus, grid (July 2026)
Fixes + rework after first judge-portal test:
- WEIGHTAGE BUG: trg_event_criteria_check is FOR EACH ROW and sums ALL of the
  event's criteria (raises if >100). Updating criteria one-by-one tripped it on
  an intermediate sum (e.g. 110). FIX: judge.routes /criteria now updates all
  criteria in ONE statement (UPDATE event_criteria FROM (VALUES ...) v) so the
  AFTER-EACH-ROW trigger sees the final total = 100.
- EVENT FOCUS (migration 018): judges.active_event_id. send-otps sets it to the
  event for each judge; GET /api/judge/events filters to that event when set
  (JOIN judges, WHERE active_event_id IS NULL OR e.id = active_event_id). So a
  judge only sees the event they were OTP'd for — can't open the wrong one.
  Overwritten by the next event's OTP send; NULL = all assigned.
- SCORING UI REBUILT (JudgeApp.jsx): focused flow event → pick ONE group (cards)
  → full-screen scoresheet with a big "Now scoring: EVENT · Group Gx" banner
  (no side-by-side groups → no mix-ups). GRID = chest rows × criteria columns
  (C1..Cn, sorted by sequence_order, max in header) + live TOTAL + live RANK
  (rule #6, this judge only; standard competition ranking, only chests with
  total>0). Scores AUTO-SAVE on cell blur (per-cell POST). Sticky chest column,
  horizontal scroll → works on mobile/tablet. Weightage panel unchanged
  (single judge sets, locks once scoring starts).
- Verified: backend node -c + load; JudgeApp parses.
- MIGRATION 018 must be applied before this works (active_event_id column).

## OTP delivery — wa.me links + dev echo (July 2026)
On localhost the WhatsApp API isn't configured (WHATSAPP_API_BASE_URL unset), so
sendWhatsApp() skipped silently — OTPs were generated/stored but never delivered.
- utils/notify.js: sendWhatsApp() now always returns { delivered, link, skipped }
  where link = waLink(phone, msg) = https://wa.me/<intl-digits>?text=<encoded>.
  When no provider is configured it returns delivered:false + the click-to-chat
  link (real WhatsApp, no account needed). Green API / WA Business still send
  automatically when configured. waLink exported.
- admin.judges send-otp (single) + event/:id/send-otps return the wa.me link(s):
  send-otps → { total, delivered, skipped, links:[{name,phone,url,delivered}],
  dev_codes:[{name,code}] }. dev = OTP_DEV_ECHO==='true' || NODE_ENV!=='production'
  → includes the actual OTP code for local testing (never in production).
- Frontend Assignment.jsx: the per-event OTP button opens a modal listing each
  judge with an "Open WhatsApp" link (green, target _blank) + the dev code +
  "no phone" list. Admin taps to send each judge their OTP via their own WhatsApp.
- TESTING: click OTP on Event assignment → modal shows codes (localhost) → log in
  at /judge/login with the judge's phone + that code. For real delivery set
  WHATSAPP_PROVIDER=green-api + WHATSAPP_API_BASE_URL/INSTANCE_ID/API_KEY in .env.
- Verified: notify + judges route node -c + load; Assignment parses.

## Judge scoring portal — backend + UI (July 2026)
Full judge scoring flow. Bare scoring (no live ranking yet); weightages agreed
on the day; per-group, chest-only (rule #5). No migration.
- judge.routes.js (rewritten, group-scoped): GET /events (assigned events +
  criteria_count/total), GET /events/:assignment_id/groups (age groups that have
  CHEST-ASSIGNED attendees, with participant_count + this judge's scored_count),
  GET /sheet/:assignment_id?age_group_id= (event, criteria w/ weightages,
  weightages_locked = any score exists for event, CHEST-ONLY participants for
  that group via registrations+chest_assignments+attended, my scores),
  POST /criteria/:assignment_id (agree weightages: validates ids∈event, each>0,
  sum=100; UPDATE event_criteria max_score+sequence_order; 409 once scoring
  started), POST /scores/:assignment_id (validates criterion∈event, reg is
  attended+has chest, 0..max; upserts). eventScored() helper gates weightages.
- Frontend judge portal (separate sessionStorage auth, token type 'judge'):
  * JudgeAuthContext (its_judge_token/info); authApi.sendOtp/verifyOtp added
    (/api/auth/send-otp|verify-otp — admin sends OTP incl. WhatsApp, judge enters
    it). judgeApi client: events/groups/sheet/setCriteria/saveScores.
  * pages/judge/JudgeLogin.jsx (phone + OTP, optional self "Send OTP"),
    pages/judge/JudgeApp.jsx (events list → EventDetail: group chips →
    GroupSheet). GroupSheet: Criteria & weightages panel — editable until locked;
    judges enter weightages, HIGHEST weightage auto = C1 (sorted desc → sequence_
    order), must total 100. Participants listed by CHEST NUMBER only; tap a chest
    → per-criterion inputs (0..max) → Save chest; green "scored" tick when all
    criteria filled. Scoring a chest LOCKS that event's chests on Event Day.
  * App.jsx: JudgeAuthProvider wraps routes; /judge/login + /judge (JudgeRoute).
- Verified: backend node -c + load; all judge frontend files parse (esbuild).
- TODO next: admin scoring/results (rewrite admin.judging.routes.js — divergence,
  grades, finalise/publish + Results tab); MC script + judges briefing sheet
  documents; optional live-ranking (rule #6) + criteria-confirm gate.

## Event Day: assign-gate + Chairman-reason clear (July 2026)
- Chest assignment now requires ALL participants in the group to be marked:
  admin.chest.routes.js groupUnmarked(event,group) counts status='registered';
  assign-auto/assign-timeslot return 409 "Mark every participant present or
  absent before assigning chest numbers." Frontend disables the Assign buttons
  while counts.unmarked>0 and shows an amber hint.
- Clearing chests requires a REASON (Chairman action): DELETE /:event_id reads
  req.body.reason, 400 if missing, audited with the reason. Still Chairman/
  SuperAdmin only (canManual). Frontend prompts for the reason.
- Verified: chest route node -c + load; client + EventDay parse.

## Event Day: chest lock + group reset + dramatized draw (July 2026)
Refinements after the per-group rework (an event is ALWAYS group-level — e.g.
Clay Modelling G4 vs G2 are separate contests):
- CHEST LOCK once judging starts: admin.chest.routes.js gains groupLocked(
  eventId, ageGroupId) = EXISTS score for a registration in that (event,group).
  assign-auto / assign-timeslot / manual / clear return 409 when locked; the
  /groups endpoint now returns a `locked` boolean per group. (Forward-compatible:
  locks the moment the judge scoring UI starts writing scores.)
- GROUP RESET: EventDay loadRoster now setRoster([]) immediately on group switch
  so the previous group's present/absent never lingers. (Attendance is stored
  per registration/group already; the seed data pre-marks everyone 'attended',
  which looked like carry-over — real regs start 'registered'.)
- DRAMATIZED DRAW: after assigning chests, a full-screen DrawOverlay reveals each
  participant one at a time (big chest number + name, ~1.2s each, scale/fade via
  BigReveal), with a running list of already-drawn and a Skip/Done button —
  projector-friendly for the kids. Reveal list built from the assign response
  (chest_number) + names from the current roster.
- Locked groups show a lock icon on the group chip + a "Locked — judging started"
  badge; all chest actions (assign/timeslot/clear/manual edit) hide when locked.
- Verified: chest route node -c + load; EventDay parses (esbuild).

## Event Day per-group rework + migration 017 (July 2026)
Chest numbers restart at 1 for EACH age group (groups run one after another,
numbers don't carry forward). Migration 017 (017_chest_per_group.sql):
chest_assignments gains age_group_id (FK, backfilled from registrations); the
UNIQUE(event_id, chest_number) is replaced by UNIQUE(event_id, age_group_id,
chest_number) so two groups can both have chest #1.
- Backend admin.chest.routes.js now GROUP-scoped:
  GET /:event_id/groups (each age group with total/attended/with_chest),
  GET /:event_id/roster?age_group_id=, POST /assign-auto & /assign-timeslot
  take {age_group_id} and number from MAX within (event,group)+1 (restart at 1),
  PUT /manual/:reg_id derives age_group_id from the registration,
  DELETE /:event_id?age_group_id= clears a group (or all). All inserts set
  age_group_id.
- Frontend EventDay.jsx rebuilt: DAY picker (default today, datalist of
  scheduled dates) → EVENT on that day (venue/time shown; NO category) → age
  GROUP chips (with counts) → roster for that group. Attendance Present/Absent
  updates roster state IN PLACE (no refetch → no scroll jump, fixing the
  jump-to-top bug on large lists); ABSENT rows show the name red + struck
  through. Assign/clear are per group. Summary badges computed from local
  roster so "Assign chests (N)" is live.
- client.js chestApi: groups() added; roster/assignAuto/assignTimeslot/clear now
  take ageGroupId.
- Verified: chest route node -c + load; EventDay + client parse via esbuild.
- MIGRATION 017 must be applied (node scripts/run-migrations.js) before this
  works — otherwise assign fails on the missing age_group_id column.

## Event Day admin screen + day-of workflow (July 2026)
User's day-of sequence: MC ready (MC script: event + 3 judges' detailed_bio
intros + criteria + timing) → admin marks attendance → chests assigned → judges
get briefing sheet (criteria + agree weightages totalling 100, C1 highest) →
judges open scoring screen via OTP → 3 judges agree criteria weightages on the
day → contest begins. Reference formats in uploads: "MC Script.pdf" (2025
template) and "Judges briefing-2024.xlsx".
- BUILT this slice: Event Day admin screen (src/pages/EventDay.jsx, route
  /admin/event-day, nav "Event Day" — NOT under the Chairman-only Judging
  group; it's operations, visible to all staff, backend enforces markRoles).
  Pick a scheduled event (derived from scheduleApi.list) → roster (chestApi
  .roster) → mark Present/Absent per row (POST attendance) → Assign chests
  (auto) or By time-slot; Clear chests + manual chest edit (Chairman/SA).
  Summary badges: entries/present/absent/chests/awaiting. chestApi added to
  client.js (roster/list/markAttendance/assignAuto/assignTimeslot/manual/clear).
- DECISIONS for the rest of the day-of flow:
  * Weightages: judges AGREE/ADJUST on the day (start from event_criteria
    config, panel can change max_score + C1/C2 sequence_order at briefing;
    needs an edit endpoint + audit — to build in the scoring/briefing slice).
  * MC script: build generation using the extracted 2025 template (auto-fill
    event details, judge intros from detailed_bio, criteria, timing, sponsors).
- STILL TODO (day-of frontend): judge mobile scoring UI (OTP login → events →
  chest sheet → agree weightages → enter scores), MC script generation, judges
  briefing sheet generation.

## Scoring chain backend — chest, attendance, judge scoring (July 2026)
Rewrote the day-of + judge-scoring backend against the REAL schema (all three
were schema-broken). No migration. Bare scoring for now (NO criteria-confirm
gate, NO live ranking — deferred).
- admin.chest.routes.js (was using non-existent chest_numbers/mode/assigned_by/
  children/time_slots/attendance table). Now uses chest_assignments
  (chest_number, allocation_mode 'auto'|'timeslot'|'manual', allocated_by/at,
  UNIQUE(event_id,chest_number), registration_id UNIQUE) and event_time_slots.
  ATTENDANCE folded in: no attendance table — uses registrations.status enum
  ('attended'|'absent') + attendance_marked_by/at. Endpoints:
  GET /:event_id/roster (each entry: name, age_group, status, chest_number),
  GET /:event_id (chest list), POST /:event_id/attendance {registration_id,
  present}, POST /:event_id/assign-auto (random chests to attended w/o chest),
  POST /:event_id/assign-timeslot (lot draw per event_time_slot, continuous
  numbering), PUT /manual/:reg_id (Chairman/SuperAdmin, 23505→409),
  DELETE /:event_id (clear, Chairman/SuperAdmin). markRoles = SA/Admin/Coord/
  Chairman. year_id pulled from the event for the NOT-NULL column.
- judge.routes.js (was using scores.score/judge_id/assignment_id, criteria/
  chest_numbers tables, criteria_confirmed_at). Now: requireType('judge'),
  GET /events (assigned events + participant_count from v_judge_scoring_board +
  scored_count), GET /sheet/:assignment_id (event, criteria from event_criteria
  as {id,label,max_score}, participants CHEST-ONLY from v_judge_scoring_board,
  this judge's existing scores), POST /scores/:assignment_id (validates
  criterion∈event + reg∈board + 0..max, upserts scores by
  (judge_assignment_id,registration_id,criterion_id), txn). CHAIN: mark
  attendance → assign chests → v_judge_scoring_board populates → judge sheet.
- STILL BROKEN (not this slice, same class of bug — chest_numbers / s.score /
  s.assignment_id / s.judge_id): admin.judging.routes.js (scoring calc/
  divergence/results), admin.results.routes.js, admin.reports.routes.js,
  admin.tiebreaker.routes.js, services/ranking.js, and auth.routes.js:91
  (`FROM children` parent-login path). Fix when those modules are built.
- Verified: all three rewritten files node -c + module load OK.
- TODO next: frontend — admin attendance/chest day-of UI + judge mobile scoring
  UI (OTP login → events → chest sheet → enter scores).

## Judging section restructure (July 2026)
Judging is now its own nav GROUP restricted to Chairman + SuperAdmin (separate
access level). The Event-judges table was removed from the Schedule page (too
long with 100+ events) and became a dedicated page.
- Sidebar.jsx: expandable "Judging" group (NavGroup, default open) — children
  Judges (/admin/judging/judges), Event assignment (/admin/judging/assignment),
  Results (Soon). Group hidden unless user.role is SuperAdmin/Chairman.
- App.jsx: routes /admin/judging/judges + /admin/judging/assignment both
  <ProtectedRoute allowedRoles={['SuperAdmin','Chairman']}> (ProtectedRoute
  already supports allowedRoles). /admin/judges → redirect to the new judges
  route. Removed <EventJudges> from Schedule.jsx.
- Backend admin.judges.routes.js: staffRoles/assignRoles tightened to
  ['SuperAdmin','Chairman'] — the whole judges API is now Chairman/SuperAdmin.
- Assignment page (src/pages/judging/Assignment.jsx) = per-EVENT rows with
  SUMMARY columns: Date | Time (first_start +N sessions) | Venue(s) | Event
  (+category, N/3 badge) | Ages | Entries | Judge 1/2/3 | Assign + OTP.
  /event-assignments query extended: to_char(MIN(start_time)) first_start,
  COUNT(DISTINCT s.id) session_count, string_agg(DISTINCT venue) venues,
  string_agg(DISTINCT age_groups,' | ') age_groups, and a subquery entries
  = registrations for the event (excl. withdrawn/swapped). Same 3 judges cover
  all of an event's sessions (per-event model kept; no schema change).
- ORPHANED: src/pages/schedule/EventJudges.jsx is no longer imported (its logic
  moved into judging/Assignment.jsx). Could not delete from the sandbox (mount
  blocks rm) — remove with `git rm frontend/src/pages/schedule/EventJudges.jsx`.
- Verified: all changed files parse (esbuild) + backend module loads.

## Event-level judge assignment (July 2026)
Moved judge ASSIGNMENT out of the Judges page and onto the Schedule page
(assignment is per event; profiles stay on the Judges page). No migration.
- Backend admin.judges.routes.js added:
  * GET /candidates/:eventId — judges whose expertise includes the event's
    category code (STRICT), each with assigned/has_phone/is_blacklisted flags.
  * GET /event-assignments — one row per scheduled event, earliest date first,
    each with its assigned judges [{assignment_id, judge_id, full_name,
    has_phone, is_blacklisted}] (two queries merged in JS to avoid the
    schedule×assignment cross-product). Carries category_code/name + published.
  * POST /event/:eventId/send-otps — OTP ALL assigned judges at once
    (createOtp+sendWhatsApp, stamps otp_sent_at/by), returns {sent, skipped,
    total}; skipped = judges with no phone.
  (assign/unassign/:id endpoints unchanged and reused.)
- Frontend:
  * Judges.jsx SLIMMED to profiles-only — removed the AssignPanel, Events
    column, expand, per-judge OTP button, and scheduleEvents load. Now:
    Judge | Expertise | Contact | Status | Edit/Blacklist/Delete.
  * NEW src/pages/schedule/EventJudges.jsx — table (one row per event, earliest
    first): Date | Event | Category | Judge 1/2/3 | Assign + OTP. Assign opens a
    ConfirmDialog listing strict expertise-match candidates (checkboxes; merges
    in any already-assigned off-category judge so it can be removed); Save diffs
    selected vs current → assign new / unassign dropped (handles blacklist
    chairman_confirmed via window.confirm). OTP button sends the event's
    briefing OTPs. Rendered on Schedule.jsx below the schedule grid.
  * client.js judgesApi: candidates, eventAssignments, sendEventOtps added;
    scheduleEvents kept but no longer used by the Judges page.
- Verified: backend node -c + module load; all frontend files parse via esbuild.

## Judges module — foundation slice DONE (July 2026)
Rewrote admin.judges.routes.js (was schema-mismatched: used j.name, ja.status,
ja.year_id, otp on wrong table) against the REAL schema and built the admin
Judges page. No migration needed — all columns already existed.
- Backend admin.judges.routes.js (mounted /api/admin/judges):
  GET / (list + assignment_count; contact fields phone/whatsapp/email ONLY for
  SuperAdmin/Chairman per rule #11, others get has_contact bool),
  GET /blacklist-report, GET /:id/full (contact, audited VIEW_JUDGE_CONTACT),
  GET /:id/assignments, POST / (full_name required), PUT /:id, DELETE /:id
  (refuses if judge has assignments — blacklist instead), POST /:id/blacklist
  (reason required, sets blacklisted_by + blacklist_date=CURRENT_DATE),
  POST /:id/unblacklist, POST /:id/send-otp (manual at briefing rule #12 —
  createOtp+sendWhatsApp, stamps judges.otp_sent_at/otp_sent_by),
  POST /assign (judge_assignments: judge_id/event_id/time_slot_id/assigned_by;
  blacklisted judge needs chairman_confirmed=true; 23505 → already assigned;
  returns event_judge_count + 3-per-event note), DELETE /assign/:assignmentId
  (refuses if scores exist for it), GET /event/:eventId (judges on an event).
- Role sets: manageRoles=[SuperAdmin,Chairman] (create/edit/blacklist/delete),
  assignRoles adds Admin+Coordinator (assign/OTP), staffRoles read.
- FIX auth.routes.js verify-otp: SELECT id, name → full_name (judges has no
  `name` column); token judge label now judge.full_name.
- Frontend: judgesApi in client.js; new src/pages/Judges.jsx (table + Drawer
  add/edit + ConfirmDialog blacklist/delete + inline AssignPanel per judge with
  event dropdown from eventsApi.list). Route /admin/judges in App.jsx; Sidebar
  "Judges" flipped active. Contact column shows "restricted" when has_contact
  but fields omitted for the role.
- Verified: backend node -c + module load OK; all frontend files parse via
  esbuild (Vite build still can't run in sandbox — Windows-only rolldown binary).
- STILL PENDING (later slices): judge.routes.js (judge scoring flow) and
  admin.judging.routes.js (calculation/divergence/results) remain schema-
  mismatched and must be rewritten before the scoring + results UIs. No judge
  mobile scoring UI yet.

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
## Tiebreaker resolution (rule #8) — deferred item #2 (done)
When a **prize-position** placement tie cannot be broken by the criteria order
(same rank-sum AND identical C1..Cn totals), it needs the rule #8 tiebreaker.

**Model (matches base schema):** Chairman **unlocks** a session (records who
authorised — DB trigger `fn_check_tiebreaker_unlock` rejects any unlock whose
owner isn't a Chairman), each judge gives every tied chest a **1–10 mark**, and
an Admin **keys them in**. Higher **mark total** wins the higher place. Tables
already existed in `db/schema.sql` (`tiebreaker_unlocks`, `tiebreaker_marks`) —
**no migration** needed.

**Backend** `admin.judging.routes.js`:
- `tiebreakMarkSums(eventId)` — per participant, sum of judges' **latest** marks
  (take `MAX(unlock_id)` per (reg,judge) so a re-run supersedes old marks).
- `computeGroup` — sort tiebreak chain is now `rankSum asc → critTotals desc →
  tbMark desc`. Detects **unresolved exact ties**: cluster keyed by
  `rankSum|critTotals|tbMark`; `needs_tiebreak` when the cluster's min index is
  inside a prize place (`< maxPlaces`). Returns `judge_meta [{judge_id,name}]`,
  `tiebreak_needed`, and per-row `exact_tie / needs_tiebreak / mark_sum`.
- `POST /results/:e/:ag/tiebreak/unlock` — **Chairman only** (403 otherwise),
  blocked if published; inserts `tiebreaker_unlocks` → `{unlock_id}`.
- `POST /results/:e/:ag/tiebreak/marks` — validates session open + marks 1–10,
  upserts `tiebreaker_marks` (`approved_by_chairman` = session's `unlocked_by`,
  `entered_by` = current user), then **locks** the session. Re-doing = new unlock.
- `finalise` now also blocks on `tiebreak_needed` (alongside the divergence gate).

**Frontend** `Results.jsx`: `showTiebreak = complete && tiebreak_needed` gates a
red banner + "tie to resolve" badge + row highlight + `tiebreak` flag chip. A
`TiebreakModal` (Chairman-only "Resolve tie" button) shows a tied-chest × judge
1–10 grid; Save calls `tiebreakUnlock` then `tiebreakMarks` and reloads.
`resultsApi.tiebreakUnlock/tiebreakMarks` added to `api/client.js`.

Deferred judging items remaining: 3) Prize-eligibility rules, 4) Extra/consolation prizes.

## Prize-eligibility (two-tier) — deferred item #3 (done)
Uses the two existing `year_config` columns (no new migration):
`no_prize_below` (default 3) and `min_entries_threshold` (default 5).

**Rule (user-chosen "two-tier"):** by the group's attended entry count `n`:
- `n < no_prize_below` → **no prizes** (all `place = null`; participants still get
  grade + participation points).
- `no_prize_below ≤ n < min_entries_threshold` → **1st & 2nd only** (prizeCap 2).
- `n ≥ min_entries_threshold` → **full 1st/2nd/3rd** (prizeCap 3).

**Backend** `admin.judging.routes.js`:
- `activeCfg()` now also selects `no_prize_below, min_entries_threshold`.
- `computeGroup` derives `prizeCap` → `maxPlaces = min(prizeCap, n)`, which drives
  both `place` assignment and the rule #8 `needsTiebreak` prize-position test.
- Response adds `prize_cap`, `no_prize_below`, `min_entries_threshold`.

**Frontend** `Results.jsx`: badges "no prizes · n < 3" / "1st & 2nd only · n < 5",
and a footer sentence explaining the thresholds.

NOTE: the live results path is `admin.judging.routes.js` (`computeGroup`). The pure
`services/ranking.js` module is reference/unit-test code (floor-only prize model)
and is NOT wired to the routes — left unchanged so its tests still pass.

Deferred judging items remaining: 4) Extra/consolation prizes (rule #14).

## Extra / consolation prizes (rule #14) — deferred item #4 (done)
A Chairman-only "4th place" additional/consolation prize, addable only BEFORE
Stage 2 (publish) and carrying NO rank points. Schema already had the columns
(`extra_prize_type IN ('additional_3rd','consolation')`, `extra_prize_approved_by`)
and the guard trigger `fn_check_extra_prize_window` — no migration.

**Backend** `admin.judging.routes.js`:
- GET results now merges `extra_prize_type` from `event_results` into each row.
- `POST /results/:e/:ag/extra-prize` — **Chairman only** (403 otherwise); blocked
  once published; refuses if the chest already holds a main `prize_place`.
  Upserts `event_results`, setting `extra_prize_type` + `extra_prize_approved_by`
  (approver nulled when the type is cleared to satisfy the CHECK). Pass
  `extra_prize_type: null` to remove. Audited AWARD/REMOVE_EXTRA_PRIZE.

**Frontend** `Results.jsx`: new **Extra** column. For Chairman + not-published +
non-winner rows it's a dropdown (— / Add'l 3rd / Consolation); otherwise a chip
or —. `resultsApi.setExtraPrize` added.

All four deferred judging items are now complete (divergence review, tiebreaker,
prize-eligibility, extra/consolation prizes).

## Printable result sheet + PWA (public + participant)
### Printable result sheet (browser print)
- Backend `admin.judging.routes.js`: `GET /results/:e/:ag/sheet` (Chairman/SuperAdmin)
  returns branding (year label + logos), event meta, judges, and the FULL ranked
  list WITH participant names + school, grades, points, and extra/consolation
  prizes. (Names are OK here — this is the internal signed record, not the judge
  portal.) `resultsApi.sheet` added.
- Frontend `pages/judging/ResultSheet.jsx` at route
  `/admin/judging/results/print/:eventId/:ageGroupId` — branded, print-optimised
  page (KCA + sponsor logos, ranked table, judges' + Chairman signature lines,
  PROVISIONAL/FINALISED/PUBLISHED status). Toolbar hidden on print via `@media print`.
  Opened from a "Print sheet" button on the Results page (same tab → keeps token).

### PWA — public board + participant app
- **Stale scaffolding fixed:** `pwa.routes.js` and `auth.routes.js` `pwa-login` were
  written against a non-existent `children`/`results`/`schedule_draft` schema.
  Rewrote both against the real schema:
  - `pwa-login` now matches `participants` (first 4 of full_name + last 4 of
    cpr_number) within the ACTIVE year; token carries `participantId`.
  - `GET /api/pwa/my-schedule` and `/my-results` use `registrations.participant_id`,
    `event_results`, `schedule`, `event_time_slots`. No chest numbers (rule #22).
- `public.routes.js`: added `GET /api/public/year` (active-year branding + id);
  `/notices` now tolerates a missing `notices` table (returns [] on 42P01).
  `/results` shows chest + name (per user's choice for the public board).
- Frontend:
  - `context/PwaAuthContext.jsx` (sessionStorage keys `its_pwa_token`/`its_pwa_participant`).
  - `pages/pwa/PublicBoard.jsx` (route `/pwa`, no login) — tabs Results / Schedule /
    Awards, branded header, link to participant login.
  - `pages/pwa/PwaLogin.jsx` (`/pwa/login`) — 4-letter name + 4-digit CPR.
  - `pages/pwa/MyPortal.jsx` (`/pwa/me`, PwaRoute-guarded) — My Results (grade/points
    + running totals) + My Schedule.
  - `publicApi` + `pwaApi` added to `api/client.js`; `App.jsx` wraps `PwaAuthProvider`
    and adds the routes.
- NOTE: `npm run build` can't run in the Linux sandbox (vite/rolldown ships a
  Windows-only native binding); verified every changed file with `esbuild` transform
  + backend `node -c`. Run `npm run build` on Windows before deploy.
- Legacy `admin.results.routes.js` (event-level finalise/publish/print-pdf) is
  partly shadowed by `admin.judging.routes.js` and unused by the frontend — left as-is.

## Deployment for testing (Render, single-origin)
- `backend/src/index.js` now serves `frontend/dist` (SPA fallback) when present →
  the whole app is ONE origin/URL (no CORS/two-server split). CORS also accepts
  extra origins via `CORS_ORIGINS`/`FRONTEND_URL` env for split deploys.
- `frontend/src/api/client.js`: `API_BASE` = VITE_API_BASE_URL ?? (DEV? localhost:4000 : '')
  so a production build talks to its own origin; dev unchanged.
- `backend/package.json`: added `start` (node src/index.js) and `migrate` scripts.
- `render.yaml` blueprint: free Postgres `its-db` + free web service `its-app`
  (frankfurt), build = frontend build + backend install, start = `npm start`,
  JWT_SECRET generateValue, JUDGE_OTP_BYPASS=true, DB_* injected fromDatabase,
  DB_SSL=true. Deploys branch `feature/step-5-registrations`.
- Guides: `DEPLOY-RENDER.md` (Leo: git push → Blueprint → pg_dump local `its_app`
  → psql restore to Render external URL) and `TESTER-GUIDE.md` (fill-in-the-blank
  URLs/logins one-pager for a non-technical tester).
- GIT STATE at handoff: branch feature/step-5-registrations, working tree clean,
  **55 commits unpushed** + today's deploy changes uncommitted → user must
  `del .git\index.lock`, `git add -A && git commit && git push`.

## Awards, Notices, Finance modules (post-deploy build)
### Awards (rules #15/#16/#24) — Chairman/SuperAdmin
- `admin.awards.routes.js` REWRITTEN against real schema (old one used phantom
  awards/children/results tables). Now reads the existing views
  `v_school_award_totals` + `v_group_championship` (both aggregate FINALISED
  results). `GET /:year_id/standings` (year_id may be 'active'), `GET /:year_id/export` (CSV).
- Frontend `pages/Awards.jsx` at `/admin/awards`: school standings + group
  championship (champion = top school per age group) + CSV export.
- `awardsApi` in client.js.

### Notices — public announcements
- NEW migration `022_notices.sql` (notices table: year_id,title,body,is_active,posted_by,posted_at).
- NEW `admin.notices.routes.js` mounted `/api/admin/notices` (CRUD; edit roles
  SuperAdmin/Admin/Chairman). `public.routes` `/notices` already reads it (and is
  42P01-tolerant).
- Frontend `pages/Notices.jsx` at `/admin/notices` (post/hide/delete). Public
  board `PublicBoard.jsx` shows active notices as a gold banner above the tabs.
- `noticesApi` in client.js.

### Finance — income & expenses
- NEW migration `023_finance.sql` (finance_expense_heads, finance_income,
  finance_expenses). The backend `admin.finance.routes.js` already existed and is
  complete — it only lacked tables.
- Frontend `pages/Finance.jsx` at `/admin/finance`: summary (income/expenses/net),
  income CRUD, expense CRUD + expense-head management. Uses active year id from
  `yearConfigApi.get`. `financeApi` in client.js.

- `Sidebar.jsx`: Awards + Finance activated, Notices added, with per-item role
  filtering. `App.jsx`: routes added with allowedRoles.

### MIGRATIONS TO RUN (022, 023) — on BOTH local and the Render cloud DB
Cloud (from C:\ITS-APP, paste External URL):
  psql "<EXTERNAL_URL>" -f db\migrations\022_notices.sql
  psql "<EXTERNAL_URL>" -f db\migrations\023_finance.sql
Local: cd backend && npm run migrate  (runs all pending against .env DB)
Verified: node -c (backend) + esbuild transform (all new frontend files). Full
vite build still can't run in the Linux sandbox — Render builds it on deploy.
