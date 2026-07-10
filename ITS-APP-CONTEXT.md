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

## Other Tables (in schema, routes exist, UI mostly pending)
`judges, judge_assignments, scores, schedule, chest_assignments,
event_time_slots, event_swap_requests, notices, tiebreaker_marks,
tiebreaker_unlocks, timer_assignments, event_results, membership_verifications`

Views: `v_group_championship, v_judge_scoring_board, v_judges_public, v_school_award_totals`

---

## What's Done
- [x] Auth (login, JWT, roles: SuperAdmin, Admin, Coordinator, Chairman, Viewer)
- [x] Year Setup (year_config CRUD, age groups, branding logos, grade/rank config)
- [x] Events (CRUD, criteria, age groups, categories)
- [x] Registrations (parent portal + admin dashboard)
- [x] Fees & payments backend (fee calc w/ member rate, parent payment submission,
      admin confirm/reject, refunds w/ mandatory reason, refunds report CSV)
- [x] Finance ledger backend (income/expenses/expense-heads + migration 001)
- [x] Membership verify route fixed (correct verifyMembership signature; sets
      participants.membership_status: active|pending|none)

## What's Done (cont.)
- [x] Parent payment UI (PaymentSection.jsx: live fee table, balance, payment
      submission w/ proof upload via POST /api/register/upload)

## What's Next
- [ ] Admin UI: Payments & Refunds, Judges, Schedule, Awards, Finance, Chest numbers
- [ ] Set per-event fees in Events admin page (fee_amount / member_fee_amount)
- [ ] Judging module: REWRITE admin.judging.routes.js against real schema (see WARNING),
      filter is_void, then judge mobile scoring UI
- [ ] Addendum 1: /api/timer/* + admin timing/DQ routes, Timer stopwatch UI,
      Timing & DQ admin tab, judge DQ banner, PWA DQ display
- [ ] PWA (Step 6)
