// src/routes/admin.registrations.routes.js  (mounted at /api/admin)
//
// DB-verified column names:
//   participants:  id, year_id, school_id, cpr_number, full_name, dob, gender,
//                  age_group_id, guardian_name, guardian_phone, membership_status
//   registrations: id, year_id, participant_id, team_id, event_id, age_group_id,
//                  category_id, status (enum: registered|attended|absent|withdrawn|swapped),
//                  dance_teacher, music_teacher, registered_at, registered_by, updated_at
//   teams:         id, year_id, event_id, school_id, age_group_id, team_name
//   team_members:  id, team_id, participant_id, is_substitute, attendance_confirmed
//   schools:       id, name, short_code, is_active
//   age_groups:    id, year_id, code, label, sort_order
//   categories:    id, year_id, code, name, sort_order
//   events:        id, year_id, event_name, event_code, event_kind, category_id
//
// NOTE: No payments or refund_log tables exist — payment tracking not included.

const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { sendWhatsApp, sendWhatsAppImage, sendWhatsAppImageMany, sendWhatsAppMany } = require('../utils/notify');
const { sendEmail, registrationConfirmationHtml, scheduleEmailHtml, customEmailHtml } = require('../utils/email');
const bcrypt = require('bcrypt');
const multer = require('multer');
const {
  round3, isBahrainPhone, isIntlPhone, eventFee, genderEligible,
  cprDobMismatch, parentMemberActive, resolveAgeGroup,
} = require('../utils/registration');

// In-memory upload for the walk-in Excel import (parsed with exceljs, never
// written to disk). 5 MB cap — an import sheet is tiny.
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const path = require('path');
const { uploadDir } = require('../utils/uploads');

