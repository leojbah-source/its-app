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

## Other Tables (not yet implemented)
`registrations, participants, judges, judge_assignments, scores, schedule,
schools, teams, team_members, chest_assignments, event_time_slots,
event_swap_requests, notices, tiebreaker_marks, tiebreaker_unlocks,
timer_assignments, event_results, membership_verifications`

Views: `v_group_championship, v_judge_scoring_board, v_judges_public, v_school_award_totals`

---

## What's Done
- [x] Auth (login, JWT, roles: SuperAdmin, Admin, Coordinator, Chairman, Viewer)
- [x] Year Setup (year_config CRUD, age groups, branding logos, grade/rank config)
- [x] Events (CRUD, criteria, age groups, categories)

## What's Next
- [ ] Registrations
- [ ] Judges
- [ ] Schedule
- [ ] Awards
- [ ] Finance
