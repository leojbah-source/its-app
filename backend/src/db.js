// src/db.js
// Central PostgreSQL connection pool (pg). Imported by every route/service
// that needs to talk to the database.
//
// SCHEMA ASSUMPTIONS (see /home/claude/backend/SCHEMA_NOTES.md for the full
// list) - these table names are used consistently across all route files:
//   users, year_config, events, time_slots, schedule_draft, children, teams,
//   team_members, registrations, payments, refund_log, judges,
//   judge_assignments, chest_numbers, attendance, criteria, scores, results,
//   tiebreaker_marks, judge_flags, extra_prizes, awards, finance_income,
//   finance_expenses, finance_expense_heads, notices, audit_log (insert-only)

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10,
});

pool.on('error', (err) => {
  // Idle client errors should not crash the process
  console.error('Unexpected PG pool error', err);
});

module.exports = pool;
