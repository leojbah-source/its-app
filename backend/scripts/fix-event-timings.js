// backend/scripts/fix-event-timings.js
// One-off review/fix of event timing settings for the active year.
//
//   node scripts/fix-event-timings.js          (applies the fixes)
//   node scripts/fix-event-timings.js --dry    (report only)
//
// Semantics (used by the scheduler):
//   STAGE events  (is_stage_event = TRUE):  allotted_time_seconds is the
//     time PER PARTICIPANT (performances run one after another).
//   SEATED events (is_stage_event = FALSE): allotted_time_seconds is the
//     TOTAL SITTING TIME — all participants work simultaneously and are
//     given 60 or 90 minutes to complete the task.
//
// What this script does:
//   1. Seated reclassification: 'Spelling Bee' & similar written/desk events
//      flagged as stage are flipped to seated.
//   2. Seated sittings: sets 90 min for art/craft/essay tasks, 60 min for
//      shorter written tasks — ONLY where the current value is missing or
//      looks like a per-participant figure (< 30 min).
//   3. Stage defaults where missing: 180 s per participant (individual),
//      600 s (team); grace 30 s, yellow alert 60 s.
// Everything printed as a before → after table; adjust individual events
// afterwards in the Events editor (or via CSV export/import).

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const DRY = process.argv.includes('--dry');

// name → seated sitting minutes
const SEATED_90 = /draw|paint|clay|collage|craft|carving|flower|essay/i;
const SEATED_60 = /caption|poem writ|writing|handwrit|spelling|general knowledge|intelligence|sudoku|quiz|puzzle|memory test \(written\)/i;
// events wrongly marked stage that are actually seated desk tasks
const FORCE_SEATED = /spelling bee/i;

(async () => {
  const c = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  const { rows: yc } = await c.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  if (!yc[0]) throw new Error('No active year');

  const { rows } = await c.query(
    `SELECT id, event_code, event_name, event_kind, is_stage_event,
            allotted_time_seconds, grace_period_seconds, yellow_alert_seconds
     FROM events WHERE year_id = $1 AND is_cancelled = FALSE
     ORDER BY event_code`, [yc[0].id]);

  const changes = [];
  for (const e of rows) {
    const patch = {};
    let stage = e.is_stage_event;

    if (stage && FORCE_SEATED.test(e.event_name)) {
      patch.is_stage_event = false;
      stage = false;
    }

    if (!stage) {
      // seated: total sitting time
      const target = SEATED_90.test(e.event_name) ? 5400
        : SEATED_60.test(e.event_name) ? 3600
        : 3600; // any other seated event: 60 min default
      const cur = e.allotted_time_seconds;
      if (cur == null || cur < 1800) patch.allotted_time_seconds = target;
    } else {
      // stage: per participant
      if (e.allotted_time_seconds == null)
        patch.allotted_time_seconds = e.event_kind === 'team' ? 600 : 180;
      if (e.grace_period_seconds == null) patch.grace_period_seconds = 30;
      if (e.yellow_alert_seconds == null) patch.yellow_alert_seconds = 60;
    }

    if (Object.keys(patch).length) changes.push({ e, patch });
  }

  console.log(`${rows.length} events checked — ${changes.length} need changes${DRY ? ' (DRY RUN)' : ''}:\n`);
  const mins = (s) => (s == null ? '—' : `${Math.round(s / 60)}m`);
  for (const { e, patch } of changes) {
    const bits = [];
    if ('is_stage_event' in patch) bits.push(`stage TRUE → FALSE (seated)`);
    if ('allotted_time_seconds' in patch)
      bits.push(`allotted ${mins(e.allotted_time_seconds)} → ${mins(patch.allotted_time_seconds)}` +
        (patch.is_stage_event === false || !e.is_stage_event || 'is_stage_event' in patch
          ? ' total sitting' : '/participant'));
    if ('grace_period_seconds' in patch) bits.push('grace → 30s');
    if ('yellow_alert_seconds' in patch) bits.push('yellow → 60s');
    console.log(`  ${e.event_code}  ${e.event_name.padEnd(42).slice(0, 42)} ${bits.join(' · ')}`);
    if (!DRY) {
      const sets = [], vals = [];
      for (const [k, v] of Object.entries(patch)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
      vals.push(e.id);
      await c.query(`UPDATE events SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length}`, vals);
    }
  }
  console.log(DRY ? '\nDry run — nothing changed. Run without --dry to apply.'
                  : '\nApplied. Review individual events in the Events editor, then regenerate the schedule draft.');
  await c.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
