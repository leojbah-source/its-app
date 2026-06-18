// src/routes/admin.reports.routes.js  (mounted at /api/admin/reports)
// Master Context rule #2: ALL PDFs include KCA logo + Title Sponsor logo
// from year_config -- enforced centrally inside utils/pdf.js::startBrandedPdf.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { startBrandedPdf } = require('../utils/pdf');

const router = express.Router();
router.use(authenticate);
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

async function getEventYearAndName(eventId) {
  const { rows } = await pool.query(`SELECT year_id, name FROM events WHERE id = $1`, [eventId]);
  return rows[0] || null;
}

// GET /api/admin/reports/participant-list/:event_id
router.get('/participant-list/:event_id', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const event = await getEventYearAndName(req.params.event_id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows: participants } = await pool.query(
      `SELECT c.name AS child_name, c.school, c.age_group, r.teacher_name, r.status,
              cn.chest_number
       FROM registrations r
       JOIN children c ON c.id = r.child_id
       LEFT JOIN chest_numbers cn ON cn.registration_id = r.id AND cn.event_id = r.event_id
       WHERE r.event_id = $1
       ORDER BY c.age_group, c.name`,
      [req.params.event_id]
    );

    const doc = await startBrandedPdf(res, {
      yearId: event.year_id,
      title: `Participant List - ${event.name}`,
      filename: `participant-list-event-${req.params.event_id}.pdf`,
    });

    doc.fontSize(10);
    participants.forEach((p, i) => {
      doc.text(
        `${i + 1}. ${p.child_name}   School: ${p.school || '-'}   Age Group: ${p.age_group}   ` +
        `Teacher: ${p.teacher_name || '-'}   Chest #: ${p.chest_number ?? 'Not yet assigned'}   Status: ${p.status}`
      );
    });
    doc.moveDown(1);
    doc.fontSize(9).text(`Total participants: ${participants.length}`);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/judge-briefing/:event_id
router.get('/judge-briefing/:event_id', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const event = await getEventYearAndName(req.params.event_id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows: criteria } = await pool.query(
      `SELECT name, max_score FROM criteria WHERE event_id = $1 ORDER BY sort_order`,
      [req.params.event_id]
    );
    const { rows: judges } = await pool.query(
      `SELECT j.name, ja.status FROM judge_assignments ja
       JOIN judges j ON j.id = ja.judge_id
       WHERE ja.event_id = $1`,
      [req.params.event_id]
    );
    const { rows: slot } = await pool.query(
      `SELECT ts.slot_label, ts.start_time, ts.end_time, sd.venue
       FROM schedule_draft sd LEFT JOIN time_slots ts ON ts.id = sd.time_slot_id
       WHERE sd.event_id = $1 LIMIT 1`,
      [req.params.event_id]
    );
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM registrations WHERE event_id = $1`, [req.params.event_id]);

    const doc = await startBrandedPdf(res, {
      yearId: event.year_id,
      title: `Judge Briefing - ${event.name}`,
      filename: `judge-briefing-event-${req.params.event_id}.pdf`,
    });

    doc.fontSize(11);
    if (slot[0]) {
      doc.text(`Venue: ${slot[0].venue || '-'}   Slot: ${slot[0].slot_label || '-'}   Time: ${slot[0].start_time || '-'} - ${slot[0].end_time || '-'}`);
      doc.moveDown(0.5);
    }
    doc.text(`Total registered participants: ${countRows[0].count}`);
    doc.moveDown(1);
    doc.fontSize(12).text('Judging Criteria (scores entered against CHEST NUMBERS only):', { underline: true });
    doc.fontSize(10);
    criteria.forEach((c) => doc.text(`  - ${c.name}   (max ${c.max_score} points)`));
    doc.moveDown(1);
    doc.fontSize(12).text('Assigned Judges:', { underline: true });
    doc.fontSize(10);
    judges.forEach((j) => doc.text(`  - ${j.name}   (${j.status})`));
    doc.moveDown(1);
    doc.fontSize(9).text('Reminder: Judges must never be shown participant names. Live ranking is visible only to the judge entering their own scores.');
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/result-sheet/:event_id
router.get('/result-sheet/:event_id', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const event = await getEventYearAndName(req.params.event_id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows: results } = await pool.query(
      `SELECT res.rank, res.grade, res.rank_points, res.grade_points, cn.chest_number, c.name AS child_name, c.school
       FROM results res
       JOIN registrations r ON r.id = res.registration_id
       JOIN children c ON c.id = r.child_id
       LEFT JOIN chest_numbers cn ON cn.registration_id = res.registration_id AND cn.event_id = res.event_id
       WHERE res.event_id = $1 ORDER BY res.rank`,
      [req.params.event_id]
    );

    const doc = await startBrandedPdf(res, {
      yearId: event.year_id,
      title: `Result Sheet - ${event.name}`,
      filename: `result-sheet-event-${req.params.event_id}.pdf`,
    });

    doc.fontSize(10);
    results.forEach((r) => {
      doc.text(`Rank ${r.rank}   Chest #${r.chest_number}   ${r.child_name}   School: ${r.school || '-'}   Grade ${r.grade}   Rank pts ${r.rank_points}   Grade pts ${r.grade_points}`);
    });
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/result-card/:event_id  -- one card per participant
router.get('/result-card/:event_id', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const event = await getEventYearAndName(req.params.event_id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const { rows: results } = await pool.query(
      `SELECT res.rank, res.grade, res.rank_points, res.grade_points, cn.chest_number, c.name AS child_name
       FROM results res
       JOIN registrations r ON r.id = res.registration_id
       JOIN children c ON c.id = r.child_id
       LEFT JOIN chest_numbers cn ON cn.registration_id = res.registration_id AND cn.event_id = res.event_id
       WHERE res.event_id = $1 ORDER BY res.rank`,
      [req.params.event_id]
    );

    const doc = await startBrandedPdf(res, {
      yearId: event.year_id,
      title: `Result Cards - ${event.name}`,
      filename: `result-cards-event-${req.params.event_id}.pdf`,
    });

    results.forEach((r, i) => {
      if (i > 0) doc.addPage();
      doc.fontSize(18).text(event.name, { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(14).text(`Participant: ${r.child_name}`, { align: 'center' });
      doc.text(`Chest Number: ${r.chest_number ?? '-'}`, { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(22).text(`Rank: ${r.rank}`, { align: 'center' });
      doc.fontSize(16).text(`Grade: ${r.grade}`, { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(11).text(`Rank Points: ${r.rank_points}   Grade Points: ${r.grade_points}`, { align: 'center' });
    });
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/certificates/:year_id  -- one certificate per winning placement that year
router.get('/certificates/:year_id', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const { rows: results } = await pool.query(
      `SELECT res.rank, res.grade, e.name AS event_name, c.name AS child_name
       FROM results res
       JOIN events e ON e.id = res.event_id
       JOIN registrations r ON r.id = res.registration_id
       JOIN children c ON c.id = r.child_id
       WHERE e.year_id = $1 AND res.rank IS NOT NULL AND res.rank <= 3 AND res.is_published = true
       ORDER BY e.name, res.rank`,
      [req.params.year_id]
    );
    if (results.length === 0) {
      return res.status(404).json({ error: 'No published top-3 results found for this year' });
    }

    const ordinal = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : '3rd');

    const doc = await startBrandedPdf(res, {
      yearId: req.params.year_id,
      title: 'Certificate of Achievement',
      filename: `certificates_year_${req.params.year_id}.pdf`,
    });

    results.forEach((r, i) => {
      if (i > 0) doc.addPage();
      doc.moveDown(2);
      doc.fontSize(22).text('Certificate of Achievement', { align: 'center' });
      doc.moveDown(2);
      doc.fontSize(14).text('This is to certify that', { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(20).text(r.child_name, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(14).text(`has secured the ${ordinal(r.rank)} place and Grade ${r.grade} in`, { align: 'center' });
      doc.moveDown(0.5);
      doc.fontSize(16).text(r.event_name, { align: 'center' });
      doc.moveDown(3);
      doc.fontSize(11).text('Chairman Signature: ____________________', { align: 'center' });
    });
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/refunds/:year_id
router.get('/refunds/:year_id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows: refunds } = await pool.query(
      `SELECT rl.amount, rl.reason, rl.status, rl.processed_at, c.name AS child_name, e.name AS event_name
       FROM refund_log rl
       JOIN registrations r ON r.id = rl.registration_id
       JOIN children c ON c.id = r.child_id
       LEFT JOIN events e ON e.id = r.event_id
       WHERE r.year_id = $1
       ORDER BY rl.processed_at DESC NULLS LAST`,
      [req.params.year_id]
    );

    const doc = await startBrandedPdf(res, {
      yearId: req.params.year_id,
      title: 'Refunds Report',
      filename: `refunds_year_${req.params.year_id}.pdf`,
    });

    doc.fontSize(10);
    let total = 0;
    refunds.forEach((r) => {
      total += Number(r.amount);
      doc.text(`${r.child_name}   ${r.event_name || '-'}   BHD ${r.amount}   Reason: ${r.reason}   Status: ${r.status}`);
    });
    doc.moveDown(1);
    doc.fontSize(11).text(`Total refunded: BHD ${total.toFixed(2)}`);
    doc.end();
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/reports/judge-review/:year_id  -- flags + refusal statements (Chairman/SuperAdmin)
router.get('/judge-review/:year_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { rows: flags } = await pool.query(
      `SELECT jf.statement, jf.created_at, jf.resolved_at, j.name AS judge_name, e.name AS event_name
       FROM judge_flags jf
       JOIN judge_assignments ja ON ja.id = jf.assignment_id
       JOIN judges j ON j.id = jf.judge_id
       JOIN events e ON e.id = ja.event_id
       WHERE e.year_id = $1
       ORDER BY jf.created_at DESC`,
      [req.params.year_id]
    );

    const doc = await startBrandedPdf(res, {
      yearId: req.params.year_id,
      title: 'Judge Review Flags & Refusal Statements',
      filename: `judge-review_year_${req.params.year_id}.pdf`,
    });

    doc.fontSize(10);
    if (flags.length === 0) doc.text('No judge review flags recorded for this year.');
    flags.forEach((f) => {
      doc.fontSize(11).text(`${f.judge_name}   -   ${f.event_name}`, { underline: true });
      doc.fontSize(9).text(`Raised: ${f.created_at}   Resolved: ${f.resolved_at || 'Pending'}`);
      doc.fontSize(10).text(`Statement: ${f.statement}`);
      doc.moveDown(1);
    });
    doc.end();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
