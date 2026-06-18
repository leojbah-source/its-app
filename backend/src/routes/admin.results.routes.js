// src/routes/admin.results.routes.js  (mounted at /api/admin)
// Rule #13: two-stage publication - (1) Finalise+Print for signatures,
// (2) Chairman publishes to PWA. Rule #14: extra/consolation prize for 4th
// place, Chairman only, BEFORE Stage 2 (is_published=true) only, no rank points.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { startBrandedPdf } = require('../utils/pdf');

const router = express.Router();
router.use(authenticate);
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

// POST /api/admin/results/:event_id/extra-prize  (Chairman only)
router.post('/results/:event_id/extra-prize', requireRole('Chairman'), async (req, res, next) => {
  try {
    const { type, reg_id_4th_place, reason } = req.body;
    if (!['additional_3rd', 'consolation'].includes(type) || !reg_id_4th_place || !reason) {
      return res.status(400).json({ error: "type ('additional_3rd' | 'consolation'), reg_id_4th_place and reason are required" });
    }

    const { rows: publishedCheck } = await pool.query(
      `SELECT is_published FROM results WHERE event_id = $1 AND is_published = true LIMIT 1`,
      [req.params.event_id]
    );
    if (publishedCheck[0]) {
      return res.status(403).json({ error: 'Blocked: results for this event are already published (Stage 2)' });
    }

    const { rows } = await pool.query(
      `INSERT INTO extra_prizes (event_id, registration_id, type, reason, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5, NOW()) RETURNING *`,
      [req.params.event_id, reg_id_4th_place, type, reason, req.user.id]
    );
    // No rank points awarded for extra/consolation prizes, per Master Context rule #14.
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'GRANT_EXTRA_PRIZE', entity: 'extra_prizes', entityId: rows[0].id, details: { type, reg_id_4th_place, reason } });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/results/:event_id/finalise  (Stage 1)
router.post('/results/:event_id/finalise', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE results SET finalised_at = NOW() WHERE event_id = $1 RETURNING *`,
      [req.params.event_id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'No results found to finalise for this event' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'FINALISE_RESULTS', entity: 'results', entityId: req.params.event_id });
    res.json({ finalised: rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/results/:event_id/print-pdf  -- for signatures, KCA + sponsor logo included
router.get('/results/:event_id/print-pdf', requireRole(...editRoles, 'Chairman'), async (req, res, next) => {
  try {
    const { rows: evRows } = await pool.query(`SELECT year_id, name FROM events WHERE id = $1`, [req.params.event_id]);
    if (!evRows[0]) return res.status(404).json({ error: 'Event not found' });

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
      yearId: evRows[0].year_id,
      title: `Result Sheet - ${evRows[0].name}`,
      filename: `result-sheet-event-${req.params.event_id}.pdf`,
    });

    doc.fontSize(10);
    results.forEach((r) => {
      doc.text(`Rank ${r.rank}   Chest #${r.chest_number}   ${r.child_name}   Grade ${r.grade}   Rank pts ${r.rank_points}   Grade pts ${r.grade_points}`);
    });
    doc.moveDown(2);
    doc.text('Judge 1 Signature: ____________________     Judge 2 Signature: ____________________');
    doc.moveDown(1);
    doc.text('Judge 3 Signature: ____________________     Chairman Signature: ____________________');
    doc.end();
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/results/:event_id/publish  -- Stage 2: Chairman or Admin
router.post('/results/:event_id/publish', requireRole('Chairman', 'Admin', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { rows: unfinalised } = await pool.query(
      `SELECT id FROM results WHERE event_id = $1 AND finalised_at IS NULL`,
      [req.params.event_id]
    );
    if (unfinalised.length > 0) {
      return res.status(400).json({ error: 'All results must be finalised (Stage 1) before publishing to PWA' });
    }

    const { rows } = await pool.query(
      `UPDATE results SET is_published = true, published_at = NOW() WHERE event_id = $1 RETURNING *`,
      [req.params.event_id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'PUBLISH_RESULTS', entity: 'results', entityId: req.params.event_id });
    res.json({ published: rows.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