// Disk upload for a participant's CPR scans / photo, when staff upload on the
// parent's behalf. Saved to the persistent uploads dir, served at /uploads/<f>.
const imageUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) =>
      cb(null, `p${req.params.id || 'x'}-${Date.now()}${path.extname(file.originalname || '.jpg')}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    cb(null, /^image\/(png|jpe?g|webp|heic|heif)$/i.test(file.mimetype)),
});

const PARTICIPANT_IMAGE_COLUMN = {
  photo: 'photo_url', cpr_front: 'cpr_scan_url', cpr_back: 'cpr_scan_back_url',
};

const router = express.Router();
router.use(authenticate);

const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Registrar'];
const editRoles  = ['SuperAdmin', 'Admin', 'Coordinator', 'Registrar'];

// ── IMPORTANT: static paths must come before /:id ────────────────────────────

// ── GET /api/admin/registrations/summary ─────────────────────────────────────
// Per-event registration counts — used for split/merge monitoring dashboard.
router.get('/registrations/summary', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    if (!cfg[0]) return res.json([]);
    const year_id = cfg[0].id;

    const { rows } = await pool.query(
      `SELECT
         e.id AS event_id, e.event_name, e.event_code, e.event_kind,
         ag.code AS age_group_code, ag.label AS age_group_label,
         COUNT(r.id)                                                    AS total,
         COUNT(r.id) FILTER (WHERE r.status = 'registered')            AS registered,
         COUNT(r.id) FILTER (WHERE r.status = 'attended')              AS attended,
         COUNT(r.id) FILTER (WHERE r.status = 'absent')                AS absent,
         COUNT(r.id) FILTER (WHERE r.status = 'withdrawn')             AS withdrawn
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.year_id = $1
         AND (p.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
       GROUP BY e.id, e.event_name, e.event_code, e.event_kind,
                ag.code, ag.label, ag.sort_order
       ORDER BY e.event_name, ag.sort_order`,
      [year_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations/source-summary ──────────────────────────────
// How parents heard about ITS this year (captured at sign-up, multi-select).
// Counts each selected source across all parent accounts that answered, plus
// the free-text "Other" notes.
router.get('/registrations/source-summary', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: counts } = await pool.query(
      `SELECT src AS source, COUNT(*)::int AS count
       FROM users u, LATERAL unnest(u.heard_about_sources) AS src
       WHERE u.heard_about_sources IS NOT NULL
       GROUP BY src
       ORDER BY count DESC, source`);
    const { rows: tot } = await pool.query(
      `SELECT COUNT(*)::int AS answered FROM users WHERE heard_about_sources IS NOT NULL`);
    const { rows: others } = await pool.query(
      `SELECT heard_about_other AS note FROM users
       WHERE heard_about_other IS NOT NULL AND heard_about_other <> ''
       ORDER BY id DESC LIMIT 200`);
    res.json({ answered: tot[0].answered, counts, others: others.map((o) => o.note) });
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations/export ──────────────────────────────────────
// Full CSV export of registrations for the active year.
router.get('/registrations/export', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    // ── Sheet 1: Completed registrations ────────────────────────────────────
    // One row per participant (or team): parent details, all events in a single
    // comma-separated column, and the total fee across their events.
    const { rows } = await pool.query(
      `SELECT
         p.id AS participant_id, t.id AS team_id,
         COALESCE(p.full_name, t.team_name) AS participant_name,
         CASE WHEN r.team_id IS NOT NULL THEN 'team' ELSE 'individual' END AS entry_type,
         p.cpr_number, p.gender, to_char(p.dob, 'YYYY-MM-DD') AS dob,
         to_char(COALESCE(p.confirmed_at, MIN(r.registered_at)) AT TIME ZONE 'Asia/Bahrain', 'YYYY-MM-DD') AS reg_date,
         to_char(COALESCE(p.confirmed_at, MIN(r.registered_at)) AT TIME ZONE 'Asia/Bahrain', 'HH24:MI') AS reg_time,
         pag.code AS age_group_code, s.name AS school_name,
         string_agg(e.event_code || ' ' || e.event_name, ', '
                    ORDER BY e.event_code) FILTER (WHERE r.status <> 'withdrawn') AS events,
         COUNT(*) FILTER (WHERE r.status <> 'withdrawn') AS event_count,
         COALESCE(SUM(r.fee_amount) FILTER (WHERE r.status <> 'withdrawn'), 0) AS total_fee,
         (SELECT CASE
            WHEN COUNT(*) FILTER (WHERE pay.status = 'confirmed') > 0 THEN 'verified'
            WHEN COUNT(*) FILTER (WHERE pay.status = 'pending') > 0 THEN 'pending'
            ELSE 'none' END
          FROM payments pay
          WHERE (p.id IS NOT NULL AND pay.participant_id = p.id)
             OR (t.id IS NOT NULL AND pay.team_id = t.id)) AS payment_status,
         (SELECT string_agg(DISTINCT pay.method::text, ' | ')
          FROM payments pay
          WHERE (p.id IS NOT NULL AND pay.participant_id = p.id)
             OR (t.id IS NOT NULL AND pay.team_id = t.id)) AS payment_methods,
         (SELECT COALESCE(SUM(pay.amount), 0)
          FROM payments pay
          WHERE pay.status = 'confirmed'
            AND ((p.id IS NOT NULL AND pay.participant_id = p.id)
             OR (t.id IS NOT NULL AND pay.team_id = t.id))) AS paid_confirmed,
         pu.full_name AS parent_name, pu.email AS parent_email,
         pu.phone AS parent_phone, pu.whatsapp_number AS parent_whatsapp,
         pu.whatsapp_number_2 AS parent_whatsapp_2,
         tag.code AS team_age_group_code, ts.name AS team_school_name,
         pu.kca_member_no, pu.membership_status AS kca_membership
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN users pu ON pu.id = COALESCE(p.created_by, t.created_by)
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups pag ON pag.id = p.age_group_id
       LEFT JOIN age_groups tag ON tag.id = t.age_group_id
       LEFT JOIN schools ts ON ts.id = t.school_id
       JOIN events e ON e.id = r.event_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
         -- Completed registrations only (parent finished the flow), plus team entries.
         AND (p.confirmed_at IS NOT NULL OR r.team_id IS NOT NULL)
       GROUP BY p.id, t.id, p.full_name, t.team_name, entry_type,
                p.cpr_number, p.gender, p.dob, p.confirmed_at, pag.code, s.name,
                pu.full_name, pu.email, pu.phone, pu.whatsapp_number, pu.whatsapp_number_2,
                tag.code, ts.name,
                pu.kca_member_no, pu.membership_status
       ORDER BY COALESCE(p.confirmed_at, MIN(r.registered_at)), participant_name`,
      [year_id],
    );

    // ── Sheet 2: In Progress ────────────────────────────────────────────────
    // Individual participants who have NOT completed (confirmed_at IS NULL),
    // whether they picked some events or none at all. Team entries never appear
    // here (they are always treated as complete). Mirrors the In Progress tab
    // on the Registrations screen, with whatever parent/participant info exists.
    const { rows: inprog } = await pool.query(
      `SELECT
         p.id AS participant_id,
         p.full_name AS participant_name,
         p.cpr_number, p.gender, to_char(p.dob, 'YYYY-MM-DD') AS dob,
         pag.code AS age_group_code, s.name AS school_name,
         to_char(p.created_at AT TIME ZONE 'Asia/Bahrain', 'YYYY-MM-DD') AS created_date,
         to_char(p.created_at AT TIME ZONE 'Asia/Bahrain', 'HH24:MI') AS created_time,
         to_char(p.last_reminder_at AT TIME ZONE 'Asia/Bahrain', 'YYYY-MM-DD HH24:MI') AS last_reminder,
         string_agg(e.event_code || ' ' || e.event_name, ', '
                    ORDER BY e.event_code) FILTER (WHERE r.id IS NOT NULL AND r.status <> 'withdrawn') AS events,
         COUNT(r.id) FILTER (WHERE r.status <> 'withdrawn') AS event_count,
         pu.full_name AS parent_name, pu.email AS parent_email,
         pu.phone AS parent_phone, pu.whatsapp_number AS parent_whatsapp,
         pu.whatsapp_number_2 AS parent_whatsapp_2,
         pu.kca_member_no, pu.membership_status AS kca_membership
       FROM participants p
       LEFT JOIN registrations r ON r.participant_id = p.id
       LEFT JOIN events e ON e.id = r.event_id
       LEFT JOIN users pu ON pu.id = p.created_by
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups pag ON pag.id = p.age_group_id
       WHERE ($1::int IS NULL OR p.year_id = $1)
         AND p.confirmed_at IS NULL
         -- Individual entries only: exclude children who exist solely as team members.
         AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.participant_id = p.id)
       GROUP BY p.id, p.full_name, p.cpr_number, p.gender, p.dob, p.created_at,
                p.last_reminder_at, pag.code, s.name,
                pu.full_name, pu.email, pu.phone, pu.whatsapp_number,
                pu.whatsapp_number_2, pu.kca_member_no, pu.membership_status
       ORDER BY p.created_at DESC`,
      [year_id],
    );

    const bd = (v) => Number(v || 0).toFixed(3);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KCA ITS';
    wb.created = new Date();

    const styleHeader = (ws) => {
      const h = ws.getRow(1);
      h.font = { bold: true };
      h.alignment = { vertical: 'middle' };
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    };

    // Completed sheets - Individuals and Teams
    const ws1 = wb.addWorksheet('Completed - Individuals');
    ws1.columns = [
      { header: 'Participant', key: 'participant_name', width: 26 },
      { header: 'CPR', key: 'cpr_number', width: 14 },
      { header: 'Gender', key: 'gender', width: 8 },
      { header: 'DOB', key: 'dob', width: 12 },
      { header: 'Age Group', key: 'age_group_code', width: 11 },
      { header: 'School', key: 'school_name', width: 26 },
      { header: 'Registration Date', key: 'reg_date', width: 16 },
      { header: 'Registration Time', key: 'reg_time', width: 16 },
      { header: 'Parent', key: 'parent_name', width: 22 },
      { header: 'Parent Email', key: 'parent_email', width: 26 },
      { header: 'Parent Phone', key: 'parent_phone', width: 15 },
      { header: 'WhatsApp', key: 'parent_whatsapp', width: 15 },
      { header: 'WhatsApp 2', key: 'parent_whatsapp_2', width: 15 },
      { header: 'KCA Member No', key: 'kca_member_no', width: 15 },
      { header: 'KCA Membership', key: 'kca_membership', width: 15 },
      { header: 'Events', key: 'events', width: 40 },
      { header: 'No. of Events', key: 'event_count', width: 13 },
      { header: 'Total Fee (BD)', key: 'total_fee', width: 14 },
      { header: 'Payment Status', key: 'payment_status', width: 15 },
      { header: 'Payment Methods', key: 'payment_methods', width: 18 },
      { header: 'Paid Confirmed (BD)', key: 'paid_confirmed', width: 18 },
    ];
    rows.filter((r) => r.entry_type === 'individual').forEach((r) => ws1.addRow({
      ...r,
      total_fee: Number(bd(r.total_fee)),
      paid_confirmed: Number(bd(r.paid_confirmed)),
    }));
    styleHeader(ws1);

    // Sheet — Completed (Teams): age group & school come from the team itself
    const wsT = wb.addWorksheet('Completed - Teams');
    wsT.columns = [
      { header: 'Team Name', key: 'participant_name', width: 28 },
      { header: 'Age Group', key: 'age_group_code', width: 11 },
      { header: 'School', key: 'school_name', width: 26 },
      { header: 'Registration Date', key: 'reg_date', width: 16 },
      { header: 'Registration Time', key: 'reg_time', width: 16 },
      { header: 'Registered By', key: 'parent_name', width: 22 },
      { header: 'Email', key: 'parent_email', width: 26 },
      { header: 'Phone', key: 'parent_phone', width: 15 },
      { header: 'WhatsApp', key: 'parent_whatsapp', width: 15 },
      { header: 'WhatsApp 2', key: 'parent_whatsapp_2', width: 15 },
      { header: 'Event', key: 'events', width: 40 },
      { header: 'Total Fee (BD)', key: 'total_fee', width: 14 },
      { header: 'Payment Status', key: 'payment_status', width: 15 },
      { header: 'Payment Methods', key: 'payment_methods', width: 18 },
      { header: 'Paid Confirmed (BD)', key: 'paid_confirmed', width: 18 },
    ];
    rows.filter((r) => r.entry_type === 'team').forEach((r) => wsT.addRow({
      ...r,
      age_group_code: r.team_age_group_code,
      school_name: r.team_school_name,
      total_fee: Number(bd(r.total_fee)),
      paid_confirmed: Number(bd(r.paid_confirmed)),
    }));
    styleHeader(wsT);

    // Sheet 2 — In Progress
    const ws2 = wb.addWorksheet('In Progress');
    ws2.columns = [
      { header: 'Participant', key: 'participant_name', width: 26 },
      { header: 'CPR', key: 'cpr_number', width: 14 },
      { header: 'Gender', key: 'gender', width: 8 },
      { header: 'DOB', key: 'dob', width: 12 },
      { header: 'Age Group', key: 'age_group_code', width: 11 },
      { header: 'School', key: 'school_name', width: 26 },
      { header: 'Started On', key: 'created_date', width: 14 },
      { header: 'Started At', key: 'created_time', width: 12 },
      { header: 'Last Reminder', key: 'last_reminder', width: 18 },
      { header: 'Events So Far', key: 'events', width: 40 },
      { header: 'No. of Events', key: 'event_count', width: 13 },
      { header: 'Parent', key: 'parent_name', width: 22 },
      { header: 'Parent Email', key: 'parent_email', width: 26 },
      { header: 'Parent Phone', key: 'parent_phone', width: 15 },
      { header: 'WhatsApp', key: 'parent_whatsapp', width: 15 },
      { header: 'WhatsApp 2', key: 'parent_whatsapp_2', width: 15 },
      { header: 'KCA Member No', key: 'kca_member_no', width: 15 },
      { header: 'KCA Membership', key: 'kca_membership', width: 15 },
    ];
    inprog.forEach((r) => ws2.addRow(r));
    styleHeader(ws2);

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="registrations_export.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ── Mark an In-Progress registration Completed (admin) ───────────────────────
// Some parents finish everything in person (events chosen, documents given,
// cash paid at the office) but never log back in to press "Register". Staff can
// finish it for them here — but ONLY when every required field is present and at
// least one valid event is on record. Optionally records the cash paid in
// office and sends the same acknowledgement the parent flow sends.

// Shared readiness check — pure reads. Returns the participant, their events,
// fee totals and a list of blockers (must fix) / warnings (informational).
async function registrationReadiness(db, participantId) {
  const { rows: pRows } = await db.query(
    `SELECT p.id, p.year_id, p.full_name, p.cpr_number, p.dob, p.gender,
            p.school_id, p.age_group_id, p.confirmed_at, p.guardian_phone,
            s.name AS school_name, ag.code AS age_group_code, ag.label AS age_group_label,
            pu.id AS parent_id, pu.full_name AS parent_name, pu.email AS parent_email,
            pu.phone AS parent_phone, pu.whatsapp_number AS parent_whatsapp,
            pu.whatsapp_number_2 AS parent_whatsapp_2, pu.kca_member_no,
            pu.membership_status
     FROM participants p
     LEFT JOIN schools s ON s.id = p.school_id
     LEFT JOIN age_groups ag ON ag.id = p.age_group_id
     LEFT JOIN users pu ON pu.id = p.created_by
     WHERE p.id = $1`, [participantId]);
  const p = pRows[0];
  if (!p) return { notFound: true };

  const { rows: items } = await db.query(
    `SELECT e.event_code, e.event_name, r.fee_amount, r.id AS registration_id
     FROM registrations r JOIN events e ON e.id = r.event_id
     WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
     ORDER BY e.event_code`, [participantId]);

  const { rows: pays } = await db.query(
    `SELECT amount, method, status FROM payments WHERE participant_id = $1 ORDER BY created_at`,
    [participantId]);

  const feesTotal = round3(items.reduce((t, r) => t + Number(r.fee_amount || 0), 0));
  const paidConfirmed = round3(pays.filter((x) => x.status === 'confirmed')
    .reduce((t, x) => t + Number(x.amount), 0));
  const paidSubmitted = round3(pays.filter((x) => x.status === 'pending' || x.status === 'confirmed')
    .reduce((t, x) => t + Number(x.amount), 0));

  const blockers = [];
  if (!p.full_name || !String(p.full_name).trim()) blockers.push('Full name is missing');
  if (!p.dob) blockers.push('Date of birth is missing');
  if (!(p.gender === 'M' || p.gender === 'F')) blockers.push('Gender (Male/Female) is missing');
  if (!p.cpr_number || !String(p.cpr_number).trim()) {
    blockers.push('CPR number is missing');
  } else if (p.dob) {
    const cprErr = cprDobMismatch(p.cpr_number, p.dob);
    if (cprErr) blockers.push(cprErr);
  }
  if (items.length === 0) blockers.push('No events selected — at least one event is required');

  const warnings = [];
  if (!p.school_id) warnings.push('School is not recorded');
  if (!p.confirmed_at && feesTotal > 0 && paidConfirmed + 0.0001 < feesTotal) {
    warnings.push(`Balance of BD ${round3(feesTotal - paidConfirmed).toFixed(3)} not yet recorded as paid`);
  }
  if (p.confirmed_at) warnings.push('This entry is already completed');

  return {
    p, items, pays, feesTotal, paidConfirmed, paidSubmitted,
    balanceDue: round3(Math.max(0, feesTotal - paidConfirmed)),
    memberRateApplied: p.membership_status === 'active',
    blockers, warnings,
    ready: blockers.length === 0,
  };
}

// GET readiness for the completion modal (fields present/missing, fees, balance).
router.get('/registrations/participant/:id/complete-check',
  requireRole(...staffRoles), async (req, res, next) => {
  try {
    const r = await registrationReadiness(pool, req.params.id);
    if (r.notFound) return res.status(404).json({ error: 'Participant not found' });
    res.json({
      participant: {
        id: r.p.id, full_name: r.p.full_name, cpr_number: r.p.cpr_number,
        dob: r.p.dob, gender: r.p.gender, school_id: r.p.school_id,
        school_name: r.p.school_name, age_group_code: r.p.age_group_code,
        confirmed_at: r.p.confirmed_at,
      },
      parent: {
        name: r.p.parent_name, email: r.p.parent_email,
        phone: r.p.parent_phone, whatsapp: r.p.parent_whatsapp,
        kca_member_no: r.p.kca_member_no, membership_status: r.p.membership_status,
      },
      events: r.items.map((i) => ({ event_code: i.event_code, event_name: i.event_name, fee_amount: Number(i.fee_amount || 0) })),
      event_count: r.items.length,
      fees: {
        total_due: r.feesTotal, paid_confirmed: r.paidConfirmed,
        paid_submitted: r.paidSubmitted, balance_due: r.balanceDue,
        member_rate_applied: r.memberRateApplied,
      },
      blockers: r.blockers, warnings: r.warnings, ready: r.ready,
    });
  } catch (err) { next(err); }
});

// POST complete — records an optional cash payment and sets confirmed_at.
router.post('/registrations/participant/:id/complete',
  requireRole(...editRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { cash_amount, payment_method, payment_reference, send_confirmation } = req.body || {};

    await client.query('BEGIN');
    const r = await registrationReadiness(client, req.params.id);
    if (r.notFound) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Participant not found' }); }
    if (!r.ready) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot complete — required details are missing', blockers: r.blockers });
    }
    const p = r.p;

    // Backfill the age group from DOB if it was never set (keeps results/age-group
    // reporting correct). Never overwrites an existing value.
    if (!p.age_group_id) {
      const agId = await resolveAgeGroup(p.dob, p.year_id, client);
      if (agId) await client.query(
        `UPDATE participants SET age_group_id = $1, updated_at = NOW() WHERE id = $2 AND age_group_id IS NULL`,
        [agId, p.id]);
    }

    // Optional: record cash (or other) paid in office as a CONFIRMED payment.
    let paid_recorded = 0;
    const amt = Number(cash_amount || 0);
    if (amt > 0) {
      const method = payment_method || 'cash';
      if (!['cash', 'benefitpay', 'bank_transfer'].includes(method)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: "payment_method must be 'cash', 'benefitpay' or 'bank_transfer'" });
      }
      await client.query(
        `INSERT INTO payments
           (year_id, parent_user_id, participant_id, amount, method, status,
            reference, notes, confirmed_by, confirmed_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,NOW(),NOW(),NOW())`,
        [p.year_id, p.parent_id, p.id, round3(amt), method,
         payment_reference || null,
         `Recorded at office by ${req.user.role} on completion`, req.user.id]);
      paid_recorded = round3(amt);
    }

    // Mark complete — this is what moves it into the Completed list.
    await client.query(
      `UPDATE participants SET confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW() WHERE id = $1`,
      [p.id]);

    await client.query('COMMIT');

    // Acknowledgement (same content as the parent self-service confirm) — only
    // when staff asked for it, and only if the parent account has an email.
    let email_sent = false;
    if (send_confirmation && p.parent_email) {
      try {
        const { rows: yl } = await pool.query(
          `SELECT event_year_label, rules_pdf_url, its_logo_url FROM year_config WHERE id = $1`, [p.year_id]);
        const result = await sendEmail({
          to: p.parent_email,
          subject: `${yl[0]?.event_year_label || 'KCA ITS'} — Registration confirmed for ${p.full_name}`,
          html: registrationConfirmationHtml({
            yearLabel: yl[0]?.event_year_label, rulesUrl: yl[0]?.rules_pdf_url, logoUrl: yl[0]?.its_logo_url,
            parent: { full_name: p.parent_name, email: p.parent_email, phone: p.parent_phone,
                      whatsapp_number: p.parent_whatsapp, kca_member_no: p.kca_member_no },
            participant: p, items: r.items, payments: r.pays,
            summary: { fees_total: r.feesTotal, paid_confirmed: round3(r.paidConfirmed + paid_recorded),
                       balance_due: round3(Math.max(0, r.feesTotal - r.paidConfirmed - paid_recorded)) },
          }),
        });
        email_sent = result.sent;
      } catch (e) { console.error('completion email failed:', e.message); }
    }
    if (send_confirmation && p.guardian_phone) {
      sendWhatsApp(p.guardian_phone,
        `KCA ITS: Registration for ${p.full_name} is now complete — ${r.items.length} event(s). Thank you!`)
        .catch(() => null);
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ADMIN_COMPLETE_REGISTRATION', entity: 'participants', entityId: p.id,
      details: { events: r.items.length, paid_recorded, email_sent } });

    res.json({ completed: true, events: r.items.length, paid_recorded, email_sent });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// POST /participants/:id/send-confirmation — (re)send the registration-complete
// acknowledgement (email + WhatsApp) to the parent on demand. Useful after a
// walk-in import once photos/CPR are added, after an email change, etc.
router.post('/participants/:id/send-confirmation',
  requireRole(...editRoles), async (req, res, next) => {
  try {
    const r = await registrationReadiness(pool, req.params.id);
    if (r.notFound) return res.status(404).json({ error: 'Participant not found' });
    if (!r.items.length) return res.status(400).json({ error: 'No events on record — nothing to confirm.' });
    const p = r.p;

    const { rows: yl } = await pool.query(
      `SELECT event_year_label, rules_pdf_url, its_logo_url FROM year_config WHERE id = $1`, [p.year_id]);

    let email_sent = false;
    if (p.parent_email) {
      try {
        const result = await sendEmail({
          to: p.parent_email,
          subject: `${yl[0]?.event_year_label || 'KCA ITS'} — Registration confirmed for ${p.full_name}`,
          html: registrationConfirmationHtml({
            yearLabel: yl[0]?.event_year_label, rulesUrl: yl[0]?.rules_pdf_url, logoUrl: yl[0]?.its_logo_url,
            parent: { full_name: p.parent_name, email: p.parent_email, phone: p.parent_phone,
                      whatsapp_number: p.parent_whatsapp, kca_member_no: p.kca_member_no },
            participant: p, items: r.items, payments: r.pays,
            summary: { fees_total: r.feesTotal, paid_confirmed: r.paidConfirmed,
                       balance_due: Math.max(0, r.feesTotal - r.paidConfirmed) },
          }),
        });
        email_sent = !!result.sent;
      } catch (e) { console.error('send-confirmation email failed:', e.message); }
    }

    let whatsapp_sent = false;
    if (p.guardian_phone) {
      sendWhatsApp(p.guardian_phone,
        `KCA ITS: Registration for ${p.full_name} is confirmed — ${r.items.length} event(s). Thank you!`)
        .catch(() => null);
      whatsapp_sent = true;
    }

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'SEND_CONFIRMATION', entity: 'participants', entityId: Number(req.params.id),
      details: { email_sent, whatsapp_sent } });

    res.json({ email_sent, whatsapp_sent, parent_email: p.parent_email || null });
  } catch (err) { next(err); }
});


// ── GET /api/admin/participants ───────────────────────────────────────────────
// List participants for the active year with registration counts.
router.get('/participants', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { search, school_id, age_group_id, include } = req.query;
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;
    // include='all' also returns not-yet-completed children, incl. those who
    // exist only as team members (so staff can find and fix e.g. a missing
    // gender before the parent registers them for individual events).
    const includeAll = String(include || '') === 'all';

    const { rows } = await pool.query(
      `SELECT
         p.id, p.cpr_number, p.full_name, p.dob, p.gender, p.membership_status,
         p.guardian_name, p.guardian_phone,
         pu.full_name AS parent_name, pu.email AS parent_email, pu.phone AS parent_phone,
         (p.confirmed_at IS NOT NULL) AS confirmed,
         EXISTS (SELECT 1 FROM team_members tm WHERE tm.participant_id = p.id) AS on_team,
         s.name AS school_name,
         ag.code AS age_group_code, ag.label AS age_group_label,
         COUNT(r.id) FILTER (WHERE r.status != 'withdrawn') AS event_count
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN users pu ON pu.id = p.created_by
       LEFT JOIN registrations r ON r.participant_id = p.id
       WHERE ($1::int IS NULL OR p.year_id = $1)
         AND ($5::bool OR p.confirmed_at IS NOT NULL)  -- completed only unless include=all
         AND ($2::text IS NULL OR p.full_name ILIKE '%' || $2 || '%'
              OR p.cpr_number = $2
              OR pu.full_name ILIKE '%' || $2 || '%'
              OR pu.email ILIKE '%' || $2 || '%'
              OR pu.phone ILIKE '%' || $2 || '%'
              OR p.guardian_name ILIKE '%' || $2 || '%')
         AND ($3::int IS NULL OR p.school_id = $3)
         AND ($4::int IS NULL OR p.age_group_id = $4)
       GROUP BY p.id, s.name, ag.code, ag.label, ag.sort_order,
                pu.full_name, pu.email, pu.phone
       ORDER BY p.full_name`,
      [year_id,
       search || null,
       school_id ? parseInt(school_id, 10) : null,
       age_group_id ? parseInt(age_group_id, 10) : null,
       includeAll],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations ─────────────────────────────────────────────
// List all registrations for the active year with full joined data.
router.get('/registrations', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { event_id, status, age_group_id, search } = req.query;
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         r.id, r.year_id, r.participant_id, r.event_id, r.team_id,
         r.age_group_id, r.category_id, r.status,
         r.dance_teacher, r.music_teacher, r.registered_at, r.updated_at,
         p.full_name AS participant_name, p.cpr_number, p.gender, p.dob,
         p.cpr_verified_method, p.admin_verified_status, p.confirmed_at, p.last_reminder_at,
         (SELECT string_agg(DISTINCT pay.method::text, ',')
          FROM payments pay
          WHERE (r.participant_id IS NOT NULL AND pay.participant_id = r.participant_id)
             OR (r.team_id IS NOT NULL AND pay.team_id = r.team_id)) AS payment_methods,
         (SELECT CASE
            WHEN COUNT(*) FILTER (WHERE pay.status = 'confirmed') > 0 THEN 'verified'
            WHEN COUNT(*) FILTER (WHERE pay.status = 'pending') > 0 THEN 'pending'
            ELSE 'none' END
          FROM payments pay
          WHERE (r.participant_id IS NOT NULL AND pay.participant_id = r.participant_id)
             OR (r.team_id IS NOT NULL AND pay.team_id = r.team_id)) AS payment_status,
         (SELECT pu.membership_status FROM users pu
          WHERE pu.id = p.created_by) AS parent_membership_status,
         t.team_name,
         (SELECT COUNT(*)::int FROM team_members tm WHERE tm.team_id = r.team_id) AS team_member_count,
         s.name AS school_name,
         e.event_name, e.event_code, e.event_kind,
         c.name AS category_name,
         ag.code AS age_group_code, ag.label AS age_group_label
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE ($1::int IS NULL OR r.year_id = $1)
         AND ($2::int IS NULL OR r.event_id = $2)
         AND ($3::text IS NULL OR r.status::text = $3)
         AND ($4::int IS NULL OR r.age_group_id = $4)
         AND ($5::text IS NULL
              OR p.full_name ILIKE '%' || $5 || '%'
              OR p.cpr_number = $5)
       ORDER BY r.registered_at, p.full_name`,
      [year_id,
       event_id ? parseInt(event_id, 10) : null,
       status || null,
       age_group_id ? parseInt(age_group_id, 10) : null,
       search || null],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations/partial ─────────────────────────────────────
// Children who were added in the portal but have NO events saved at all (no
// registration rows of any status). These never appear in the main grid, which
// is built from registration rows, so they are surfaced here to show in the
// In Progress view — letting staff spot parents who started but didn't finish
// and follow up. Read-only; rows are shaped like registration rows for the UI.
router.get('/registrations/partial', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         p.id AS participant_id,
         p.full_name AS participant_name,
         p.cpr_number, p.gender, p.dob,
         p.cpr_verified_method, p.admin_verified_status,
         p.last_reminder_at, p.created_at,
         s.name AS school_name,
         ag.code AS age_group_code, ag.label AS age_group_label,
         pu.membership_status AS parent_membership_status
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN users pu ON pu.id = p.created_by
       WHERE ($1::int IS NULL OR p.year_id = $1)
         AND p.confirmed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM registrations r WHERE r.participant_id = p.id
         )
         -- Individual entries only: a child who exists solely as a team member
         -- is not an in-progress individual registration.
         AND NOT EXISTS (
           SELECT 1 FROM team_members tm WHERE tm.participant_id = p.id
         )
       ORDER BY p.created_at DESC`,
      [year_id],
    );

    // Shape each as a synthetic registration row so the admin grid can merge
    // them in directly. no_events flags them for the "No events yet" label.
    const shaped = rows.map((p) => ({
      id: `partial-p${p.participant_id}`,
      participant_id: p.participant_id,
      team_id: null,
      participant_name: p.participant_name,
      cpr_number: p.cpr_number,
      gender: p.gender,
      dob: p.dob,
      cpr_verified_method: p.cpr_verified_method,
      admin_verified_status: p.admin_verified_status,
      parent_membership_status: p.parent_membership_status,
      age_group_code: p.age_group_code,
      age_group_label: p.age_group_label,
      school_name: p.school_name,
      last_reminder_at: p.last_reminder_at,
      registered_at: p.created_at,
      confirmed_at: null,
      status: null,
      payment_status: 'none',
      payment_methods: '',
      event_id: null,
      event_name: null,
      event_code: null,
      event_kind: 'individual',
      category_name: null,
      no_events: true,
    }));

    res.json(shaped);
  } catch (err) { next(err); }
});

// ── GET /api/admin/registrations/:id ─────────────────────────────────────────
router.get('/registrations/:id', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         r.*,
         p.full_name AS participant_name, p.cpr_number, p.dob, p.gender,
         p.guardian_name, p.guardian_phone,
         s.name AS school_name,
         e.event_name, e.event_code, e.event_kind,
         c.name AS category_name,
         ag.code AS age_group_code, ag.label AS age_group_label
       FROM registrations r
       JOIN participants p ON p.id = r.participant_id
       LEFT JOIN schools s ON s.id = p.school_id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = r.category_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       WHERE r.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/admin/registrations/:id ─────────────────────────────────────────
// Admin can update status, dance_teacher, music_teacher.
router.put('/registrations/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { status, dance_teacher, music_teacher } = req.body;
    const { rows } = await pool.query(
      `UPDATE registrations SET
         status        = COALESCE($1::registration_status, status),
         dance_teacher = COALESCE($2, dance_teacher),
         music_teacher = COALESCE($3, music_teacher),
         updated_at    = NOW()
       WHERE id = $4
       RETURNING *`,
      [status || null, dance_teacher || null, music_teacher || null, req.params.id],
    );
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_REGISTRATION', entity: 'registrations',
      entityId: req.params.id, details: req.body });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/registrations/:id ──────────────────────────────────────
router.delete('/registrations/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM registrations WHERE id = $1`, [req.params.id],
    );
    if (!rowCount) return res.status(404).json({ error: 'Registration not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'DELETE_REGISTRATION', entity: 'registrations', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── GET /api/admin/teams ──────────────────────────────────────────────────────
// List team registrations for the active year.
router.get('/teams', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(
      `SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`,
    );
    const year_id = cfg[0]?.id || null;

    const { rows } = await pool.query(
      `SELECT
         t.id, t.team_name, t.year_id, t.event_id,
         e.event_name, e.event_code,
         s.name AS school_name,
         ag.code AS age_group_code, ag.label AS age_group_label,
         COUNT(tm.id) AS member_count
       FROM teams t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN schools s ON s.id = t.school_id
       LEFT JOIN age_groups ag ON ag.id = t.age_group_id
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE ($1::int IS NULL OR t.year_id = $1)
       GROUP BY t.id, e.event_name, e.event_code, s.name, ag.code, ag.label
       ORDER BY t.team_name`,
      [year_id],
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/teams/:id/members ─────────────────────────────────────────
router.get('/teams/:id/members', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT tm.id, tm.participant_id, tm.is_substitute, tm.cpr_verified,
              p.full_name, p.cpr_number, p.dob, p.gender,
              s.name AS school_name, ag.code AS age_group_code
       FROM team_members tm
       JOIN participants p ON p.id = tm.participant_id
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       WHERE tm.team_id = $1
       ORDER BY p.full_name`,
      [req.params.id],
    );
    const { rows: documents } = await pool.query(
      `SELECT td.id, td.url, td.original_name, td.uploaded_at, u.full_name AS uploaded_by_name
       FROM team_documents td LEFT JOIN users u ON u.id = td.uploaded_by
       WHERE td.team_id = $1 ORDER BY td.uploaded_at`, [req.params.id]);
    const { rows: meta } = await pool.query(
      `SELECT t.team_name, to_char(t.created_at,'YYYY-MM-DD') AS created_on,
              e.event_code, e.event_name, ag.code AS age_group_code, s.name AS school_name,
              u.full_name AS contact_name, u.phone AS contact_phone,
              u.whatsapp_number AS contact_whatsapp, u.whatsapp_number_2 AS contact_whatsapp_2,
              u.email AS contact_email, u.kca_member_no, u.membership_status AS kca_membership,
              (SELECT COALESCE(SUM(r.fee_amount),0) FROM registrations r
                 WHERE r.team_id = t.id AND r.status NOT IN ('withdrawn','swapped')) AS fee_total
         FROM teams t JOIN events e ON e.id = t.event_id
         LEFT JOIN age_groups ag ON ag.id = t.age_group_id
         LEFT JOIN schools s ON s.id = t.school_id
         LEFT JOIN users u ON u.id = t.created_by
        WHERE t.id = $1`, [req.params.id]);
    const { rows: payments } = await pool.query(
      `SELECT id, amount, method, status, reference, proof_url, to_char(created_at,'YYYY-MM-DD HH24:MI') AS created_at
         FROM payments WHERE team_id = $1 ORDER BY created_at`, [req.params.id]);
    res.json({ team: meta[0] || null, members: rows, documents, payments });
  } catch (err) { next(err); }
});

// ── PUT /api/admin/teams/:team_id/members/:member_id/verify — CPR tick ────────
router.put('/teams/:team_id/members/:member_id/verify', requireRole(...editRoles), async (req, res, next) => {
  try {
    const verified = req.body.verified !== false;
    const { rows } = await pool.query(
      `UPDATE team_members SET
         cpr_verified = $1::boolean,
         cpr_verified_at = CASE WHEN $1::boolean THEN NOW() ELSE NULL END,
         cpr_verified_by = CASE WHEN $1::boolean THEN $2::int ELSE NULL END
       WHERE id = $3::int AND team_id = $4::int RETURNING id, cpr_verified`,
      [verified, req.user.id, req.params.member_id, req.params.team_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Team member not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'TEAM_MEMBER_CPR_VERIFY', entity: 'team_members', entityId: req.params.member_id, details: { verified } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/teams/:id/notify — WhatsApp the team leader (editable) ────
router.post('/teams/:id/notify', requireRole('SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Registrar'), async (req, res, next) => {
  try {
    const message = (req.body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message is required' });
    // Channel: 'email' (default — WhatsApp via Green-API is often blocked),
    // 'whatsapp', or 'both'.
    const channel = ['whatsapp', 'email', 'both'].includes(req.body.channel) ? req.body.channel : 'email';
    const subject = (req.body.subject || '').trim();

    const { rows } = await pool.query(
      `SELECT t.team_name, t.year_id, u.email, u.whatsapp_number, u.whatsapp_number_2, u.phone
         FROM teams t LEFT JOIN users u ON u.id = t.created_by WHERE t.id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Team not found' });
    const r = rows[0];
    const wantWa = channel === 'whatsapp' || channel === 'both';
    const wantEmail = channel === 'email' || channel === 'both';

    const escHtml = (x) => String(x ?? '').replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    let waResult = null, emailResult = null, waRecipients = 0;
    let emailTo = null;

    if (wantWa) {
      const nums = [r.whatsapp_number, r.whatsapp_number_2].filter(Boolean);
      if (!nums.length && r.phone) nums.push(r.phone);
      waRecipients = nums.length;
      if (nums.length) waResult = await sendWhatsAppMany(nums, message);
    }
    if (wantEmail && r.email) {
      emailTo = r.email;
      const { rows: yl } = await pool.query(
        `SELECT event_year_label, its_logo_url FROM year_config WHERE id = $1`, [r.year_id]);
      const bodyHtml = `<p>${escHtml(message).replace(/\n/g, '<br/>')}</p>`;
      emailResult = await sendEmail({
        to: r.email,
        subject: subject || `${yl[0]?.event_year_label || 'KCA ITS'} — ${r.team_name} (team registration)`,
        html: customEmailHtml({ yearLabel: yl[0]?.event_year_label, logoUrl: yl[0]?.its_logo_url, bodyHtml }),
      });
    }

    // Nothing could be sent on any requested channel → tell the caller why.
    if (wantEmail && !r.email && !wantWa)
      return res.status(400).json({ error: 'No email address on file for this team.' });
    if (wantWa && !waRecipients && !wantEmail)
      return res.status(400).json({ error: 'No contact number on file for this team.' });

    const email_sent = !!(emailResult && emailResult.sent);
    const wa_delivered = !!(waResult && waResult.delivered);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'TEAM_NOTIFY', entity: 'teams', entityId: req.params.id,
      details: { channel, email_sent, email_to: emailTo, wa_delivered, wa_recipients: waRecipients } });
    res.json({
      channel, email_sent, email_to: emailTo,
      email_error: emailResult && !emailResult.sent ? (emailResult.error || 'send failed') : null,
      wa_delivered, wa_sent: waResult ? waResult.sent : null, wa_recipients: waRecipients,
    });
  } catch (err) { next(err); }
});

