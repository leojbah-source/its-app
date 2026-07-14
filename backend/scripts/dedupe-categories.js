// backend/scripts/dedupe-categories.js
// One-off cleanup: the active year has TWO parallel category sets —
//   KEEP  (canonical, from seed):  NATYA / SANGEET / KALA / SAHITYA / ADDON / TEAM
//                                  ("Natya Ratna (Dance Events)", etc.)
//   DROP  (older short duplicates): NAT / SAN / KAL / SAH / ADD  (+ any stray
//                                  "Team Event")  — "Natya", "Sangeeta", etc.
//
//   node scripts/dedupe-categories.js --dry   (report only — DO THIS FIRST)
//   node scripts/dedupe-categories.js         (re-point any events, then delete)
//
// Safe by design:
//   1. Never deletes a category that still has events — it first RE-POINTS those
//      events (and their event_age_groups stay intact, they hang off event_id)
//      to the matching KEEP category, then deletes the now-empty duplicate.
//   2. Matches duplicates to their KEEP counterpart by a name/code map, so a
//      dance duplicate can only ever move to the dance KEEP category.
//   3. Refuses to run if a KEEP category is missing (nothing to move events to).
//   4. Everything in ONE transaction: all-or-nothing.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client } = require('pg');

const DRY = process.argv.includes('--dry');

// KEEP code  ->  regexes that identify its DUPLICATE(s) by code or name.
// (case-insensitive; the duplicate is whatever is NOT the canonical KEEP row)
const KEEP = {
  NATYA:   { codes: ['NAT'],  name: /natya/i,            keepName: /ratna/i },
  SANGEET: { codes: ['SAN'],  name: /sangeet|sangeeta/i, keepName: /ratna/i },
  KALA:    { codes: ['KAL'],  name: /kala/i,             keepName: /ratna/i },
  SAHITYA: { codes: ['SAH'],  name: /sahitya/i,          keepName: /ratna/i },
  ADDON:   { codes: ['ADD'],  name: /add.?on/i,          keepName: /events/i },
  TEAM:    { codes: [],       name: /team/i,             keepName: /events$/i }, // "Team Events" kept; "Team Event" dropped
};

(async () => {
  const c = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  try {
    const { rows: yc } = await c.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!yc[0]) throw new Error('No active year');
    const yearId = yc[0].id;

    const { rows: cats } = await c.query(
      `SELECT c.id, c.code, c.name, c.sort_order,
              (SELECT COUNT(*)::int FROM events e WHERE e.category_id = c.id) AS event_count
       FROM categories c WHERE c.year_id = $1 ORDER BY c.sort_order, c.id`, [yearId]);

    console.log(`Active year ${yearId} — ${cats.length} categories:\n`);
    for (const c2 of cats)
      console.log(`  #${String(c2.id).padEnd(4)} ${String(c2.code).padEnd(9)} ${c2.name.padEnd(34)} events=${c2.event_count}`);
    console.log('');

    const plan = [];   // { dropId, dropName, keepId, keepName, moveEvents }
    const problems = [];

    for (const [keepCode, rule] of Object.entries(KEEP)) {
      // KEEP category = the canonical row for this code.
      const keep = cats.find((c2) => c2.code === keepCode)
        || cats.find((c2) => rule.name.test(c2.name) && rule.keepName.test(c2.name));
      // DUPLICATE candidates: same family by name, but NOT the keep row.
      const dups = cats.filter((c2) =>
        c2 !== keep &&
        (rule.codes.includes(c2.code) || (rule.name.test(c2.name) && !rule.keepName.test(c2.name))));

      if (!dups.length) continue;
      if (!keep) {
        problems.push(`No KEEP category for ${keepCode} — refusing to move ${dups.map((d) => d.name).join(', ')}`);
        continue;
      }
      for (const d of dups)
        plan.push({ dropId: d.id, dropCode: d.code, dropName: d.name,
                    keepId: keep.id, keepName: keep.name, moveEvents: d.event_count });
    }

    if (problems.length) {
      console.log('BLOCKERS (nothing will be changed):');
      problems.forEach((p) => console.log('  ! ' + p));
      throw new Error('Resolve blockers first.');
    }
    if (!plan.length) { console.log('No duplicate categories found — nothing to do.'); return; }

    console.log(`Plan (${plan.length} duplicate categor${plan.length === 1 ? 'y' : 'ies'} to remove):\n`);
    for (const p of plan)
      console.log(`  DROP #${p.dropId} "${p.dropName}" [${p.dropCode}]` +
        (p.moveEvents ? `  →  move ${p.moveEvents} event(s) to #${p.keepId} "${p.keepName}"` : `  (no events)`));
    console.log('');

    if (DRY) { console.log('DRY RUN — nothing changed. Run without --dry to apply.'); return; }

    await c.query('BEGIN');
    for (const p of plan) {
      if (p.moveEvents) {
        await c.query(`UPDATE events SET category_id = $1, updated_at = NOW() WHERE category_id = $2`,
          [p.keepId, p.dropId]);
      }
      await c.query(`DELETE FROM categories WHERE id = $1`, [p.dropId]);
    }
    await c.query('COMMIT');
    console.log('Applied. Duplicate categories removed; any events re-pointed to the KEEP category.');
    console.log('Refresh the Schedule page — the category-dates list will now show one row per category.');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => null);
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
