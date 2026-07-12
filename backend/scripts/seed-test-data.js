// backend/scripts/seed-test-data.js
// Seeds realistic test data from db/testdata/2025-data-part.csv (2025 season).
//
//   node scripts/seed-test-data.js            (uses backend/.env)
//
// What it does, in order:
//   1. WIPES all participant-domain data (participants, registrations,
//      payments, refunds, teams, schedule, scores, results, timings …).
//      Users / events / year config / venues are kept.
//   2. Builds the schools list from the CSV.
//   3. Creates one parent account per CONTACT NUMBER (same number = same
//      parent; first email/name wins). Password for every parent: test1234
//   4. Creates participants; age group is re-derived from DOB by the DB
//      trigger against the CURRENT age-group settings. Placeholder CPR scan
//      + photo URLs are set (assumed uploaded).
//   5. Registers events, matching 2025 names to current events (dash/spelling
//      variants normalised). Registrations whose event is not offered for the
//      participant's NEW age group (or fails the gender split) are DROPPED
//      and reported.
//   6. Records each participant's CSV payment as a CONFIRMED cash payment.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { Client } = require('pg');

const CSV_PATH = path.join(__dirname, '..', '..', 'db', 'testdata', '2025-data-part.csv');
const PARENT_PASSWORD = 'test1234';

// ── tiny CSV parser (quotes, CRLF) ───────────────────────────────────────────
function parseCsv(text) {
  const src = text.replace(/^﻿/, '');
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i+1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i+1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c !== '')) rows.push(row); row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const norm = (s) => String(s || '').toLowerCase()
  .replace(/modelling/g, 'modeling')          // spelling variants
  .replace(/[^a-z0-9]/g, '');                  // dashes/en-dashes/spaces/dots

const ddmmyyyy = (s) => {
  const m = String(s).trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};