// ── Participant verification (View drawer) ───────────────────────────────────

// GET /api/admin/participants/:id/detail — everything the admin needs to
// verify a participant: identity + scans, registrations, payments, audit.
router.get('/participants/:id/detail', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: pRows } = await pool.query(
      `SELECT p.*, s.name AS school_name, ag.code AS age_group_code, ag.label AS age_group_label,
              u.full_name AS parent_name, u.email AS parent_email, u.phone AS parent_phone,
              u.whatsapp_number AS parent_whatsapp, u.whatsapp_number_2 AS parent_whatsapp_2, u.membership_status AS parent_membership_status,
              vu.full_name AS admin_verified_by_name
       FROM participants p
       LEFT JOIN schools s ON s.id = p.school_id
       LEFT JOIN age_groups ag ON ag.id = p.age_group_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users vu ON vu.id = p.admin_verified_by
       WHERE p.id = $1`, [req.params.id]);
    if (!pRows[0]) return res.status(404).json({ error: 'Participant not found' });

    const { rows: regs } = await pool.query(
      `SELECT r.id, r.event_id, r.status, r.fee_amount, r.dance_teacher, r.music_teacher,
              e.event_code, e.event_name, c.name AS category_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN categories c ON c.id = e.category_id
       WHERE r.participant_id = $1 ORDER BY e.event_code`, [req.params.id]);

    const { rows: payments } = await pool.query(
      `SELECT id, amount, method, status, reference, proof_url, notes, created_at, confirmed_at
       FROM payments WHERE participant_id = $1 ORDER BY created_at`, [req.params.id]);

    const { rows: audit } = await pool.query(
      `SELECT a.id, a.table_name, a.record_id, a.action, a.old_value, a.new_value,
              a.reason, a.changed_at, u.full_name AS changed_by_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.changed_by
       WHERE (a.table_name = 'participants' AND a.record_id = $1)
          OR (a.table_name = 'payments' AND a.record_id IN (SELECT id FROM payments WHERE participant_id = $1))
          OR (a.table_name = 'registrations' AND a.record_id IN (SELECT id FROM registrations WHERE participant_id = $1))
       ORDER BY a.changed_at DESC LIMIT 50`, [req.params.id]);

    res.json({ participant: pRows[0], registrations: regs, payments, audit });
  } catch (err) { next(err); }
});

