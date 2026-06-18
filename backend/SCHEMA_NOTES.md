# KCA ITS - Assumed Database Schema (reference for backend routes)

This block (2b) builds REST routes only. The tables below are the working
assumption used consistently across every route/service file so the SQL is
internally coherent. If block 2a (schema/migrations) already defines
different column names, rename in one pass - all queries are isolated inside
`src/routes/*.js` and `src/services/*.js`.

users(id, email, password_hash, name, role, created_at)
  role ∈ SuperAdmin | Admin | Coordinator | Chairman | Viewer

year_config(year_id, year_label, age_group_config jsonb, grade_config jsonb,
  rank_points_config jsonb, participation_bonus_pts numeric,
  divergence_threshold_pct numeric, teacher_name_deadline timestamptz,
  kca_logo_url text, sponsor_logo_url text, status text, created_at)
  status ∈ draft | published | frozen | archived

events(id, year_id, name, category, age_group, type, max_participants,
  is_team_event boolean, status, created_at)

time_slots(id, event_id, slot_label, start_time, end_time, capacity)

schedule_draft(id, year_id, event_id, time_slot_id, venue, placement_order,
  status, published_at)

children(id, parent_user_id, name, dob, cpr_number, age_group, school,
  gender, photo_url, created_at)

teams(id, year_id, event_id, team_name, school, created_at)
team_members(id, team_id, child_id, confirmed boolean)

registrations(id, year_id, child_id, team_id, event_id, status,
  teacher_name, fee, created_at)

payments(id, registration_id, amount, method, status, transaction_ref,
  confirmed_by, confirmed_at, created_at)

refund_log(id, registration_id, amount, reason, status, processed_by,
  processed_at, created_at)

judges(id, name, bio, phone, whatsapp, email, is_blacklisted,
  blacklist_reason, blacklist_date, created_at)

judge_assignments(id, year_id, event_id, judge_id, status,
  criteria_confirmed_at, otp_sent_at, created_at)

chest_numbers(id, event_id, registration_id, chest_number, mode,
  assigned_by, assigned_at)

attendance(id, event_id, registration_id, present, joined_at, marked_by,
  marked_at)

criteria(id, event_id, name, max_score, sort_order)

scores(id, assignment_id, judge_id, registration_id, criterion_id, score,
  created_at, updated_at)

results(id, event_id, registration_id, rank, grade, rank_points,
  grade_points, is_published, finalised_at, published_at)

tiebreaker_marks(id, event_id, sub_group, judge_id, registration_id, mark,
  created_at)

judge_flags(id, assignment_id, judge_id, statement, created_at,
  resolved_at, resolved_by)

extra_prizes(id, event_id, registration_id, type, reason, created_by,
  created_at)

awards(id, year_id, type, scope, winner_ref, label, points, created_at)

finance_income(id, year_id, source, amount, date, notes, created_by)
finance_expenses(id, year_id, expense_head_id, amount, date, vendor, notes,
  created_by)
finance_expense_heads(id, year_id, name)

notices(id, year_id, title, body, published_at, created_by)

audit_log(id, actor_id, actor_role, action, entity, entity_id, details jsonb,
  created_at)  -- INSERT ONLY, never UPDATE/DELETE (rule #25)