(async () => {
  const client = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  console.log(`Connected to ${process.env.DB_NAME}`);

  const { rows: yc } = await client.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
  if (!yc[0]) throw new Error('No active year_config');
  const yearId = yc[0].id;

  // ── 1. wipe participant-domain data ────────────────────────────────────────
  console.log('Wiping existing participant test data…');
  const wipe = [
    'scores', 'tiebreaker_marks', 'tiebreaker_unlocks', 'event_results',
    'participant_timings', 'chest_assignments', 'event_swap_requests',
    'schedule', 'refunds', 'team_documents', 'team_members',
    'registrations', 'payments', 'membership_verifications', 'teams',
    'participants',
  ];
  for (const t of wipe) {
    try { const r = await client.query(`DELETE FROM ${t}`); if (r.rowCount) console.log(`  ${t}: ${r.rowCount} removed`); }
    catch (e) { console.log(`  ${t}: skipped (${e.message.split('\n')[0]})`); }
  }

  // ── read CSV ────────────────────────────────────────────────────────────────
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const hdr = rows[0];
  const col = (name) => hdr.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const C = {
    email: col('Email'), cpr: col('CPR Number'), dob: col('Date of Birth'),
    gender: col('Gender'), school: col('School'), parent: col('Parent Name'),
    contact: col('Contact number'), member: col('KCA Member'),
    memberNo: col('KCA Member Number'), payment: col('Payment'),
    whatsapp: col('WhatsApp'), event: col('Event'), name: col('PARTICIPANT NAME'),
  };
  const data = rows.slice(1).map((r) => ({
    email: (r[C.email] || '').trim().toLowerCase(),
    cpr: (r[C.cpr] || '').trim(),
    dob: ddmmyyyy(r[C.dob]),
    gender: /f/i.test((r[C.gender] || '').trim()[0] || '') ? 'F' : 'M',
    school: (r[C.school] || '').trim(),
    parent: (r[C.parent] || '').trim(),
    contact: (r[C.contact] || '').trim(),
    member: /^yes$/i.test((r[C.member] || '').trim()),
    memberNo: (r[C.memberNo] || '').trim(),
    payment: Number((r[C.payment] || '0').replace(/[^\d.]/g, '')) || 0,
    whatsapp: (r[C.whatsapp] || '').trim(),
    event: (r[C.event] || '').trim(),
    name: (r[C.name] || '').trim().replace(/\s+/g, ' '),
  })).filter((d) => d.cpr && d.name && d.dob);
  console.log(`CSV rows: ${data.length}`);

  // ── 2. schools ──────────────────────────────────────────────────────────────
  const schoolIds = {};
  for (const name of [...new Set(data.map((d) => d.school).filter(Boolean))].sort()) {
    const { rows } = await client.query(
      `INSERT INTO schools (name, is_active) VALUES ($1, TRUE)
       ON CONFLICT DO NOTHING RETURNING id`, [name]);
    schoolIds[name] = rows[0]?.id ??
      (await client.query(`SELECT id FROM schools WHERE name = $1`, [name])).rows[0].id;
  }
  console.log(`Schools: ${Object.keys(schoolIds).length}`);

  // ── 3. parents (grouped by contact number) ─────────────────────────────────
  const passwordHash = await bcrypt.hash(PARENT_PASSWORD, 10);
  const byContact = new Map();
  for (const d of data) if (!byContact.has(d.contact)) byContact.set(d.contact, d);
  const parentIds = {};   // contact → user id
  let parentsNew = 0;
  for (const [contact, d] of byContact) {
    const email = d.email || `parent.${contact}@test.kcabah.com`;
    const memberStatus = d.member ? 'active' : 'none';
    const { rows } = await client.query(
      `INSERT INTO users (full_name, email, phone, whatsapp_number, password_hash, role,
                          kca_member_no, membership_status, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'Viewer',$6,$7,TRUE,NOW(),NOW())
       ON CONFLICT (email) DO UPDATE SET
         phone = EXCLUDED.phone, whatsapp_number = EXCLUDED.whatsapp_number,
         kca_member_no = EXCLUDED.kca_member_no, membership_status = EXCLUDED.membership_status
       RETURNING id, (xmax = 0) AS inserted`,
      [d.parent || 'Parent', email, contact, d.whatsapp || contact,
       passwordHash, d.member && d.memberNo && d.memberNo !== 'N/A' ? d.memberNo : null, memberStatus]);
    parentIds[contact] = rows[0].id;
    if (rows[0].inserted) parentsNew++;
  }
  console.log(`Parents: ${byContact.size} (${parentsNew} new users, password '${PARENT_PASSWORD}')`);

  // ── event lookup (normalised) + age-group eligibility ──────────────────────
  const { rows: evRows } = await client.query(
    `SELECT e.id, e.event_name, e.event_code, e.fee_amount, e.member_fee_amount,
            e.gender_split, e.category_id,
            array_agg(eag.age_group_id) AS ag_ids
     FROM events e JOIN event_age_groups eag ON eag.event_id = e.id
     WHERE e.year_id = $1 AND e.is_cancelled = FALSE AND e.event_kind = 'individual'
     GROUP BY e.id`, [yearId]);
  const evByNorm = new Map();
  for (const e of evRows) evByNorm.set(norm(e.event_name), e);

  // ── 4+5. participants + registrations ──────────────────────────────────────
  const byCpr = new Map();
  for (const d of data) {
    if (!byCpr.has(d.cpr)) byCpr.set(d.cpr, { ...d, events: new Set() });
    byCpr.get(d.cpr).events.add(d.event);
  }

  let created = 0, regs = 0, droppedAge = 0, droppedGender = 0, noGroup = 0;
  const unknownEvents = new Map();
  const droppedDetail = [];

  for (const [cpr, p] of byCpr) {
    // The DB trigger fn_assign_age_group RAISES when the DOB fits no
    // configured age group — skip such participants entirely (reported),
    // instead of aborting the whole seed.
    let ins;
    try {
      ({ rows: ins } = await client.query(
        `INSERT INTO participants
           (year_id, cpr_number, full_name, dob, gender, school_id,
            guardian_name, guardian_phone, cpr_scan_url, photo_url,
            cpr_verified_method, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'manual',$11,NOW(),NOW())
         ON CONFLICT (year_id, cpr_number) DO UPDATE SET full_name = EXCLUDED.full_name
         RETURNING id, age_group_id`,
        [yearId, cpr, p.name, p.dob, p.gender, schoolIds[p.school] || null,
         p.parent || null, p.whatsapp || p.contact,
         `https://placeholder.kcabah.com/cpr/${cpr}.jpg`,
         `https://placeholder.kcabah.com/photo/${cpr}.jpg`,
         parentIds[p.contact]]));
    } catch (e) {
      if (/no age group configured/i.test(e.message)) {
        noGroup++;
        droppedDetail.push(`${p.name}: DOB ${p.dob} fits no configured age group — participant skipped`);
        continue;
      }
      throw e;
    }
    const pid = ins[0].id;
    const agId = ins[0].age_group_id;   // re-derived by trigger from DOB
    created++;
    if (!agId) { noGroup++; droppedDetail.push(`${p.name}: DOB ${p.dob} matches no current age group — all events skipped`); continue; }

    for (const evName of p.events) {
      // exact match, else the gendered/common variant of the same event
      // (2025 'English Song' → 2026 'English Song – Boys/Girls')
      const ev = evByNorm.get(norm(evName))
        || evByNorm.get(norm(evName + (p.gender === 'M' ? ' Boys' : ' Girls')))
        || evByNorm.get(norm(evName + ' Common'));
      if (!ev) { unknownEvents.set(evName, (unknownEvents.get(evName) || 0) + 1); continue; }
      if (!ev.ag_ids.includes(agId)) { droppedAge++; droppedDetail.push(`${p.name}: '${evName}' not offered for their new age group`); continue; }
      if (ev.gender_split === 'boys' && p.gender !== 'M') { droppedGender++; continue; }
      if (ev.gender_split === 'girls' && p.gender !== 'F') { droppedGender++; continue; }
      const fee = p.member && ev.member_fee_amount != null
        ? Number(ev.member_fee_amount) : Number(ev.fee_amount || 0);
      await client.query(
        `INSERT INTO registrations (year_id, participant_id, event_id, age_group_id,
                                    category_id, fee_amount, status, registered_by,
                                    registered_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())`,
        [yearId, pid, ev.id, agId, ev.category_id, fee, parentIds[p.contact]]);
      regs++;
    }

    // ── 6. payment (confirmed cash, amount from CSV) ─────────────────────────
    if (p.payment > 0) {
      await client.query(
        `INSERT INTO payments (year_id, parent_user_id, participant_id, amount,
                               method, status, notes, confirmed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'cash','confirmed','Seeded from 2025 data', NOW(), NOW(), NOW())`,
        [yearId, parentIds[p.contact], pid, p.payment]);
    }
  }

  console.log('\n===== SEED SUMMARY =====');
  console.log(`Participants created: ${created}`);
  if (noGroup) console.log(`Participants SKIPPED (DOB outside all configured age groups): ${noGroup} — widen the DOB ranges in Year Setup if these children should be included, then re-run.`);
  console.log(`Registrations created: ${regs}`);
  console.log(`Dropped — event not in new age group: ${droppedAge}`);
  console.log(`Dropped — gender split: ${droppedGender}`);
  if (unknownEvents.size) {
    console.log(`Unmatched event names (all their rows skipped):`);
    for (const [n, c] of unknownEvents) console.log(`  - "${n}" (${c} rows)`);
  }
  if (droppedDetail.length) {
    console.log(`\nFirst 15 dropped details:`);
    droppedDetail.slice(0, 15).forEach((d) => console.log('  ·', d));
    console.log(`  (${droppedDetail.length} total — full list not shown)`);
  }
  console.log(`\nParent login: any parent email (or parent.<contact>@test.kcabah.com) / ${PARENT_PASSWORD}`);
  await client.end();
})().catch((e) => { console.error('SEED FAILED:', e.message); process.exit(1); });