// POST /api/admin/participants/:id/verify — mark CPR/identity verified, or
// flag an issue (mandatory note) which notifies the parent to correct it.
router.post('/participants/:id/verify', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { status, note } = req.body;
    if (!['verified', 'issue'].includes(status))
      return res.status(400).json({ error: "status must be 'verified' or 'issue'" });
    if (status === 'issue' && !note?.trim())
      return res.status(400).json({ error: 'A note describing the issue is required' });

    const { rows: before } = await pool.query(
      `SELECT admin_verified_status, admin_verify_note FROM participants WHERE id = $1`, [req.params.id]);
    if (!before[0]) return res.status(404).json({ error: 'Participant not found' });

    const { rows } = await pool.query(
      `UPDATE participants SET
         admin_verified_status = $1,
         admin_verified_by = $2,
         admin_verified_at = NOW(),
         admin_verify_note = $3,
         updated_at = NOW()
       WHERE id = $4
       RETURNING id, full_name, guardian_phone, created_by,
                 admin_verified_status, admin_verify_note`, 
      [status, req.user.id, note?.trim() || null, req.params.id]);
    const p = rows[0];

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ADMIN_VERIFY_CPR', entity: 'participants', entityId: p.id,
      before: before[0],
      details: { admin_verified_status: status, note: note?.trim() || null },
      reason: note?.trim() || 'CPR/identity check' });

    // Notify the parent when an issue is flagged so they can correct it
    let notified = false;
    if (status === 'issue') {
      if (p.guardian_phone) {
        sendWhatsApp(p.guardian_phone,
          `KCA ITS: A problem was found while verifying ${p.full_name}'s CPR details: ` +
          `"${note.trim()}". Please open the registration portal and correct the details.`)
          .catch(() => null);
        notified = true;
      }
      const { rows: u } = await pool.query(`SELECT email FROM users WHERE id = $1`, [p.created_by]);
      if (u[0]?.email) {
        sendEmail({
          to: u[0].email,
          subject: `KCA ITS — Action needed: ${p.full_name}'s CPR details`,
          html: `<p>Dear parent,</p><p>While verifying <b>${p.full_name}</b>'s registration we found:</p>
                 <blockquote>${note.trim()}</blockquote>
                 <p>Please sign in to the registration portal, open your child's page and correct the
                 details (you can re-scan the CPR card there). The registration will be re-verified after
                 your update.</p><p>— KCA Indian Talent Scan</p>`,
        }).catch(() => null);
        notified = true;
      }
    }
    res.json({ ...p, parent_notified: notified });
  } catch (err) { next(err); }
});

// PUT /api/admin/participants/:id/events — CHAIRMAN-ONLY event corrections
// (add/remove regardless of parent deadlines). Fully audited before/after.
// ── GET /api/admin/participants/eligible-events ──────────────────────────────
// Events a participant can be ADDED to via a Chairman correction. Unlike the
// public catalog (/api/register/events), this INCLUDES split/merged events
// (is_generated = TRUE) — e.g. after L07 was split, a late-confirmed child can
// be placed into L07A. Excludes cancelled events and cancelled age-group cells.
router.get('/participants/eligible-events', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { rows: yr } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    if (!yr[0]) return res.json([]);
    const yearId = yr[0].id;
    const ageGroupId = req.query.age_group_id ? Number(req.query.age_group_id) : null;
    const gender = req.query.gender || null;
    if (!ageGroupId) return res.status(400).json({ error: 'age_group_id is required' });

    const { rows } = await pool.query(
      `SELECT DISTINCT e.id, e.event_name, e.event_code, e.event_kind, e.fee_amount, e.member_fee_amount,
              e.gender_split, e.is_generated, c.name AS category_name
         FROM events e
         JOIN event_age_groups eag ON eag.event_id = e.id AND eag.age_group_id = $2
         LEFT JOIN categories c ON c.id = e.category_id
        WHERE e.year_id = $1 AND e.event_kind = 'individual' AND e.is_cancelled = FALSE
          AND NOT EXISTS (SELECT 1 FROM event_consolidations x
                           WHERE x.kind = 'cancel' AND x.reverted_at IS NULL
                             AND x.source_event_ids[1] = e.id AND x.age_group_id = $2)
        ORDER BY e.event_code`,
      [yearId, ageGroupId]);

    const filtered = gender ? rows.filter((e) => genderEligible(e.gender_split, gender)) : rows;
    res.json(filtered);
  } catch (err) { next(err); }
});

router.put('/participants/:id/events', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { add_event_ids = [], remove_event_ids = [], reason } = req.body;
    if (!reason?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A reason is required for event corrections' });
    }

    const { rows: pRows } = await client.query(
      `SELECT p.*, u.membership_status AS parent_membership
       FROM participants p LEFT JOIN users u ON u.id = p.created_by
       WHERE p.id = $1`, [req.params.id]);
    const p = pRows[0];
    if (!p) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Participant not found' }); }

    const { rows: beforeRegs } = await client.query(
      `SELECT e.event_code FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY e.event_code`, [req.params.id]);

    const memberActive = p.parent_membership === 'active';
    const added = [], removed = [];

    for (const eventId of remove_event_ids) {
      const { rows } = await client.query(
        `UPDATE registrations r SET status = 'withdrawn', updated_at = NOW()
         FROM events e
         WHERE r.participant_id = $1 AND r.event_id = $2 AND r.status = 'registered' AND e.id = r.event_id
         RETURNING r.id, r.fee_amount, e.event_code, e.event_name`,
        [req.params.id, eventId]);
      for (const reg of rows) {
        await client.query(
          `INSERT INTO refunds (year_id, participant_id, registration_id, events_withdrawn,
                                reason, original_amount, refund_amount, status, requested_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)`,
          [p.year_id, p.id, reg.id, `${reg.event_code} — ${reg.event_name}`,
           `Chairman correction: ${reason.trim()}`, reg.fee_amount || 0, reg.fee_amount || 0, req.user.id]);
        removed.push(reg.event_code);
      }
    }

    for (const eventId of add_event_ids) {
      const { rows: ev } = await client.query(
        `SELECT e.id, e.category_id, e.fee_amount, e.member_fee_amount, e.event_code
         FROM events e JOIN event_age_groups eag ON eag.event_id = e.id
         WHERE e.id = $1 AND eag.age_group_id = $2 AND e.is_cancelled = FALSE
           AND e.event_kind = 'individual'`,
        [eventId, p.age_group_id]);
      if (!ev[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Event ${eventId} is not eligible for this participant` }); }
      const { rows: dup } = await client.query(
        `SELECT id, status FROM registrations WHERE participant_id = $1 AND event_id = $2`,
        [p.id, eventId]);
      if (dup[0] && dup[0].status !== 'withdrawn') continue; // already active
      const fee = memberActive && ev[0].member_fee_amount != null
        ? Number(ev[0].member_fee_amount) : Number(ev[0].fee_amount || 0);
      if (dup[0]) {
        // Reactivate a previously-withdrawn registration (the partial unique index
        // on (participant_id, event_id) blocks a fresh INSERT).
        await client.query(
          `UPDATE registrations SET status = 'registered', fee_amount = $1, age_group_id = $2,
             category_id = $3, registered_by = $4, updated_at = NOW() WHERE id = $5`,
          [fee, p.age_group_id, ev[0].category_id, req.user.id, dup[0].id]);
      } else {
        await client.query(
          `INSERT INTO registrations (year_id, participant_id, event_id, age_group_id, category_id,
                                      fee_amount, status, registered_by, registered_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())`,
          [p.year_id, p.id, eventId, p.age_group_id, ev[0].category_id, fee, req.user.id]);
      }
      added.push(ev[0].event_code);
    }

    const { rows: afterRegs } = await client.query(
      `SELECT e.event_code FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY e.event_code`, [req.params.id]);

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CHAIRMAN_EVENT_CORRECTION', entity: 'participants', entityId: p.id,
      before: { events: beforeRegs.map((r) => r.event_code) },
      details: { events: afterRegs.map((r) => r.event_code), added, removed },
      reason: reason.trim() });

    res.json({ added, removed, events: afterRegs.map((r) => r.event_code) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /api/admin/participants/:id/cancel-nonpayment ───────────────────────
// One-click cancellation of an individual participant's entry for NON-PAYMENT.
// Withdraws every currently-registered event (status = 'registered') at once,
// with a mandatory reason recorded in the audit trail. Unlike a Chairman event
// correction it creates NO refund rows — nothing was paid, so there is nothing
// to refund. Reversible: re-add the events via a Chairman correction if they pay.
router.post('/participants/:id/cancel-nonpayment', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { reason } = req.body || {};
    if (!reason?.trim()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'A reason is required to cancel a registration' });
    }
    const { rows: pRows } = await client.query(`SELECT id FROM participants WHERE id = $1`, [req.params.id]);
    if (!pRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Participant not found' }); }

    const { rows: before } = await client.query(
      `SELECT e.event_code FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped') ORDER BY e.event_code`, [req.params.id]);

    const { rows: withdrawn } = await client.query(
      `UPDATE registrations r SET status = 'withdrawn', updated_at = NOW()
       FROM events e
       WHERE r.participant_id = $1 AND r.status = 'registered' AND e.id = r.event_id
       RETURNING e.event_code`, [req.params.id]);

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CANCEL_NONPAYMENT', entity: 'participants', entityId: req.params.id,
      before: { events: before.map((r) => r.event_code) },
      details: { withdrawn: withdrawn.map((r) => r.event_code) },
      reason: reason.trim() });

    res.json({ withdrawn: withdrawn.map((r) => r.event_code), count: withdrawn.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── GET /api/admin/schools ────────────────────────────────────────────────────
// Lookup list for school filter dropdowns.
router.get('/schools', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, short_code FROM schools WHERE is_active = TRUE ORDER BY name`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});


// ── Incomplete-registration reminders (WhatsApp) ─────────────────────────────
const REMINDER_ROLES = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Registrar'];

function reminderStatusLine(events, hasPayment) {
  if (events.length && hasPayment)
    return `Your events (${events.map((e) => e.event_name).join(', ')}) and payment have been received — only the final confirmation step is pending.`;
  if (events.length)
    return `You have chosen ${events.length} event${events.length === 1 ? '' : 's'}, but the payment and the final confirmation step are still pending.`;
  return `Your details are saved, but the events have not been selected yet.`;
}
function reminderMessage(parentName, childName, statusLine) {
  return `Dear ${parentName || 'Parent'},\n\n` +
    `Greetings from KCA Indian Talent Scan (ITS) 2026.\n\n` +
    `We noticed that the registration for ${childName} was started but has not been completed yet. ${statusLine}\n\n` +
    `To confirm the entry, please sign in to the registration portal and finish the final step — "Complete Registration" (you will be asked to agree to the rules and regulations and submit): https://talentscan.kcabah.com/register — before the deadline on 8 October 2026.\n\n` +
    `If anything is preventing you from completing it, please let us know — reply to this message or contact us on WhatsApp 3898 4900, and we will be glad to help.\n\n` +
    `Warm regards,\nKCA Indian Talent Scan Team`;
}
async function reminderContext(participantId) {
  const { rows: pr } = await pool.query(
    `SELECT p.id, p.full_name, p.guardian_name, p.guardian_phone, p.confirmed_at, p.last_reminder_at,
            u.full_name AS parent_name, u.whatsapp_number_2 AS parent_whatsapp_2
     FROM participants p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = $1`, [participantId]);
  if (!pr[0]) return null;
  const { rows: evs } = await pool.query(
    `SELECT e.event_code, e.event_name FROM registrations r JOIN events e ON e.id = r.event_id
     WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped') ORDER BY e.event_code`, [participantId]);
  const { rows: pay } = await pool.query(
    `SELECT 1 FROM payments WHERE participant_id = $1 AND status IN ('pending','confirmed') LIMIT 1`, [participantId]);
  const parentName = pr[0].guardian_name || pr[0].parent_name || 'Parent';
  const message = reminderMessage(parentName, pr[0].full_name, reminderStatusLine(evs, pay.length > 0));
  return { p: pr[0], message };
}

// Public URL of the ITS logo (for image+caption WhatsApp), or null.
async function itsLogoUrl() {
  const { rows } = await pool.query(`SELECT its_logo_url FROM year_config WHERE is_active = TRUE LIMIT 1`);
  const logo = rows[0]?.its_logo_url;
  if (!logo) return null;
  if (/^https?:\/\//i.test(logo)) return logo;
  // The logo file is served by THIS app, not the KCA website (website_domain),
  // so WhatsApp must fetch it from the app's own public URL.
  const base = (process.env.APP_URL || 'https://talentscan.kcabah.com').replace(/\/+$/, '');
  return `${base}${logo.startsWith('/') ? '' : '/'}${logo}`;
}

// GET /participants/:id/reminder — prefilled message + last reminder date
router.get('/participants/:id/reminder', requireRole(...REMINDER_ROLES), async (req, res, next) => {
  try {
    const ctx = await reminderContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Participant not found' });
    res.json({ message: ctx.message, phone: ctx.p.guardian_phone, last_reminder_at: ctx.p.last_reminder_at, name: ctx.p.full_name });
  } catch (err) { next(err); }
});

// POST /participants/:id/remind — send one reminder (optionally edited text)
router.post('/participants/:id/remind', requireRole(...REMINDER_ROLES), async (req, res, next) => {
  try {
    const ctx = await reminderContext(req.params.id);
    if (!ctx) return res.status(404).json({ error: 'Participant not found' });
    if (!ctx.p.guardian_phone) return res.status(400).json({ error: 'No WhatsApp/contact number on file for this participant.' });
    const message = (req.body.message && req.body.message.trim()) || ctx.message;
    const logo = await itsLogoUrl();
    const out = await sendWhatsAppImageMany([ctx.p.guardian_phone, ctx.p.parent_whatsapp_2], logo, message);
    await pool.query(`UPDATE participants SET last_reminder_at = NOW(), reminder_count = COALESCE(reminder_count,0)+1 WHERE id = $1`, [req.params.id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'SEND_REMINDER', entity: 'participants', entityId: req.params.id, details: { delivered: !!out.delivered } });
    res.json({ delivered: !!out.delivered, last_reminder_at: new Date().toISOString() });
  } catch (err) { next(err); }
});

// GET /registrations/reminders/eligible — how many the bulk send will reach now
router.get('/registrations/reminders/eligible', requireRole(...REMINDER_ROLES), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    const yearId = cfg[0]?.id;
    if (!yearId) return res.json({ eligible: 0 });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM participants p
       WHERE p.year_id = $1 AND p.confirmed_at IS NULL
         AND p.guardian_phone IS NOT NULL AND p.guardian_phone <> ''
         AND (p.last_reminder_at IS NULL OR p.last_reminder_at < NOW() - INTERVAL '5 days')`, [yearId]);
    res.json({ eligible: rows[0].n });
  } catch (err) { next(err); }
});

// POST /reminders/send-bulk — remind every in-progress parent not messaged in 5 days
router.post('/registrations/reminders/send-bulk', requireRole(...REMINDER_ROLES), async (req, res, next) => {
  try {
    const { rows: cfg } = await pool.query(`SELECT id FROM year_config WHERE is_active = TRUE LIMIT 1`);
    const yearId = cfg[0]?.id;
    if (!yearId) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `SELECT p.id FROM participants p
       WHERE p.year_id = $1 AND p.confirmed_at IS NULL
         AND p.guardian_phone IS NOT NULL AND p.guardian_phone <> ''
         AND (p.last_reminder_at IS NULL OR p.last_reminder_at < NOW() - INTERVAL '5 days')
       ORDER BY p.id`, [yearId]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'SEND_REMINDER_BULK', entity: 'participants', details: { eligible: rows.length } });
    res.json({ eligible: rows.length });
    // Send in the background, throttled.
    (async () => {
      const logo = await itsLogoUrl();
      for (const r of rows) {
        try {
          const ctx = await reminderContext(r.id);
          if (ctx?.p.guardian_phone) {
            const out = await sendWhatsAppImageMany([ctx.p.guardian_phone, ctx.p.parent_whatsapp_2], logo, ctx.message).catch(() => ({ delivered: false }));
            await pool.query(`UPDATE participants SET last_reminder_at = NOW(), reminder_count = COALESCE(reminder_count,0)+1 WHERE id = $1`, [r.id]).catch(() => {});
            await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'SEND_REMINDER',
              entity: 'participants', entityId: r.id, details: { delivered: !!out.delivered, bulk: true } }).catch(() => {});
          }
        } catch { /* continue */ }
        await new Promise((done) => setTimeout(done, 900));
      }
    })();
  } catch (err) { next(err); }
});

// PUT /participants/:id/contact — staff correct the guardian name / number
router.put('/participants/:id/contact', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { guardian_name, guardian_phone, whatsapp_number_2 } = req.body;
    if (guardian_phone && String(guardian_phone).replace(/\D/g, '').length < 8)
      return res.status(400).json({ error: 'Contact number looks too short — enter a valid number.' });
    const wa2Provided = whatsapp_number_2 !== undefined;
    const wa2 = wa2Provided && whatsapp_number_2 && String(whatsapp_number_2).trim() ? String(whatsapp_number_2).trim() : null;
    if (wa2 && wa2.replace(/\D/g, '').length < 8)
      return res.status(400).json({ error: 'Second WhatsApp number looks too short — include the country code.' });
    const { rows } = await pool.query(
      `UPDATE participants SET
         guardian_name  = COALESCE(NULLIF($1, ''), guardian_name),
         guardian_phone = COALESCE(NULLIF($2, ''), guardian_phone),
         updated_at = NOW()
       WHERE id = $3 RETURNING id, guardian_name, guardian_phone`,
      [guardian_name ? guardian_name.trim() : null, guardian_phone ? guardian_phone.trim() : null, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Participant not found' });
    // The second WhatsApp number lives on the parent account — update it there.
    if (wa2Provided) {
      await pool.query(
        `UPDATE users u SET whatsapp_number_2 = $1, updated_at = NOW()
           FROM participants p WHERE p.id = $2 AND u.id = p.created_by`,
        [wa2, req.params.id]);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPDATE_GUARDIAN_CONTACT', entity: 'participants', entityId: req.params.id,
      details: { guardian_phone: rows[0].guardian_phone, whatsapp_number_2: wa2Provided ? wa2 : undefined } });
    res.json({ ...rows[0], ...(wa2Provided ? { whatsapp_number_2: wa2 } : {}) });
  } catch (err) { next(err); }
});

// PUT /participants/:id/parent-email — staff correct a parent's login email
// (e.g. entered incorrectly at signup, so reset/confirmation emails bounce).
router.put('/participants/:id/parent-email', requireRole(...editRoles), async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });

    const { rows: pr } = await pool.query(
      `SELECT p.created_by, u.email AS current_email
         FROM participants p LEFT JOIN users u ON u.id = p.created_by
        WHERE p.id = $1`, [req.params.id]);
    if (!pr[0]) return res.status(404).json({ error: 'Participant not found' });
    if (!pr[0].created_by) return res.status(400).json({ error: 'No parent account is linked to this participant.' });

    const taken = await pool.query(
      `SELECT id FROM users WHERE lower(email) = $1 AND id <> $2 LIMIT 1`, [email, pr[0].created_by]);
    if (taken.rows[0]) return res.status(409).json({ error: 'Another account already uses this email.' });

    await pool.query(`UPDATE users SET email = $1, updated_at = NOW() WHERE id = $2`, [email, pr[0].created_by]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_PARENT_EMAIL',
      entity: 'users', entityId: pr[0].created_by,
      before: { email: pr[0].current_email }, details: { email }, reason: `Corrected parent login email for participant ${req.params.id}` });
    res.json({ ok: true, parent_email: email });
  } catch (err) { next(err); }
});

// PUT /participants/:id/identity — staff correct identity fields entered wrongly
// (e.g. the CPR typed into the name). The DB triggers recompute age_group_id
// (from dob) and pwa_username (from name + cpr) automatically, so we never set
// those here. UNIQUE(year_id, cpr_number) is enforced; a DOB outside every
// configured age group is rejected by the age-group trigger.
router.put('/participants/:id/identity', requireRole(...editRoles), async (req, res, next) => {
  try {
    const sets = [];
    const vals = [];
    const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (req.body.full_name !== undefined) {
      const v = String(req.body.full_name || '').trim();
      if (!v) return res.status(400).json({ error: 'Full name cannot be empty.' });
      add('full_name', v);
    }
    if (req.body.cpr_number !== undefined) {
      const v = String(req.body.cpr_number || '').trim();
      if (v.replace(/\D/g, '').length < 6) return res.status(400).json({ error: 'CPR number looks too short.' });
      add('cpr_number', v);
    }
    if (req.body.dob !== undefined) {
      const v = String(req.body.dob || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v).getTime()))
        return res.status(400).json({ error: 'Enter a valid date of birth.' });
      add('dob', v);
    }
    if (req.body.gender !== undefined) {
      const v = String(req.body.gender || '').trim().toUpperCase();
      if (v && v !== 'M' && v !== 'F') return res.status(400).json({ error: 'Gender must be Male or Female.' });
      add('gender', v || null);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    const { rows: before } = await pool.query(
      `SELECT full_name, cpr_number, dob, gender FROM participants WHERE id = $1`, [req.params.id]);
    if (!before[0]) return res.status(404).json({ error: 'Participant not found' });

    vals.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE participants SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $${vals.length}
        RETURNING id, full_name, cpr_number, dob, gender, age_group_id, pwa_username`, vals);

    const { rows: ag } = await pool.query(`SELECT code FROM age_groups WHERE id = $1`, [rows[0].age_group_id]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'EDIT_PARTICIPANT_IDENTITY',
      entity: 'participants', entityId: req.params.id, before: before[0],
      details: { full_name: rows[0].full_name, cpr_number: rows[0].cpr_number, dob: rows[0].dob, gender: rows[0].gender },
      reason: 'Staff corrected participant identity details' });
    res.json({ ...rows[0], age_group_code: ag[0]?.code || null });
  } catch (err) {
    if (err && err.code === '23505')
      return res.status(409).json({ error: 'Another participant in this year already has that CPR number.' });
    if (err && /age group/i.test(err.message || ''))
      return res.status(400).json({ error: 'That date of birth does not fall in any configured age group for this year.' });
    next(err);
  }
});

// POST /participants/:id/upload — staff upload or replace a participant's CPR
// scan (front/back) or photo on the parent's behalf (some parents can't redo
// it and send the images to the office). Field: file; kind: photo|cpr_front|cpr_back.
router.post('/participants/:id/upload', requireRole(...editRoles),
  imageUpload.single('file'), async (req, res, next) => {
  try {
    const kind = String(req.body.kind || req.query.kind || '').trim();
    const col = PARTICIPANT_IMAGE_COLUMN[kind];
    if (!col) return res.status(400).json({ error: "kind must be 'photo', 'cpr_front' or 'cpr_back'." });
    if (!req.file) return res.status(400).json({ error: 'Please attach an image (PNG or JPG).' });
    const url = `/uploads/${req.file.filename}`;
    const { rows } = await pool.query(
      `UPDATE participants SET ${col} = $1, updated_at = NOW() WHERE id = $2 RETURNING id`,
      [url, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Participant not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'UPLOAD_PARTICIPANT_IMAGE', entity: 'participants', entityId: Number(req.params.id),
      details: { kind, url }, reason: `Staff uploaded ${kind.replace('_', ' ')} on the parent's behalf` });
    res.json({ url, kind });
  } catch (err) { next(err); }
});


// ════════════════════════════════════════════════════════════════════════════
// Walk-in Excel import  —  template · validate (dry-run) · commit
// ────────────────────────────────────────────────────────────────────────────
// For parents who give all details in person / over WhatsApp and pay in office.
// Staff fill the template, upload it, review a validation report, then commit.
// Validation performs NO writes. Commit is transactional + idempotent: existing
// parents/participants/registrations are reused, never duplicated or altered
// beyond harmless back-fills, so live data is safe.
// ════════════════════════════════════════════════════════════════════════════

// ── Fee waiver / adjustment (admin) ──────────────────────────────────────────
// Sponsor-related or hardship cases sometimes get a full waiver (free) or a
// discounted fee. This sets the fee on a participant's active event entries —
// zero for free, or any reduced amount per event — with a mandatory reason that
// is audited. After adjusting, complete the registration as usual: the balance
// reflects the new (lower / zero) fee, so no phantom amount is left due.
router.post('/registrations/participant/:id/waive-fees',
  requireRole(...editRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { mode, fees, reason } = req.body || {};
    if (!reason || !String(reason).trim())
      return res.status(400).json({ error: 'A reason is required for a fee waiver or discount.' });

    await client.query('BEGIN');
    const { rows: regs } = await client.query(
      `SELECT r.id, r.fee_amount, e.event_code
       FROM registrations r JOIN events e ON e.id = r.event_id
       WHERE r.participant_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY e.event_code`, [req.params.id]);
    if (!regs.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No active event entries to adjust.' });
    }

    const updated = [];
    if (mode === 'free') {
      for (const r of regs) {
        if (Number(r.fee_amount) !== 0) {
          await client.query(`UPDATE registrations SET fee_amount = 0, updated_at = NOW() WHERE id = $1`, [r.id]);
        }
        updated.push({ id: r.id, event_code: r.event_code, was: Number(r.fee_amount), now: 0 });
      }
    } else {
      // custom: fees is a map { registration_id: amount } for this participant's rows
      if (!fees || typeof fees !== 'object') {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Provide the new fee for each event.' });
      }
      const byId = new Map(regs.map((r) => [String(r.id), r]));
      for (const [rid, val] of Object.entries(fees)) {
        const r = byId.get(String(rid));
        if (!r) continue; // ignore ids that aren't this participant's active rows
        const amt = Number(val);
        if (!(amt >= 0)) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: `Fee for ${r.event_code} must be zero or more.` });
        }
        if (round3(amt) !== Number(r.fee_amount)) {
          await client.query(`UPDATE registrations SET fee_amount = $1, updated_at = NOW() WHERE id = $2`, [round3(amt), r.id]);
        }
        updated.push({ id: r.id, event_code: r.event_code, was: Number(r.fee_amount), now: round3(amt) });
      }
    }

    // Recompute the true balance after the fee changes and cancel any pending
    // payments that are no longer needed (e.g. a full waiver), so they don't
    // linger as "pending" or get confirmed by mistake. Internal cleanup — the
    // parent is not notified here; confirmed payments are never touched.
    const { rows: dueRows } = await client.query(
      `SELECT COALESCE(SUM(fee_amount),0) AS due FROM registrations
       WHERE participant_id = $1 AND status NOT IN ('withdrawn','swapped')`, [req.params.id]);
    const { rows: paidRows } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS paid FROM payments
       WHERE participant_id = $1 AND status = 'confirmed'`, [req.params.id]);
    const newTotalDue = Number(dueRows[0].due);
    const balance = newTotalDue - Number(paidRows[0].paid);
    let cancelled_pending = 0;
    if (balance <= 0.0001) {
      const r2 = await client.query(
        `UPDATE payments SET status = 'rejected', confirmed_by = $2, confirmed_at = NOW(),
           notes = COALESCE(notes || E'\n','') || 'Auto-cancelled: fee waived/adjusted — no balance due',
           updated_at = NOW()
         WHERE participant_id = $1 AND status = 'pending'`, [req.params.id, req.user.id]);
      cancelled_pending = r2.rowCount || 0;
    }

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ADJUST_FEES', entity: 'participants', entityId: Number(req.params.id),
      details: { mode: mode === 'free' ? 'waive-free' : 'custom', changes: updated, cancelled_pending },
      reason: String(reason).trim() });

    res.json({ updated, new_total: Number(newTotalDue.toFixed(3)), cancelled_pending });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});


const IMPORT_COLUMNS = [
  'Full Name', 'CPR', 'Gender (M/F)', 'DOB (YYYY-MM-DD)', 'School',
  'Parent Name', 'Parent Email', 'Parent Phone', 'WhatsApp', 'KCA Member No',
  'Event Codes', 'Cash Paid (BD)', 'Payment Method', 'Payment Ref',
];

// Flexible header → canonical key mapping (case/space-insensitive).
const HEADER_ALIASES = {
  full_name:   ['full name', 'participant', 'name', 'participant name'],
  cpr:         ['cpr', 'cpr number', 'cpr no', 'cpr no.'],
  gender:      ['gender', 'gender (m/f)', 'sex'],
  dob:         ['dob', 'dob (yyyy-mm-dd)', 'date of birth', 'birth date'],
  school:      ['school', 'school name'],
  parent_name: ['parent', 'parent name', 'guardian', 'guardian name'],
  parent_email:['parent email', 'email', 'e-mail'],
  parent_phone:['parent phone', 'phone', 'contact', 'contact number', 'mobile'],
  whatsapp:    ['whatsapp', 'whatsapp number', 'whatsapp no', 'wa'],
  member_no:   ['kca member no', 'member no', 'kca membership no', 'membership no', 'kca member'],
  event_codes: ['event codes', 'events', 'event code', 'event'],
  cash:        ['cash paid (bd)', 'cash paid', 'amount paid', 'paid', 'amount'],
  pay_method:  ['payment method', 'method'],
  pay_ref:     ['payment ref', 'reference', 'receipt no', 'receipt', 'txn no'],
};

const OFFICE_EMAIL = 'walkin.office@its.local';

function normHeader(h) { return String(h ?? '').trim().toLowerCase(); }

function keyForHeader(h) {
  const n = normHeader(h);
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(n)) return key;
  }
  return null;
}

// Excel cells: a DOB may be a JS Date (date cell) or a string. Normalise to
// 'YYYY-MM-DD' using UTC parts (exceljs stores dates at UTC midnight).
function parseDob(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(v.getUTCDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);          // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);              // DD-MM-YYYY
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d)) return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return null; // unparseable
}

const cellText = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return String(v.text).trim();           // rich text / hyperlink
    if (v.result != null) return String(v.result).trim(); // formula
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
};

function splitCodes(raw) {
  return [...new Set(
    String(raw ?? '').split(/[\s,;/|]+/).map((c) => c.trim().toUpperCase()).filter(Boolean),
  )];
}

// Parse the uploaded workbook into an array of raw row objects keyed canonically.
async function parseImportWorkbook(buffer) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  // Prefer a sheet named "Registrations"; else the first worksheet.
  const ws = wb.getWorksheet('Registrations') || wb.worksheets[0];
  if (!ws) return { error: 'The workbook has no sheets.' };

  // Build header map from the first row.
  const headerRow = ws.getRow(1);
  const colKey = {}; // column index → canonical key
  headerRow.eachCell((cell, col) => {
    const k = keyForHeader(cell.value);
    if (k) colKey[col] = k;
  });
  if (!Object.values(colKey).includes('full_name') || !Object.values(colKey).includes('cpr')) {
    return { error: 'Could not find the expected header row (need at least "Full Name" and "CPR"). Use the provided template.' };
  }

  const dobCol = Object.keys(colKey).find((c) => colKey[c] === 'dob');
  const rows = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = { _row: rowNumber };
    let any = false;
    for (const [col, key] of Object.entries(colKey)) {
      const raw = row.getCell(Number(col)).value;
      obj[key] = key === 'dob' ? parseDob(raw) : cellText(raw);
      if (key === 'dob' ? raw != null : obj[key]) any = true;
    }
    obj._dobRaw = dobCol ? cellText(row.getCell(Number(dobCol)).value) : '';
    // skip blank rows and the template EXAMPLE row
    if (!any) return;
    if (/^example\b/i.test(obj.full_name || '')) return;
    rows.push(obj);
  });
  return { rows };
}

// Shared validation — builds a per-row plan with resolved ids for commit.
// Pure reads only.
async function buildImportPlan(db, rows) {
  const { rows: cfg } = await db.query(
    `SELECT id, max_individual_events FROM year_config WHERE is_active = TRUE LIMIT 1`);
  const year = cfg[0];
  if (!year) return { error: 'No active year is configured.' };

  const { rows: schools } = await db.query(
    `SELECT id, name FROM schools WHERE is_active = TRUE`);
  const schoolByName = new Map(schools.map((s) => [s.name.trim().toLowerCase(), s]));

  const { rows: events } = await db.query(
    `SELECT id, event_code, event_name, fee_amount, member_fee_amount, gender_split,
            category_id, is_cancelled
     FROM events WHERE year_id = $1 AND event_kind = 'individual'`, [year.id]);
  const eventByCode = new Map(events.map((e) => [e.event_code.trim().toUpperCase(), e]));

  const { rows: eag } = await db.query(
    `SELECT eag.event_id, eag.age_group_id FROM event_age_groups eag
     JOIN events e ON e.id = eag.event_id WHERE e.year_id = $1`, [year.id]);
  const ageGroupsByEvent = new Map();
  for (const r of eag) {
    if (!ageGroupsByEvent.has(r.event_id)) ageGroupsByEvent.set(r.event_id, new Set());
    ageGroupsByEvent.get(r.event_id).add(r.age_group_id);
  }

  const plan = [];
  for (const row of rows) {
    const errors = [];
    const warnings = [];
    const full_name = (row.full_name || '').trim();
    const cpr = (row.cpr || '').replace(/\s/g, '');
    const gender = (row.gender || '').trim().toUpperCase().slice(0, 1);
    const dob = row.dob; // already normalised or null
    const entry = {
      row: row._row, full_name, cpr,
      gender: gender === 'M' || gender === 'F' ? gender : '',
      dob, school_name: (row.school || '').trim(),
      parent_name: (row.parent_name || '').trim(),
      parent_email: (row.parent_email || '').trim().toLowerCase(),
      parent_phone: (row.parent_phone || '').trim(),
      whatsapp: (row.whatsapp || '').trim(),
      member_no: (row.member_no || '').trim(),
      cash: Number(row.cash || 0) || 0,
      pay_method: (row.pay_method || '').trim().toLowerCase().replace(/\s+/g, '_') || 'cash',
      pay_ref: (row.pay_ref || '').trim(),
      errors, warnings,
    };

    // Required identity fields
    if (!full_name) errors.push('Full name is required');
    if (!cpr) errors.push('CPR is required');
    if (!(gender === 'M' || gender === 'F')) errors.push('Gender must be M or F');
    if (!dob) errors.push(`Date of birth missing or unreadable${row._dobRaw ? ` ("${row._dobRaw}")` : ''} — use YYYY-MM-DD`);

    // CPR ↔ DOB
    if (cpr && dob) {
      const cprErr = cprDobMismatch(cpr, dob);
      if (cprErr) errors.push(cprErr);
    }

    // Age group from DOB
    let ageGroupId = null;
    if (dob) {
      ageGroupId = await resolveAgeGroup(dob, year.id, db);
      if (!ageGroupId) errors.push(`Date of birth ${dob} does not fall in any age group`);
    }
    entry.age_group_id = ageGroupId;

    // School (optional but validated if given)
    let schoolId = null;
    if (entry.school_name) {
      const sc = schoolByName.get(entry.school_name.toLowerCase());
      if (sc) schoolId = sc.id;
      else errors.push(`School "${entry.school_name}" not found — check spelling against the Schools tab`);
    } else {
      warnings.push('No school given');
    }
    entry.school_id = schoolId;

    // Phone sanity (non-blocking)
    if (entry.parent_phone && !isBahrainPhone(entry.parent_phone)) warnings.push('Parent phone is not a valid 8-digit Bahrain number');
    if (entry.whatsapp && !isIntlPhone(entry.whatsapp)) warnings.push('WhatsApp number looks invalid');

    // Payment method
    if (!['cash', 'benefitpay', 'bank_transfer'].includes(entry.pay_method)) {
      warnings.push(`Unknown payment method "${entry.pay_method}" — treated as cash`);
      entry.pay_method = 'cash';
    }

    // Parent account resolution (reuse by email / create / office fallback)
    let parentMember = false;
    if (entry.parent_email) {
      const { rows: u } = await db.query(
        `SELECT id, membership_status FROM users WHERE email = $1`, [entry.parent_email]);
      if (u[0]) { entry.parent_action = 'reuse'; entry.parent_id = u[0].id; parentMember = u[0].membership_status === 'active'; }
      else entry.parent_action = 'create';
    } else {
      entry.parent_action = 'office';
      warnings.push('No parent email — will be grouped under the shared office account');
    }
    entry.member_rate = parentMember;

    // Existing participant?
    let participant = null;
    if (cpr) {
      const { rows: p } = await db.query(
        `SELECT id, confirmed_at, gender, school_id FROM participants WHERE cpr_number = $1 AND year_id = $2`,
        [cpr, year.id]);
      participant = p[0] || null;
    }
    entry.participant_id = participant?.id || null;
    entry.participant_exists = !!participant;
    if (participant?.confirmed_at) warnings.push('This participant is already completed — events will be added if new');

    // Event codes
    const codes = splitCodes(row.event_codes);
    if (codes.length === 0) errors.push('At least one event code is required');
    const resolvedEvents = [];
    let totalFee = 0;
    for (const code of codes) {
      const ev = eventByCode.get(code);
      if (!ev) { errors.push(`Event code "${code}" not found (individual events only)`); continue; }
      if (ev.is_cancelled) { errors.push(`Event "${code}" is cancelled`); continue; }
      if (ageGroupId && !(ageGroupsByEvent.get(ev.id)?.has(ageGroupId))) {
        errors.push(`Event "${code}" is not open to this child's age group`); continue;
      }
      if (!genderEligible(ev.gender_split, entry.gender)) {
        errors.push(`Event "${code}" is restricted to ${ev.gender_split} only`); continue;
      }
      // already registered?
      let action = 'add';
      if (participant) {
        const { rows: ex } = await db.query(
          `SELECT status FROM registrations WHERE participant_id = $1 AND event_id = $2`,
          [participant.id, ev.id]);
        if (ex[0] && ex[0].status !== 'withdrawn') action = 'skip';
      }
      const fee = eventFee(ev, parentMember);
      if (action === 'add') totalFee = round3(totalFee + fee);
      resolvedEvents.push({ code, event_id: ev.id, event_name: ev.event_name,
        category_id: ev.category_id, fee, action });
    }
    entry.events = resolvedEvents;
    entry.total_fee = totalFee;
    const toAdd = resolvedEvents.filter((e) => e.action === 'add').length;

    // Max individual events cap (existing active + new)
    if (participant && toAdd > 0) {
      const { rows: cnt } = await db.query(
        `SELECT COUNT(*)::int AS c FROM registrations
         WHERE participant_id = $1 AND status NOT IN ('withdrawn','swapped')`, [participant.id]);
      if (cnt[0].c + toAdd > year.max_individual_events)
        errors.push(`Would exceed the ${year.max_individual_events}-event limit (already has ${cnt[0].c})`);
    } else if (toAdd > year.max_individual_events) {
      errors.push(`More than the ${year.max_individual_events}-event limit`);
    }

    entry.will_import = errors.length === 0 && toAdd > 0;
    if (errors.length === 0 && toAdd === 0) warnings.push('All listed events are already registered — nothing new to add');
    entry.status = errors.length ? 'error' : (toAdd === 0 ? 'skip' : (warnings.length ? 'warning' : 'ok'));
    plan.push(entry);
  }

  const summary = {
    total: plan.length,
    importable: plan.filter((p) => p.will_import).length,
    errors: plan.filter((p) => p.status === 'error').length,
    skip: plan.filter((p) => p.status === 'skip').length,
    warnings: plan.filter((p) => p.status === 'warning').length,
  };
  return { year, plan, summary };
}

// Strip internal ids before returning the plan to the browser.
function publicPlan(plan) {
  return plan.map((p) => ({
    row: p.row, status: p.status, will_import: p.will_import,
    full_name: p.full_name, cpr: p.cpr, gender: p.gender, dob: p.dob,
    age_group_id: p.age_group_id, school_name: p.school_name,
    parent_name: p.parent_name, parent_email: p.parent_email, parent_action: p.parent_action,
    member_rate: p.member_rate,
    events: p.events.map((e) => ({ code: e.code, event_name: e.event_name, fee: e.fee, action: e.action })),
    total_fee: p.total_fee, cash: p.cash, pay_method: p.pay_method,
    errors: p.errors, warnings: p.warnings,
  }));
}

// GET template workbook
router.get('/registrations/import/template', requireRole(...editRoles), async (req, res, next) => {
  try {
    const ExcelJS = require('exceljs');
    const { rows: cfg } = await pool.query(
      `SELECT id, event_year_label, max_individual_events FROM year_config WHERE is_active = TRUE LIMIT 1`);
    const year = cfg[0];
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KCA ITS';

    const ws = wb.addWorksheet('Registrations');
    ws.columns = IMPORT_COLUMNS.map((h) => ({ header: h, key: h, width: Math.max(14, h.length + 2) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    // Example row (removed automatically on import — starts with EXAMPLE)
    ws.addRow(['EXAMPLE Child Name', '101234567', 'M', '2015-03-22', '',
      'Parent Name', 'parent@email.com', '39000000', '39000000', '',
      'S01, S06', '', 'cash', '']);
    ws.getRow(2).font = { italic: true, color: { argb: 'FF999999' } };

    const ins = wb.addWorksheet('Instructions');
    ins.columns = [{ width: 100 }];
    [
      `KCA ITS — Walk-in registration import${year?.event_year_label ? ` (${year.event_year_label})` : ''}`,
      '',
      'Fill one row per child on the "Registrations" tab. Delete the grey EXAMPLE row.',
      '',
      'Required columns:  Full Name,  CPR,  Gender (M or F),  DOB (YYYY-MM-DD),  Event Codes.',
      'Event Codes: one or more codes separated by commas or spaces, e.g.  S01, S06.',
      '   See the "Event Codes" tab for valid codes (individual events only).',
      'School: must match a name on the "Schools" tab exactly (optional but recommended).',
      'Parent Email: if given, the child is linked to that parent account (created if new, so',
      '   they can later log in). If blank, the child is grouped under the shared office account.',
      'Cash Paid (BD): amount taken in office (optional). Payment Method: cash / benefitpay / bank_transfer.',
      '',
      'Nothing is saved when you upload — you first see a validation report. You then press',
      'Confirm to import. Re-running the same file will not create duplicates.',
      `Each child may register up to ${year?.max_individual_events ?? ''} individual events.`,
    ].forEach((line) => ins.addRow([line]));
    ins.getRow(1).font = { bold: true, size: 13 };

    // Reference: event codes
    const { rows: events } = await pool.query(
      `SELECT event_code, event_name, fee_amount, member_fee_amount, gender_split
       FROM events WHERE year_id = $1 AND event_kind = 'individual' AND is_cancelled = FALSE
       ORDER BY event_code`, [year?.id]);
    const evWs = wb.addWorksheet('Event Codes');
    evWs.columns = [
      { header: 'Code', key: 'c', width: 18 }, { header: 'Event', key: 'n', width: 34 },
      { header: 'Fee (BD)', key: 'f', width: 10 }, { header: 'Member Fee (BD)', key: 'm', width: 16 },
      { header: 'For', key: 'g', width: 10 },
    ];
    evWs.getRow(1).font = { bold: true };
    events.forEach((e) => evWs.addRow({
      c: e.event_code, n: e.event_name,
      f: Number(e.fee_amount || 0), m: e.member_fee_amount != null ? Number(e.member_fee_amount) : Number(e.fee_amount || 0),
      g: e.gender_split === 'boys' ? 'Boys' : e.gender_split === 'girls' ? 'Girls' : 'All',
    }));

    // Reference: schools
    const { rows: schools } = await pool.query(
      `SELECT name FROM schools WHERE is_active = TRUE ORDER BY name`);
    const scWs = wb.addWorksheet('Schools');
    scWs.columns = [{ header: 'School Name (copy exactly)', key: 's', width: 50 }];
    scWs.getRow(1).font = { bold: true };
    schools.forEach((s) => scWs.addRow({ s: s.name }));

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="its-import-template.xlsx"');
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// POST validate (dry-run) — parse + validate, NO writes.
router.post('/registrations/import/validate', requireRole(...editRoles),
  xlsxUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please attach the filled .xlsx file.' });
    const parsed = await parseImportWorkbook(req.file.buffer);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (!parsed.rows.length) return res.status(400).json({ error: 'No data rows found in the workbook.' });
    const built = await buildImportPlan(pool, parsed.rows);
    if (built.error) return res.status(400).json({ error: built.error });
    res.json({ summary: built.summary, rows: publicPlan(built.plan) });
  } catch (err) { next(err); }
});

// POST commit — re-validate then write, transactionally and idempotently.
router.post('/registrations/import/commit', requireRole(...editRoles),
  xlsxUpload.single('file'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'Please attach the filled .xlsx file.' });
    const parsed = await parseImportWorkbook(req.file.buffer);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const built = await buildImportPlan(client, parsed.rows);
    if (built.error) return res.status(400).json({ error: built.error });
    const year = built.year;

    await client.query('BEGIN');

    // Ensure the shared office account exists if any row needs it.
    let officeId = null;
    const needOffice = built.plan.some((p) => p.will_import && p.parent_action === 'office');
    if (needOffice) {
      const { rows: o } = await client.query(`SELECT id FROM users WHERE email = $1`, [OFFICE_EMAIL]);
      if (o[0]) officeId = o[0].id;
      else {
        const hash = await bcrypt.hash(require('crypto').randomBytes(12).toString('hex'), 10);
        const { rows: ins } = await client.query(
          `INSERT INTO users (full_name, email, password_hash, role, is_active, created_at, updated_at)
           VALUES ('Office / Walk-in', $1, $2, 'Viewer', TRUE, NOW(), NOW()) RETURNING id`,
          [OFFICE_EMAIL, hash]);
        officeId = ins[0].id;
      }
    }

    const results = [];
    let created = 0, reusedParticipants = 0, addedEvents = 0, paymentsRecorded = 0, parentsCreated = 0;

    for (const p of built.plan) {
      if (!p.will_import) {
        results.push({ row: p.row, full_name: p.full_name, status: p.status,
          message: p.errors[0] || p.warnings[0] || 'Skipped', events_added: 0 });
        continue;
      }
      await client.query('SAVEPOINT imp');
      try {
        // 1) Parent account — reuse by email (incl. one created earlier in THIS
        // file), create only when truly new, else the shared office account.
        let parentId = p.parent_id || null;
        if (!parentId && p.parent_action === 'create') {
          const { rows: existing } = await client.query(
            `SELECT id FROM users WHERE email = $1`, [p.parent_email]);
          if (existing[0]) {
            parentId = existing[0].id;
          } else {
            const hash = await bcrypt.hash(require('crypto').randomBytes(12).toString('hex'), 10);
            const { rows: u } = await client.query(
              `INSERT INTO users (full_name, email, phone, whatsapp_number, kca_member_no, password_hash, role, is_active, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,'Viewer',TRUE,NOW(),NOW()) RETURNING id`,
              [p.parent_name || 'Parent', p.parent_email,
               isBahrainPhone(p.parent_phone) ? p.parent_phone : null,
               p.whatsapp || null, p.member_no || null, hash]);
            parentId = u[0].id;
            parentsCreated++;
          }
        }
        if (!parentId) parentId = officeId;

        // 2) Participant (reuse by CPR+year, else create). Re-check here so a
        // child listed twice in one file is reused rather than colliding.
        let participantId = p.participant_id;
        if (!participantId) {
          const { rows: again } = await client.query(
            `SELECT id FROM participants WHERE cpr_number = $1 AND year_id = $2`, [p.cpr, year.id]);
          if (again[0]) participantId = again[0].id;
        }
        if (participantId) {
          await client.query(
            `UPDATE participants
               SET gender = COALESCE(gender, $1), school_id = COALESCE(school_id, $2),
                   age_group_id = COALESCE(age_group_id, $3), updated_at = NOW()
             WHERE id = $4`,
            [p.gender || null, p.school_id || null, p.age_group_id || null, participantId]);
          reusedParticipants++;
        } else {
          const { rows: np } = await client.query(
            `INSERT INTO participants
               (year_id, cpr_number, full_name, dob, gender, school_id, age_group_id,
                guardian_name, guardian_phone, cpr_verified_method, created_by, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10,NOW(),NOW()) RETURNING id`,
            [year.id, p.cpr, p.full_name, p.dob, p.gender, p.school_id || null, p.age_group_id || null,
             p.parent_name || null, isBahrainPhone(p.parent_phone) ? p.parent_phone : null, parentId]);
          participantId = np[0].id;
          created++;
        }

        // 3) Registrations for each new event code
        let addedHere = 0;
        for (const ev of p.events) {
          if (ev.action !== 'add') continue;
          const { rows: ex } = await client.query(
            `SELECT id, status FROM registrations WHERE participant_id = $1 AND event_id = $2`,
            [participantId, ev.event_id]);
          if (ex[0] && ex[0].status !== 'withdrawn') continue; // already active
          if (ex[0]) {
            await client.query(
              `UPDATE registrations SET status='registered', fee_amount=$1, age_group_id=$2,
                 category_id=$3, registered_by=$4, updated_at=NOW() WHERE id=$5`,
              [ev.fee, p.age_group_id, ev.category_id, req.user.id, ex[0].id]);
          } else {
            await client.query(
              `INSERT INTO registrations
                 (year_id, participant_id, event_id, age_group_id, category_id, fee_amount,
                  status, registered_by, registered_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,$6,'registered',$7,NOW(),NOW())`,
              [year.id, participantId, ev.event_id, p.age_group_id, ev.category_id, ev.fee, req.user.id]);
          }
          addedHere++;
        }
        addedEvents += addedHere;

        // 4) Record cash paid in office (guarded: only if none confirmed yet)
        if (p.cash > 0) {
          const { rows: paid } = await client.query(
            `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE participant_id=$1 AND status='confirmed'`,
            [participantId]);
          if (Number(paid[0].s) === 0) {
            await client.query(
              `INSERT INTO payments
                 (year_id, parent_user_id, participant_id, amount, method, status, reference, notes, confirmed_by, confirmed_at, created_at, updated_at)
               VALUES ($1,$2,$3,$4,$5,'confirmed',$6,$7,$8,NOW(),NOW(),NOW())`,
              [year.id, parentId, participantId, round3(p.cash), p.pay_method,
               p.pay_ref || null, `Walk-in import by ${req.user.role}`, req.user.id]);
            paymentsRecorded++;
          }
        }

        // 5) Mark complete
        await client.query(
          `UPDATE participants SET confirmed_at = COALESCE(confirmed_at, NOW()), updated_at = NOW() WHERE id = $1`,
          [participantId]);

        await client.query('RELEASE SAVEPOINT imp');
        results.push({ row: p.row, full_name: p.full_name, status: 'imported', events_added: addedHere });
      } catch (rowErr) {
        await client.query('ROLLBACK TO SAVEPOINT imp');
        results.push({ row: p.row, full_name: p.full_name, status: 'failed', events_added: 0, message: rowErr.message });
      }
    }

    await client.query('COMMIT');

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'IMPORT_REGISTRATIONS', entity: 'participants', entityId: null,
      details: { created, reusedParticipants, addedEvents, paymentsRecorded, parentsCreated } });

    res.json({
      committed: true,
      summary: { created, reused_participants: reusedParticipants, events_added: addedEvents,
payments_recorded: paymentsRecorded, parents_created: parentsCreated,
        failed: results.filter((r) => r.status === 'failed').length },
      results,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});


// ── Email the schedule / a custom message to parents ─────────────────────────
// Personalised email per recipient. Audience can be ALL individuals, one age
// group, or TEAM entries — so a big list can be sent in smaller batches that
// won't trip the mail provider's rate limits. Two body modes: the standard
// schedule (events + reporting times + PWA links + WhatsApp invite) or a FULLY
// custom message you type ({name}, {first_name}, {group}, {events} are filled
// in per recipient). Every outcome is logged so you can resend only the rest.
const SCHEDULE_EMAIL_ROLES = ['SuperAdmin', 'Admin', 'Chairman'];

async function activeYearRow() {
  const { rows } = await pool.query(`SELECT * FROM year_config WHERE is_active = TRUE LIMIT 1`);
  return rows[0] || null;
}

const schedToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const schedFmt = (min) => { if (min == null) return null; const x = ((min % 1440) + 1440) % 1440; return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
function schedReportFor(r) {
  if (!r.start_time) return null;
  const start = schedToMin(r.start_time);
  const perMin = r.allotted_time_seconds ? r.allotted_time_seconds / 60 : 5;
  const groups = Array.isArray(r.sched_groups) ? r.sched_groups : [];
  const idx = groups.findIndex((g) => g.code === r.my_code);
  if (!r.is_stage_event || groups.length <= 1 || idx <= 0) return schedFmt(start - 15);
  let earlier = 0; for (let i = 0; i < idx; i++) earlier += Math.ceil((Number(groups[i].cnt) || 0) * perMin);
  return schedFmt(start + earlier - 30);
}

const SCHED_GROUPS_SUBQ =
  `(SELECT json_agg(json_build_object('code', ag2.code, 'cnt',
            (SELECT COUNT(*) FROM registrations r2
               LEFT JOIN participants pr2 ON pr2.id = r2.participant_id
              WHERE r2.event_id = e.id AND r2.status NOT IN ('withdrawn','swapped')
                AND (pr2.confirmed_at IS NOT NULL OR r2.team_id IS NOT NULL)
                AND r2.age_group_id = ag2.id)) ORDER BY ag2.sort_order)
     FROM age_groups ag2
    WHERE ag2.year_id = e.year_id AND s.age_groups IS NOT NULL
      AND ag2.code = ANY(string_to_array(s.age_groups, ', ')))`;

// Individual participants (optionally one, one age group, or capped).
async function buildIndividualRecipients(yc, { participantId = null, ageGroupCode = null, limit = null } = {}) {
  const params = [yc.id];
  let filter = '';
  if (participantId) { params.push(participantId); filter += ` AND p.id = $${params.length}`; }
  if (ageGroupCode) { params.push(ageGroupCode); filter += ` AND pag.code = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT p.id AS participant_id, p.full_name AS participant_name, p.cpr_number, p.pwa_username,
            pag.code AS p_age_code,
            u.full_name AS parent_name, u.email AS parent_email,
            e.event_code, e.event_name, (e.event_kind = 'team') AS is_team_event,
            ag.code AS my_code, ag.label AS age_group,
            e.is_stage_event, e.allotted_time_seconds,
            s.venue, to_char(s.event_date,'YYYY-MM-DD') AS event_date,
            to_char(s.start_time,'HH24:MI') AS start_time, s.age_groups,
            ${SCHED_GROUPS_SUBQ} AS sched_groups
       FROM participants p
       JOIN registrations r ON r.participant_id = p.id AND r.status NOT IN ('withdrawn','swapped')
       JOIN events e ON e.id = r.event_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN age_groups pag ON pag.id = p.age_group_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN LATERAL (
         SELECT venue, event_date, start_time, age_groups
           FROM schedule sd
          WHERE sd.event_id = r.event_id AND sd.year_id = p.year_id
            AND sd.status IN ('confirmed','completed')
            AND ag.code = ANY(string_to_array(sd.age_groups, ', '))
          ORDER BY sd.event_date, sd.start_time LIMIT 1) s ON TRUE
      WHERE p.year_id = $1 AND p.confirmed_at IS NOT NULL
        AND u.email IS NOT NULL AND btrim(u.email) <> ''${filter}
      ORDER BY p.id, s.event_date NULLS LAST, s.start_time NULLS LAST, e.event_name`, params);

  const byP = new Map();
  for (const r of rows) {
    if (!byP.has(r.participant_id)) byP.set(r.participant_id, {
      kind: 'participant', id: r.participant_id, key: `p${r.participant_id}`,
      name: r.participant_name, cpr_number: r.cpr_number, parent_name: r.parent_name,
      email: r.parent_email, pwa_username: r.pwa_username, age_group: r.p_age_code, events: [] });
    byP.get(r.participant_id).events.push({
      event_code: r.event_code, event_name: r.event_name, is_team_event: r.is_team_event,
      venue: r.venue, event_date: r.event_date, scheduled: !!r.start_time, report: schedReportFor(r),
    });
  }
  let out = [...byP.values()];
  if (limit) out = out.slice(0, limit);
  return out;
}

// Team entries (contact user + the team's one event + its scheduled time).
async function buildTeamRecipients(yc, { teamId = null, limit = null } = {}) {
  const params = [yc.id];
  let filter = '';
  if (teamId) { params.push(teamId); filter += ` AND t.id = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT t.id AS team_id, t.team_name, tag.code AS t_age_code,
            u.full_name AS contact_name, u.email AS contact_email,
            e.event_code, e.event_name,
            tag.code AS my_code, e.is_stage_event, e.allotted_time_seconds,
            s.venue, to_char(s.event_date,'YYYY-MM-DD') AS event_date,
            to_char(s.start_time,'HH24:MI') AS start_time, s.age_groups,
            ${SCHED_GROUPS_SUBQ} AS sched_groups
       FROM teams t
       JOIN events e ON e.id = t.event_id
       LEFT JOIN age_groups tag ON tag.id = t.age_group_id
       LEFT JOIN users u ON u.id = t.created_by
       LEFT JOIN LATERAL (
         SELECT venue, event_date, start_time, age_groups
           FROM schedule sd
          WHERE sd.event_id = t.event_id AND sd.year_id = t.year_id
            AND sd.status IN ('confirmed','completed')
            AND (tag.code IS NULL OR tag.code = ANY(string_to_array(sd.age_groups, ', ')))
          ORDER BY sd.event_date, sd.start_time LIMIT 1) s ON TRUE
      WHERE t.year_id = $1 AND u.email IS NOT NULL AND btrim(u.email) <> ''${filter}
      ORDER BY t.id`, params);
  let out = rows.map((r) => ({
    kind: 'team', id: r.team_id, key: `t${r.team_id}`,
    name: r.team_name, cpr_number: null, parent_name: r.contact_name,
    email: r.contact_email, pwa_username: null, age_group: r.t_age_code,
    events: [{
      event_code: r.event_code, event_name: r.event_name, is_team_event: true,
      venue: r.venue, event_date: r.event_date, scheduled: !!r.start_time, report: schedReportFor(r),
    }],
  }));
  if (limit) out = out.slice(0, limit);
  return out;
}

// Dispatch by audience: 'all' | 'group:<CODE>' | 'teams'.
async function buildRecipients(yc, { audience = 'all', limit = null } = {}) {
  if (audience === 'teams') return buildTeamRecipients(yc, { limit });
  if (typeof audience === 'string' && audience.startsWith('group:')) {
    return buildIndividualRecipients(yc, { ageGroupCode: audience.slice(6), limit });
  }
  return buildIndividualRecipients(yc, { limit });
}

const DEFAULT_SCHEDULE_NOTE =
  "Please note the reporting time for each event and reach the venue a little early. "
  + "Some events are still being scheduled — those show \"To be announced\" below; "
  + "please keep checking the app for the latest timings.";

const scheduleSubject = (yc) => `Your event schedule — ${yc.event_year_label || 'Indian Talent Scan'}`;
const emailEsc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDateLong = (d) => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }); };

// Plain-ish HTML list of a recipient's events, for the {events} token.
function eventsTokenHtml(rec) {
  if (!rec.events.length) return '—';
  return '<ul style="margin:6px 0;padding-left:18px">' + rec.events.map((e) => {
    const when = e.scheduled ? `${emailEsc(fmtDateLong(e.event_date))}${e.report ? `, report by ${emailEsc(e.report)}` : ''}${e.venue ? `, ${emailEsc(e.venue)}` : ''}` : 'To be announced';
    return `<li><b>${emailEsc(e.event_name)}</b> — ${when}</li>`;
  }).join('') + '</ul>';
}

// Build the email for one recipient: standard schedule, or a custom message.
function renderRecipientEmail(yc, rec, { note, customText } = {}) {
  if (customText && String(customText).trim()) {
    let body = emailEsc(String(customText));
    const first = (rec.name || '').split(' ')[0] || '';
    body = body.replace(/\{name\}/g, emailEsc(rec.name))
               .replace(/\{first_name\}/g, emailEsc(first))
               .replace(/\{group\}/g, emailEsc(rec.age_group || ''));
    body = body.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#1e3a5f">$1</a>');
    body = body.replace(/\n/g, '<br/>');
    body = body.replace(/\{events\}/g, eventsTokenHtml(rec));
    return customEmailHtml({ yearLabel: yc.event_year_label, logoUrl: yc.its_logo_url || yc.kca_logo_url || null, bodyHtml: body });
  }
  return scheduleEmailHtml({
    yearLabel: yc.event_year_label,
    logoUrl: yc.its_logo_url || yc.kca_logo_url || null,
    parentName: rec.parent_name, participantName: rec.name,
    ageGroup: rec.age_group, events: rec.events,
    waGroupLink: (yc.wa_group_link || '').trim() || null, pwaUsername: rec.pwa_username,
    note,
  });
}

// Set of log keys already successfully sent (participant p<id> / team t<id>).
async function sentKeySet(yearId) {
  const { rows } = await pool.query(
    `SELECT participant_id, team_id FROM schedule_email_log WHERE year_id = $1 AND status = 'sent'`, [yearId]);
  const set = new Set();
  for (const r of rows) { if (r.participant_id) set.add(`p${r.participant_id}`); if (r.team_id) set.add(`t${r.team_id}`); }
  return set;
}

// GET the audience options with recipient counts (all / each age group / teams).
router.get('/registrations/schedule-email/audiences', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows: grp } = await pool.query(
      `SELECT pag.code, COUNT(DISTINCT p.id)::int AS cnt
         FROM participants p
         JOIN age_groups pag ON pag.id = p.age_group_id
         JOIN users u ON u.id = p.created_by
        WHERE p.year_id = $1 AND p.confirmed_at IS NOT NULL AND u.email IS NOT NULL AND btrim(u.email) <> ''
          AND EXISTS (SELECT 1 FROM registrations r WHERE r.participant_id = p.id AND r.status NOT IN ('withdrawn','swapped'))
        GROUP BY pag.code, pag.sort_order ORDER BY pag.sort_order, pag.code`, [yc.id]);
    const { rows: allCnt } = await pool.query(
      `SELECT COUNT(DISTINCT p.id)::int AS cnt FROM participants p JOIN users u ON u.id = p.created_by
        WHERE p.year_id = $1 AND p.confirmed_at IS NOT NULL AND u.email IS NOT NULL AND btrim(u.email) <> ''
          AND EXISTS (SELECT 1 FROM registrations r WHERE r.participant_id = p.id AND r.status NOT IN ('withdrawn','swapped'))`, [yc.id]);
    const { rows: teamCnt } = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM teams t JOIN users u ON u.id = t.created_by
        WHERE t.year_id = $1 AND u.email IS NOT NULL AND btrim(u.email) <> ''`, [yc.id]);
    const options = [{ value: 'all', label: `All individuals (${allCnt[0].cnt})`, count: allCnt[0].cnt }];
    for (const g of grp) options.push({ value: `group:${g.code}`, label: `Group ${g.code} (${g.cnt})`, count: g.cnt });
    if (teamCnt[0].cnt > 0) options.push({ value: 'teams', label: `Team entries (${teamCnt[0].cnt})`, count: teamCnt[0].cnt });
    res.json({ options, wa_group_link_set: !!(yc.wa_group_link && yc.wa_group_link.trim()) });
  } catch (err) { next(err); }
});

// GET recipient counts for the chosen audience (in scope / already sent / not yet).
router.get('/registrations/schedule-email/recipients', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const audience = req.query.audience || 'all';
    const recs = await buildRecipients(yc, { audience });
    const sent = await sentKeySet(yc.id);
    const already = recs.filter((r) => sent.has(r.key)).length;
    res.json({ with_email: recs.length, already_sent: already, unsent: recs.length - already,
               wa_group_link_set: !!(yc.wa_group_link && yc.wa_group_link.trim()) });
  } catch (err) { next(err); }
});

// GET a spot-check sample for the chosen audience.
router.get('/registrations/schedule-email/sample', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const audience = req.query.audience || 'all';
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
    const recs = await buildRecipients(yc, { audience, limit });
    res.json(recs.map((r) => ({
      kind: r.kind, id: r.id, participant_name: r.name,
      cpr_last4: String(r.cpr_number || '').slice(-4), age_group: r.age_group, parent_email: r.email,
      events: r.events.map((e) => ({
        event_code: e.event_code, event_name: e.event_name,
        when: e.scheduled ? `${e.event_date || ''}${e.report ? ` (report ${e.report})` : ''}` : 'To be announced',
        venue: e.scheduled ? (e.venue || '') : '',
      })),
    })));
  } catch (err) { next(err); }
});

// Fetch one recipient (by kind+id) or the first of an audience, for preview/test.
async function oneRecipient(yc, { kind, id, audience }) {
  if (kind === 'team' && id) return (await buildTeamRecipients(yc, { teamId: Number(id) }))[0] || null;
  if (kind === 'participant' && id) return (await buildIndividualRecipients(yc, { participantId: Number(id) }))[0] || null;
  return (await buildRecipients(yc, { audience: audience || 'all', limit: 1 }))[0] || null;
}

// GET the full rendered HTML for ONE recipient (preview — no email sent).
router.get('/registrations/schedule-email/preview', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const rec = await oneRecipient(yc, { kind: req.query.kind, id: req.query.id, audience: req.query.audience });
    if (!rec) return res.status(404).json({ error: 'No matching recipient with an email on file.' });
    const note = req.query.note != null ? String(req.query.note) : DEFAULT_SCHEDULE_NOTE;
    const customText = req.query.custom_text != null ? String(req.query.custom_text) : null;
    res.json({ participant_name: rec.name, parent_email: rec.email,
               subject: scheduleSubject(yc), html: renderRecipientEmail(yc, rec, { note, customText }) });
  } catch (err) { next(err); }
});

// POST send ONE test email to a chosen address, using a real recipient.
router.post('/registrations/schedule-email/test', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const to = String(req.body?.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Enter a valid email address for the test.' });
    const rec = await oneRecipient(yc, { kind: req.body?.kind, id: req.body?.id, audience: req.body?.audience });
    if (!rec) return res.status(404).json({ error: 'No recipient with an email on file to build a sample from.' });
    const note = req.body?.note != null ? String(req.body.note) : DEFAULT_SCHEDULE_NOTE;
    const customText = req.body?.custom_text != null ? String(req.body.custom_text) : null;
    const subject = (customText && req.body?.subject && String(req.body.subject).trim()) ? String(req.body.subject).trim() : scheduleSubject(yc);
    const out = await sendEmail({ to, subject: `[TEST] ${subject}`, html: renderRecipientEmail(yc, rec, { note, customText }) });
    if (!out.sent) return res.status(out.error === 'EMAIL_NOT_CONFIGURED' ? 400 : 502).json({ error: out.error === 'EMAIL_NOT_CONFIGURED' ? 'Email (SMTP) is not configured on the server.' : (out.error || 'Send failed') });
    res.json({ sent: true, sample_of: rec.name, to });
  } catch (err) { next(err); }
});

// POST send to the chosen audience. mode: 'only_unsent' | 'all'.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
router.post('/registrations/schedule-email/send', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const audience = req.body?.audience || 'all';
    const mode = req.body?.mode === 'all' ? 'all' : 'only_unsent';
    const note = req.body?.note != null ? String(req.body.note) : DEFAULT_SCHEDULE_NOTE;
    const customText = req.body?.custom_text != null ? String(req.body.custom_text) : null;
    const subject = (customText && req.body?.subject && String(req.body.subject).trim())
      ? String(req.body.subject).trim() : scheduleSubject(yc);

    let recipients = await buildRecipients(yc, { audience });
    if (mode === 'only_unsent') {
      const sent = await sentKeySet(yc.id);
      recipients = recipients.filter((r) => !sent.has(r.key));
    }

    let sent = 0, failed = 0, notConfigured = false, idx = 0;
    const worker = async () => {
      while (idx < recipients.length) {
        const rec = recipients[idx++];
        const html = renderRecipientEmail(yc, rec, { note, customText });
        let out = await sendEmail({ to: rec.email, subject, html });
        if (!out.sent && out.error !== 'EMAIL_NOT_CONFIGURED') { await sleep(1500); out = await sendEmail({ to: rec.email, subject, html }); }
        if (out.sent) sent++; else { failed++; if (out.error === 'EMAIL_NOT_CONFIGURED') notConfigured = true; }
        try {
          await pool.query(
            `INSERT INTO schedule_email_log (year_id, participant_id, team_id, email, status, error, sent_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [yc.id, rec.kind === 'participant' ? rec.id : null, rec.kind === 'team' ? rec.id : null,
             rec.email, out.sent ? 'sent' : 'failed', out.sent ? null : (out.error || 'send failed'), req.user.id]);
        } catch { /* logging is best-effort */ }
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));

    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'EMAIL_SCHEDULE', entity: 'year_config', entityId: yc.id,
      details: { audience, mode, custom: !!customText, recipients: recipients.length, sent, failed } });

    res.json({ recipients: recipients.length, sent, failed, email_configured: !notConfigured, mode });
  } catch (err) { next(err); }
});

// GET send-log summary for the active year.
router.get('/registrations/schedule-email/log', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_rows,
              COUNT(*)::int AS attempts, MAX(created_at) AS last_attempt
         FROM schedule_email_log WHERE year_id = $1`, [yc.id]);
    res.json(rows[0] || { sent_rows: 0, attempts: 0, last_attempt: null });
  } catch (err) { next(err); }
});

// GET CSV of the latest outcome per recipient (who was sent / failed + why).
router.get('/registrations/schedule-email/log/export', requireRole(...SCHEDULE_EMAIL_ROLES), async (req, res, next) => {
  try {
    const yc = await activeYearRow();
    if (!yc) return res.status(400).json({ error: 'No active year' });
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (COALESCE('p'||l.participant_id, 't'||l.team_id))
              COALESCE(p.full_name, t.team_name) AS recipient,
              CASE WHEN l.team_id IS NOT NULL THEN 'team' ELSE 'individual' END AS kind,
              COALESCE(p.cpr_number, '') AS cpr_number, l.email,
              l.status, l.error, to_char(l.created_at, 'YYYY-MM-DD HH24:MI') AS attempted_at
         FROM schedule_email_log l
         LEFT JOIN participants p ON p.id = l.participant_id
         LEFT JOIN teams t ON t.id = l.team_id
        WHERE l.year_id = $1
        ORDER BY COALESCE('p'||l.participant_id, 't'||l.team_id), l.created_at DESC`, [yc.id]);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const cols = ['recipient', 'kind', 'cpr_number', 'email', 'status', 'error', 'attempted_at'];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="schedule-email-log.csv"');
    res.send(csv);
  } catch (err) { next(err); }
});

module.exports = router;
