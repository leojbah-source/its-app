// src/routes/admin.chest.routes.js  (mounted at /api/admin/chest)
// Day-of operations, PER AGE GROUP: mark ATTENDANCE, then assign CHEST NUMBERS.
// Chest numbers restart at 1 for each (event, age group) — groups run one after
// another and numbers don't carry forward (migration 017). Rule #3: after
// attendance, never in advance. Rule #4: manual entry is Chairman/SuperAdmin.
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'EventStaff'];
const markRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'EventStaff'];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function eventYearId(eventId) {
  const { rows } = await pool.query(`SELECT year_id FROM events WHERE id = $1`, [eventId]);
  return rows[0]?.year_id || null;
}

async function eventTimeSlotMode(eventId) {
  const { rows } = await pool.query(`SELECT time_slot_mode FROM events WHERE id = $1`, [eventId]);
  return !!rows[0]?.time_slot_mode;
}
async function eventSlots(eventId) {
  const { rows } = await pool.query(
    `SELECT id, slot_label, reporting_time, participant_capacity AS capacity, chest_no_start, sort_order
       FROM event_time_slots WHERE event_id = $1 ORDER BY sort_order, id`, [eventId]);
  return rows;
}
// Snapshot of how participants sit across an event's time-slots, for one age group.
async function buildSlotPlan(eventId, ag) {
  const { rows: ev } = await pool.query(
    `SELECT e.event_code, e.event_name, e.time_slot_mode,
            ag.code AS age_group_code, ag.label AS age_group_label
       FROM events e JOIN age_groups ag ON ag.id = $2 WHERE e.id = $1`, [eventId, ag]);
  const meta = ev[0] || {};
  const slots = await eventSlots(eventId);
  const { rows: regs } = await pool.query(
    `SELECT r.id AS registration_id, r.status, r.time_slot_id,
            COALESCE(p.full_name, t.team_name) AS name, ca.chest_number
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
      WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status NOT IN ('withdrawn','swapped')
      ORDER BY name`, [eventId, ag]);
  const bySlot = new Map(slots.map((sl) => [sl.id, []]));
  const unallocated = [];
  for (const r of regs) {
    const row = { registration_id: r.registration_id, name: r.name, status: r.status, chest_number: r.chest_number };
    if (r.time_slot_id && bySlot.has(r.time_slot_id)) bySlot.get(r.time_slot_id).push(row);
    else unallocated.push(row);
  }
  const outSlots = slots.map((sl) => ({
    id: sl.id, slot_label: sl.slot_label,
    reporting_time: sl.reporting_time ? String(sl.reporting_time).slice(0, 5) : null,
    capacity: sl.capacity, chest_no_start: sl.chest_no_start,
    participants: bySlot.get(sl.id) || [],
  }));
  return {
    event_code: meta.event_code, event_name: meta.event_name,
    time_slot_mode: !!meta.time_slot_mode,
    age_group_code: meta.age_group_code, age_group_label: meta.age_group_label,
    slots: outSlots, unallocated,
    total_entries: regs.length,
    total_capacity: slots.reduce((a, sl) => a + (sl.capacity || 0), 0),
    chests_assigned: regs.some((r) => r.chest_number != null),
  };
}
// Chest numbers lock once judging has started — i.e. any score exists for a
// registration in this (event, age group). Prevents reshuffling mid-contest.
async function groupLocked(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM scores s JOIN registrations r ON r.id = s.registration_id
       WHERE r.event_id = $1 AND ($2::int IS NULL OR r.age_group_id = $2)
     ) AS locked`, [eventId, ageGroupId]);
  return rows[0].locked;
}
// Count entries in the group still awaiting an attendance decision.
async function groupUnmarked(eventId, ageGroupId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM registrations
     WHERE event_id = $1 AND age_group_id = $2 AND status = 'registered'`, [eventId, ageGroupId]);
  return rows[0].c;
}
const grp = (v) => (v === '' || v === undefined || v === null ? null : Number(v));

// ── GET /api/admin/chest/:event_id/groups — age groups for the event ─────────
router.get('/:event_id/groups', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT ag.id AS age_group_id, ag.code, ag.label, ag.sort_order,
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE r.status = 'attended')::int AS attended,
              COUNT(ca.registration_id)::int AS with_chest,
              EXISTS (SELECT 1 FROM scores s JOIN registrations r2 ON r2.id = s.registration_id
                      WHERE r2.event_id = $1 AND r2.age_group_id = ag.id) AS locked
       FROM registrations r
       JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
       WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
       GROUP BY ag.id, ag.code, ag.label, ag.sort_order
       ORDER BY ag.sort_order, ag.code`, [req.params.event_id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/chest/:event_id/roster?age_group_id= — roster (per group) ──
router.get('/:event_id/roster', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const ag = grp(req.query.age_group_id);
    const { rows } = await pool.query(
      `SELECT r.id AS registration_id, r.status, r.time_slot_id, r.age_group_id,
              COALESCE(p.full_name, t.team_name) AS name,
              ag.code AS age_group,
              ca.chest_number,
              COALESCE(p.guardian_phone, u.phone) AS contact_phone,
              COALESCE(u.whatsapp_number, u.whatsapp_number_2) AS whatsapp,
              (vr.id IS NOT NULL) AS video_wants,
              vr.payment_method AS video_method,
              vr.amount         AS video_amount,
              vr.recorded       AS video_recorded
       FROM registrations r
       LEFT JOIN participants p ON p.id = r.participant_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN teams t ON t.id = r.team_id
       LEFT JOIN age_groups ag ON ag.id = r.age_group_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
       LEFT JOIN video_requests vr ON vr.registration_id = r.id
       WHERE r.event_id = $1 AND r.status NOT IN ('withdrawn','swapped')
         AND ($2::int IS NULL OR r.age_group_id = $2)
       ORDER BY ca.chest_number NULLS LAST, name`, [req.params.event_id, ag]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/chest/:event_id/team-roster — ALL teams + members ─────────
// Team Event-Day view. Teams are NOT subdivided by age group: every team in the
// event appears together, alphabetical by team name, with one combined chest
// sequence. Each team's members carry their own present/absent status.
router.get('/:event_id/team-roster', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { rows: teams } = await pool.query(
      `SELECT r.id AS registration_id, r.status, r.age_group_id,
              t.id AS team_id, t.team_name,
              sc.name AS school_name,
              ca.chest_number,
              (vr.id IS NOT NULL) AS video_wants,
              vr.recorded AS video_recorded
       FROM registrations r
       JOIN teams t ON t.id = r.team_id
       LEFT JOIN schools sc ON sc.id = t.school_id
       LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
       LEFT JOIN video_requests vr ON vr.registration_id = r.id
       WHERE r.event_id = $1 AND r.team_id IS NOT NULL
         AND r.status NOT IN ('withdrawn','swapped')
       ORDER BY lower(t.team_name)`,
      [req.params.event_id]);

    if (teams.length) {
      const teamIds = teams.map((t) => t.team_id);
      const { rows: members } = await pool.query(
        `SELECT tm.team_id, tm.id AS team_member_id, p.id AS participant_id,
                p.full_name, p.cpr_number, p.gender,
                tm.is_captain, tm.is_substitute, tm.attendance_confirmed, tm.attendance_status
         FROM team_members tm JOIN participants p ON p.id = tm.participant_id
         WHERE tm.team_id = ANY($1::int[])
         ORDER BY tm.is_captain DESC, tm.is_substitute, p.full_name`,
        [teamIds]);
      const byTeam = new Map();
      for (const m of members) {
        if (!byTeam.has(m.team_id)) byTeam.set(m.team_id, []);
        byTeam.get(m.team_id).push(m);
      }
      for (const t of teams) t.members = byTeam.get(t.team_id) || [];
    }

    const { rows: sz } = await pool.query(
      `SELECT COALESCE(e.min_participants_per_team, yc.team_size_min, 5) AS size_min,
              COALESCE(e.max_participants_per_team, yc.team_size_max, 10) AS size_max
       FROM events e JOIN year_config yc ON yc.id = e.year_id
       WHERE e.id = $1`, [req.params.event_id]);
    const locked = await groupLocked(req.params.event_id, null);
    res.json({ teams, size_min: Number(sz[0]?.size_min ?? 5), size_max: Number(sz[0]?.size_max ?? 10), locked });
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/assign-teams — ONE combined chest sequence ─
// Random draw across all ATTENDED teams of the event (one pool — no per-group
// restart). Only allowed once every team has been marked present or absent.
router.post('/:event_id/assign-teams', requireRole(...markRoles), async (req, res, next) => {
  try {
    if (await groupLocked(req.params.event_id, null))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started.' });
    // Every team must be marked present/absent first (nothing left 'registered').
    const { rows: um } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM registrations
       WHERE event_id = $1 AND team_id IS NOT NULL AND status = 'registered'`,
      [req.params.event_id]);
    if (um[0].c > 0)
      return res.status(400).json({ error: 'Mark every team present or absent before assigning chest numbers.' });
    const yearId = await eventYearId(req.params.event_id);
    const { rows: pending } = await pool.query(
      `SELECT r.id AS registration_id, r.age_group_id, t.team_name
       FROM registrations r JOIN teams t ON t.id = r.team_id
       WHERE r.event_id = $1 AND r.team_id IS NOT NULL AND r.status = 'attended'
         AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1)`,
      [req.params.event_id]);
    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1`,
      [req.params.event_id]);
    let n = Number(mx[0].max_no);
    const assigned = [];
    for (const r of shuffle(pending)) {
      n += 1;
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, age_group_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,$5,'auto',$6) RETURNING registration_id, chest_number`,
        [yearId, req.params.event_id, r.age_group_id, r.registration_id, n, req.user.id]);
      assigned.push(rows[0]);
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_TEAMS', entity: 'chest_assignments', entityId: req.params.event_id, details: { count: assigned.length } });
    res.json(assigned);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/team/:teamId/member-attendance ───────────
// Mark one team member present/absent. body: { participant_id, present }
router.post('/:event_id/team/:teamId/member-attendance', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { participant_id, present } = req.body;
    if (!participant_id || typeof present !== 'boolean')
      return res.status(400).json({ error: 'participant_id and present (boolean) are required' });
    const { rowCount } = await pool.query(
      `UPDATE team_members
         SET attendance_status = $1, attendance_confirmed = $2, confirmed_by = $3, confirmed_at = NOW()
       WHERE team_id = $4 AND participant_id = $5`,
      [present ? 'present' : 'absent', present, req.user.id, req.params.teamId, participant_id]);
    if (!rowCount) return res.status(404).json({ error: 'Member not found in this team' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'TEAM_MEMBER_ATTENDANCE', entity: 'team_members', entityId: req.params.teamId,
      details: { participant_id, present } });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/team/:teamId/substitute ──────────────────
// Replace an absent member with a new person (recorded as an approved substitute).
// body: { absent_participant_id?, full_name, cpr_number, dob, gender, reason }
router.post('/:event_id/team/:teamId/substitute', requireRole(...markRoles), async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { absent_participant_id, full_name, cpr_number, dob, gender, reason } = req.body;
    if (!full_name || !cpr_number || !dob || !gender)
      return res.status(400).json({ error: 'full_name, cpr_number, dob and gender are required' });
    if (!['M', 'F'].includes(gender))
      return res.status(400).json({ error: 'gender must be M (male) or F (female)' });
    await client.query('BEGIN');

    const { rows: trow } = await client.query(`SELECT year_id FROM teams WHERE id = $1`, [req.params.teamId]);
    if (!trow[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Team not found' }); }
    const yearId = trow[0].year_id;

    let { rows: pr } = await client.query(
      `SELECT id FROM participants WHERE year_id = $1 AND cpr_number = $2`, [yearId, String(cpr_number).trim()]);
    let newPid;
    if (pr[0]) {
      newPid = pr[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO participants (year_id, cpr_number, full_name, dob, gender, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [yearId, String(cpr_number).trim(), full_name.trim(), dob, gender, req.user.id]);
      newPid = ins.rows[0].id;
    }

    const { rows: dup } = await client.query(
      `SELECT 1 FROM team_members WHERE team_id = $1 AND participant_id = $2`, [req.params.teamId, newPid]);
    if (!dup[0]) {
      await client.query(
        `INSERT INTO team_members
           (team_id, participant_id, is_substitute, substitute_reason, approved_by, approved_at,
            attendance_status, attendance_confirmed, confirmed_by, confirmed_at)
         VALUES ($1,$2,TRUE,$3,$4,NOW(),'present',TRUE,$4,NOW())`,
        [req.params.teamId, newPid, reason || 'Event-day replacement', req.user.id]);
    } else {
      await client.query(
        `UPDATE team_members SET attendance_status='present', attendance_confirmed=TRUE, confirmed_by=$3, confirmed_at=NOW()
         WHERE team_id=$1 AND participant_id=$2`, [req.params.teamId, newPid, req.user.id]);
    }

    if (absent_participant_id) {
      await client.query(
        `UPDATE team_members SET attendance_status='absent', attendance_confirmed=FALSE, confirmed_by=$3, confirmed_at=NOW()
         WHERE team_id=$1 AND participant_id=$2`, [req.params.teamId, absent_participant_id, req.user.id]);
    }

    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'TEAM_SUBSTITUTE', entity: 'team_members', entityId: req.params.teamId,
      details: { new_participant_id: newPid, absent_participant_id: absent_participant_id || null, reason: reason || null } });
    res.json({ ok: true, participant_id: newPid });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => null);
    next(err);
  } finally { client.release(); }
});

// ── POST /api/admin/chest/:event_id/attendance — mark present/absent ─────────
router.post('/:event_id/attendance', requireRole(...markRoles), async (req, res, next) => {
  try {
    const { registration_id, present } = req.body;
    if (!registration_id) return res.status(400).json({ error: 'registration_id is required' });

    // Rule: once chest numbers are assigned in a group, attendance may be changed
    // only by Chairman/SuperAdmin — Admin/Coordinator are locked out (a no-show
    // who turns up must be reinstated by a senior role).
    if (!['Chairman', 'SuperAdmin'].includes(req.user.role)) {
      const { rows: g } = await pool.query(
        `SELECT age_group_id FROM registrations WHERE id = $1 AND event_id = $2`,
        [registration_id, req.params.event_id]);
      if (g[0]) {
        const { rows: hasChest } = await pool.query(
          `SELECT 1 FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2 LIMIT 1`,
          [req.params.event_id, g[0].age_group_id]);
        if (hasChest[0])
          return res.status(403).json({ error: 'Chest numbers are assigned for this group — only a Chairman or SuperAdmin can change attendance now.' });
      }
    }

    const status = present ? 'attended' : 'absent';
    const { rows } = await pool.query(
      `UPDATE registrations
         SET status = $1, attendance_marked_by = $2, attendance_marked_at = NOW(), updated_at = NOW()
       WHERE id = $3 AND event_id = $4 AND status NOT IN ('withdrawn','swapped')
       RETURNING id AS registration_id, status`,
      [status, req.user.id, registration_id, req.params.event_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Registration not found for this event' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'MARK_ATTENDANCE', entity: 'registrations', entityId: registration_id, details: { status } });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/assign-auto — random chests, ONE group ───
// body: { age_group_id }  (numbering restarts at 1 within the group)
router.post('/:event_id/assign-auto', requireRole(...markRoles), async (req, res, next) => {
  try {
    const ag = grp(req.body.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    if (await groupUnmarked(req.params.event_id, ag) > 0)
      return res.status(409).json({ error: 'Mark every participant present or absent before assigning chest numbers.' });

    const { rows: pending } = await pool.query(
      `SELECT r.id AS registration_id, r.time_slot_id FROM registrations r
       WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended'
         AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2)`,
      [req.params.event_id, ag]);
    if (!pending.length) return res.status(400).json({ error: 'No attended entries in this group awaiting chest numbers.' });

    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2`,
      [req.params.event_id, ag]);
    let next_no = Number(mx[0].max_no) + 1;

    const assigned = [];
    for (const reg of shuffle(pending)) {
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, age_group_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'auto',$7) RETURNING registration_id, chest_number`,
        [yearId, req.params.event_id, ag, reg.time_slot_id, reg.registration_id, next_no, req.user.id]);
      assigned.push(rows[0]); next_no++;
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_AUTO', entity: 'chest_assignments', entityId: req.params.event_id, details: { age_group_id: ag, count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});

// ── GET /api/admin/chest/:event_id/slot-plan?age_group_id= — slot layout ──────
// How participants sit across the event's time-slots for this group (who is in
// which slot, with reporting times and chest ranges). Drives the planning view.
router.get('/:event_id/slot-plan', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const ag = grp(req.query.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    res.json(await buildSlotPlan(req.params.event_id, ag));
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/allocate-slots — classify into slots ──────
// Random draw that places each participant in the group into a time-slot, filling
// slots in order up to their capacity. Planning step done BEFORE the day so parents
// can be told their slot/reporting time. Never touches chest numbers. Blocked once
// chests are drawn or judging has started. Only for time-slot-mode events.
router.post('/:event_id/allocate-slots', requireRole(...markRoles), async (req, res, next) => {
  const client = await pool.connect();
  let released = false;
  try {
    const ag = grp(req.body.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    if (!(await eventTimeSlotMode(req.params.event_id)))
      return res.status(400).json({ error: 'This event is not in time-slot mode.' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Slots are locked — judging has started for this group.' });
    const slots = await eventSlots(req.params.event_id);
    if (!slots.length) return res.status(400).json({ error: 'No time slots configured for this event.' });
    const { rows: hasChest } = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2) AS x`,
      [req.params.event_id, ag]);
    if (hasChest[0].x) return res.status(409).json({ error: 'Clear chest numbers for this group before re-drawing slots.' });
    const { rows: regs } = await pool.query(
      `SELECT id FROM registrations WHERE event_id = $1 AND age_group_id = $2 AND status NOT IN ('withdrawn','swapped')`,
      [req.params.event_id, ag]);
    const order = shuffle(regs.map((r) => r.id));
    const totalCap = slots.reduce((a, sl) => a + (Number(sl.capacity) || 0), 0);
    await client.query('BEGIN');
    await client.query(`UPDATE registrations SET time_slot_id = NULL WHERE event_id = $1 AND age_group_id = $2`,
      [req.params.event_id, ag]);
    let idx = 0;
    for (const sl of slots) {
      const take = order.slice(idx, idx + (Number(sl.capacity) || 0));
      idx += (Number(sl.capacity) || 0);
      if (take.length) await client.query(
        `UPDATE registrations SET time_slot_id = $3 WHERE id = ANY($4::int[]) AND event_id = $1 AND age_group_id = $2`,
        [req.params.event_id, ag, sl.id, take]);
    }
    await client.query('COMMIT');
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ALLOCATE_SLOTS', entity: 'registrations', entityId: req.params.event_id,
      details: { age_group_id: ag, allocated: Math.min(order.length, totalCap), unallocated: Math.max(0, order.length - totalCap) } });
    client.release(); released = true;
    res.json(await buildSlotPlan(req.params.event_id, ag));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    next(err);
  } finally { if (!released) client.release(); }
});

// ── POST /api/admin/chest/:event_id/clear-slots — un-allocate this group ────
// Reverts a group to regular (non-slot) chest numbering by clearing its slot
// placement. Only before chests are drawn. Lets an event keep time-slot mode for
// one age group while other groups are numbered normally.
router.post('/:event_id/clear-slots', requireRole(...markRoles), async (req, res, next) => {
  try {
    const ag = grp(req.body.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    const { rows: hasChest } = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2) AS x`,
      [req.params.event_id, ag]);
    if (hasChest[0].x) return res.status(409).json({ error: 'Clear chest numbers for this group first.' });
    const { rowCount } = await pool.query(
      `UPDATE registrations SET time_slot_id = NULL WHERE event_id = $1 AND age_group_id = $2 AND time_slot_id IS NOT NULL`,
      [req.params.event_id, ag]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CLEAR_SLOT_ALLOCATION', entity: 'registrations', entityId: req.params.event_id, details: { age_group_id: ag, cleared: rowCount } });
    res.json({ cleared: rowCount });
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/move-slot — move ONE participant's slot ──
// Manual override for special cases: move a single participant into a different
// time-slot. Allowed only while that participant has no chest yet and the target
// slot has not been drawn, so the continuous numbering stays intact.
router.post('/:event_id/move-slot', requireRole(...markRoles), async (req, res, next) => {
  try {
    const regId = grp(req.body.registration_id);
    const slotId = grp(req.body.time_slot_id);
    if (!regId || !slotId) return res.status(400).json({ error: 'registration_id and time_slot_id are required' });
    const { rows: slk } = await pool.query(
      `SELECT id FROM event_time_slots WHERE id = $1 AND event_id = $2`, [slotId, req.params.event_id]);
    if (!slk[0]) return res.status(404).json({ error: 'Time slot not found for this event' });
    const { rows: reg } = await pool.query(
      `SELECT r.id, r.age_group_id, ca.chest_number
         FROM registrations r LEFT JOIN chest_assignments ca ON ca.registration_id = r.id
        WHERE r.id = $1 AND r.event_id = $2`, [regId, req.params.event_id]);
    if (!reg[0]) return res.status(404).json({ error: 'Registration not found for this event' });
    if (await groupLocked(req.params.event_id, reg[0].age_group_id))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    if (reg[0].chest_number != null)
      return res.status(409).json({ error: 'This participant already has a chest number — clear it before moving slots.' });
    const { rows: tgt } = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2 AND time_slot_id = $3) AS x`,
      [req.params.event_id, reg[0].age_group_id, slotId]);
    if (tgt[0].x)
      return res.status(409).json({ error: 'That slot has already been drawn — move into a slot whose chests are not yet drawn.' });
    await pool.query(`UPDATE registrations SET time_slot_id = $1 WHERE id = $2`, [slotId, regId]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'MOVE_SLOT', entity: 'registrations', entityId: regId,
      details: { event_id: Number(req.params.event_id), age_group_id: reg[0].age_group_id, time_slot_id: slotId } });
    res.json({ ok: true, registration_id: regId, time_slot_id: slotId });
  } catch (err) { next(err); }
});

// ── GET /api/admin/chest/:event_id/slot-plan-xlsx?age_group_id= — parent list ─
router.get('/:event_id/slot-plan-xlsx', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const ag = grp(req.query.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    const plan = await buildSlotPlan(req.params.event_id, ag);
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'KCA ITS'; wb.created = new Date();
    const ws = wb.addWorksheet('Time-slots');
    ws.getColumn(1).width = 30; ws.getColumn(2).width = 40;
    ws.mergeCells('A1:B1');
    ws.getCell('A1').value = `${plan.event_code || ''} ${plan.event_name || ''} — ${plan.age_group_label || plan.age_group_code || ''}  ·  Time-slot plan`;
    ws.getCell('A1').font = { bold: true, size: 13 };
    ws.mergeCells('A2:B2');
    ws.getCell('A2').value = 'Chest numbers are not pre-assigned. At each slot\u2019s reporting time, chest numbers are drawn by lot for the children present. Please report on time \u2014 anyone not present at their slot\u2019s reporting time will be marked absent and will not receive a chest number.';
    ws.getCell('A2').alignment = { wrapText: true, vertical: 'top' };
    ws.getCell('A2').font = { italic: true, color: { argb: 'FF555555' } };
    ws.getRow(2).height = 44;
    let rn = 4;
    const section = (txt) => { const r = ws.getRow(rn++); const c = r.getCell(1); c.value = txt; c.font = { bold: true }; for (let k = 1; k <= 2; k++) r.getCell(k).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } }; };
    for (const sl of plan.slots) {
      section(`${sl.slot_label}${sl.reporting_time ? ' · report ' + sl.reporting_time : ''}`);
      [...sl.participants].sort((a, b) => String(a.name).localeCompare(b.name)).forEach((p) => {
        const r = ws.getRow(rn++);
        r.getCell(2).value = String(p.name || '').toUpperCase();
        if (p.status === 'absent') { r.getCell(2).font = { strike: true, color: { argb: 'FFAA0000' } }; }
      });
      rn++;
    }
    if (plan.unallocated.length) {
      section(`Not yet assigned a slot (${plan.unallocated.length})`);
      [...plan.unallocated].sort((a, b) => String(a.name).localeCompare(b.name)).forEach((p) => {
        const r = ws.getRow(rn++); r.getCell(2).value = String(p.name || '').toUpperCase();
      });
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'EXPORT_SLOT_PLAN_XLSX', entity: 'event_time_slots', entityId: req.params.event_id, details: { age_group_id: ag } });
    const buf = await wb.xlsx.writeBuffer();
    const fn = `slots-${(plan.event_code || 'event')}-${(plan.age_group_code || 'grp')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.send(Buffer.from(buf));
  } catch (err) { next(err); }
});

// ── POST /api/admin/chest/:event_id/assign-timeslot — chest draw per slot ─────
// On the day: lot-draw chest numbers for ATTENDED participants, slot by slot, using
// each slot's chest_no_start as the base (slot 1 → 1..5, slot 2 → 6..10, …). Absent
// children leave a gap in their slot's range. Requires participants to already be
// placed in slots (see allocate-slots) — otherwise there is nothing to number.
router.post('/:event_id/assign-timeslot', requireRole(...markRoles), async (req, res, next) => {
  try {
    const ag = grp(req.body.age_group_id);
    if (!ag) return res.status(400).json({ error: 'age_group_id is required' });
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    if (await groupUnmarked(req.params.event_id, ag) > 0)
      return res.status(409).json({ error: 'Mark every participant present or absent before assigning chest numbers.' });
    const slots = await eventSlots(req.params.event_id);
    if (!slots.length) return res.status(400).json({ error: 'No time slots configured for this event' });
    const { rows: unplaced } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM registrations
        WHERE event_id = $1 AND age_group_id = $2 AND status = 'attended' AND time_slot_id IS NULL`,
      [req.params.event_id, ag]);
    if (unplaced[0].c > 0)
      return res.status(409).json({ error: `${unplaced[0].c} present participant(s) are not placed in a slot. Use “Draw slots” first, then assign chest numbers.` });

    const { rows: existing } = await pool.query(
      `SELECT chest_number FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2`,
      [req.params.event_id, ag]);
    const taken = new Set(existing.map((r) => Number(r.chest_number)));
    let overflow = (taken.size ? Math.max(...taken) : 0) + 1;
    const assigned = [];
    for (const slot of slots) {
      const base = Number(slot.chest_no_start) || overflow;
      const cap = Number(slot.capacity) || 0;
      const free = [];
      for (let n = base; n < base + cap; n++) if (!taken.has(n)) free.push(n);
      const { rows: pending } = await pool.query(
        `SELECT r.id AS registration_id FROM registrations r
          WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.status = 'attended' AND r.time_slot_id = $3
            AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2)`,
        [req.params.event_id, ag, slot.id]);
      for (const reg of shuffle(pending)) {
        let chest = free.shift();
        if (chest == null) { while (taken.has(overflow)) overflow++; chest = overflow; }
        taken.add(chest); if (chest >= overflow) overflow = chest + 1;
        const { rows } = await pool.query(
          `INSERT INTO chest_assignments
             (year_id, event_id, age_group_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
           VALUES ($1,$2,$3,$4,$5,$6,'timeslot',$7) RETURNING registration_id, chest_number`,
          [yearId, req.params.event_id, ag, slot.id, reg.registration_id, chest, req.user.id]);
        assigned.push(rows[0]);
      }
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_TIMESLOT', entity: 'chest_assignments', entityId: req.params.event_id, details: { age_group_id: ag, count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});


// ── POST /api/admin/chest/:event_id/assign-slot — chest draw for ONE slot ─────
// Time-slot events: at a slot's reporting time, after marking that slot present/
// absent, draw chest numbers for the PRESENT children in the slot. Numbers run as
// one continuous sequence for the whole group (no gaps) — each slot continues from
// the last number given, so an absentee simply does not consume a number.
router.post('/:event_id/assign-slot', requireRole(...markRoles), async (req, res, next) => {
  try {
    const ag = grp(req.body.age_group_id);
    const slotId = grp(req.body.time_slot_id);
    if (!ag || !slotId) return res.status(400).json({ error: 'age_group_id and time_slot_id are required' });
    const yearId = await eventYearId(req.params.event_id);
    if (!yearId) return res.status(404).json({ error: 'Event not found' });
    const { rows: slk } = await pool.query(
      `SELECT id FROM event_time_slots WHERE id = $1 AND event_id = $2`, [slotId, req.params.event_id]);
    if (!slk[0]) return res.status(404).json({ error: 'Time slot not found for this event' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started for this group.' });
    // Everyone IN THIS SLOT must be marked present/absent first.
    const { rows: un } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM registrations
        WHERE event_id = $1 AND age_group_id = $2 AND time_slot_id = $3 AND status = 'registered'`,
      [req.params.event_id, ag, slotId]);
    if (un[0].c > 0)
      return res.status(409).json({ error: `Mark present or absent for all ${un[0].c} remaining participant(s) in this slot before drawing its chest numbers.` });
    // Continue numbering from the last chest already given in the group (no gaps).
    const { rows: mx } = await pool.query(
      `SELECT COALESCE(MAX(chest_number), 0) AS max_no FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2`,
      [req.params.event_id, ag]);
    let next_no = Number(mx[0].max_no) + 1;
    const { rows: pending } = await pool.query(
      `SELECT r.id AS registration_id FROM registrations r
        WHERE r.event_id = $1 AND r.age_group_id = $2 AND r.time_slot_id = $3 AND r.status = 'attended'
          AND r.id NOT IN (SELECT registration_id FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2)`,
      [req.params.event_id, ag, slotId]);
    const assigned = [];
    for (const reg of shuffle(pending)) {
      const { rows } = await pool.query(
        `INSERT INTO chest_assignments
           (year_id, event_id, age_group_id, time_slot_id, registration_id, chest_number, allocation_mode, allocated_by)
         VALUES ($1,$2,$3,$4,$5,$6,'timeslot',$7) RETURNING registration_id, chest_number`,
        [yearId, req.params.event_id, ag, slotId, reg.registration_id, next_no, req.user.id]);
      assigned.push(rows[0]); next_no++;
    }
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'ASSIGN_CHEST_SLOT', entity: 'chest_assignments', entityId: req.params.event_id,
      details: { age_group_id: ag, time_slot_id: slotId, count: assigned.length } });
    res.status(201).json(assigned);
  } catch (err) { next(err); }
});

router.put('/manual/:reg_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const { event_id, chest_number } = req.body;
    const manualReason = (req.body?.reason || '').trim();
    if (!event_id || !chest_number) return res.status(400).json({ error: 'event_id and chest_number are required' });
    const { rows: reg } = await pool.query(
      `SELECT year_id, age_group_id FROM registrations WHERE id = $1 AND event_id = $2`, [req.params.reg_id, event_id]);
    if (!reg[0]) return res.status(404).json({ error: 'Registration not found for this event' });
    const groupIsLocked = await groupLocked(event_id, reg[0].age_group_id);
    const target = Number(chest_number);
    if (!Number.isInteger(target) || target < 1)
      return res.status(400).json({ error: 'chest_number must be a positive whole number' });
    const mode = ['swap', 'reorder', 'set'].includes(req.body.mode) ? req.body.mode : 'set';
    const gid = reg[0].age_group_id;
    const rid = String(req.params.reg_id);

    // Rule #4 DB trigger (fn_enforce_manual_chest_role) authorises manual chest
    // entry from the session var app.current_role. Set it LOCAL to this
    // transaction so the trigger sees the signed-in staff role (never leaks to
    // other pooled requests). Swap/insert use a temp offset (chest stays > 0) to
    // avoid transient UNIQUE(event, group, chest) collisions.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_role', $1, true)`, [req.user.role || '']);

      const { rows: cur } = await client.query(
        `SELECT registration_id, chest_number FROM chest_assignments WHERE event_id = $1 AND age_group_id = $2`,
        [event_id, gid]);
      const editedOld = cur.find((c) => String(c.registration_id) === rid)?.chest_number ?? null;
      const occupant = cur.find((c) => c.chest_number === target && String(c.registration_id) !== rid);

      // Judging has started: allow ONLY adding a chest for a participant who has
      // none, into a free number (a late arrival). Renumbering, swapping or
      // displacing an existing chest after scoring began is not allowed.
      if (groupIsLocked && (editedOld != null || occupant)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Judging has started for this group — you can only ADD a chest for someone who has none, into a free number. Renumbering is not allowed now.' });
      }

      const mapping = new Map();   // registration_id (string) -> new chest number
      if (!occupant) {
        mapping.set(rid, target);
      } else if (mode === 'swap') {
        if (editedOld == null) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This participant has no chest number yet — use Insert instead of Swap.' }); }
        mapping.set(String(occupant.registration_id), editedOld);
        mapping.set(rid, target);
      } else if (mode === 'reorder') {
        if (editedOld != null) {
          if (target > editedOld) {
            for (const c of cur) if (c.chest_number > editedOld && c.chest_number <= target && String(c.registration_id) !== rid) mapping.set(String(c.registration_id), c.chest_number - 1);
          } else {
            for (const c of cur) if (c.chest_number >= target && c.chest_number < editedOld && String(c.registration_id) !== rid) mapping.set(String(c.registration_id), c.chest_number + 1);
          }
        } else {
          for (const c of cur) if (c.chest_number >= target) mapping.set(String(c.registration_id), c.chest_number + 1);
        }
        mapping.set(rid, target);
      } else {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `Chest number ${target} is already used in this group`, conflict: true });
      }

      // Phase 1 — park every affected existing row at a temp offset.
      for (const [r_id, nc] of mapping) {
        await client.query(
          `UPDATE chest_assignments SET chest_number = $1 WHERE event_id = $2 AND age_group_id = $3 AND registration_id = $4`,
          [nc + 100000, event_id, gid, r_id]);
      }
      // Phase 2 — write final numbers; the edited row becomes 'manual' (insert if it had none).
      for (const [r_id, nc] of mapping) {
        const isEdited = r_id === rid;
        const upd = await client.query(
          `UPDATE chest_assignments
             SET chest_number = $1, allocation_mode = COALESCE($2, allocation_mode), allocated_by = $3, allocated_at = NOW()
           WHERE event_id = $4 AND age_group_id = $5 AND registration_id = $6`,
          [nc, isEdited ? 'manual' : null, req.user.id, event_id, gid, r_id]);
        if (upd.rowCount === 0 && isEdited) {
          await client.query(
            `INSERT INTO chest_assignments (year_id, event_id, age_group_id, registration_id, chest_number, allocation_mode, allocated_by)
             VALUES ($1,$2,$3,$4,$5,'manual',$6)`,
            [reg[0].year_id, event_id, gid, req.params.reg_id, nc, req.user.id]);
        }
      }
      await client.query('COMMIT');
      await logAudit({ actorId: req.user.id, actorRole: req.user.role,
        action: 'MANUAL_CHEST_NUMBER', entity: 'chest_assignments', entityId: req.params.reg_id, details: { event_id, chest_number: target, mode, reason: manualReason || null }, reason: manualReason || null });
      res.json({ registration_id: Number(req.params.reg_id), chest_number: target, mode, affected: mapping.size });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') return res.status(409).json({ error: `Chest number ${target} is already used in this group` });
      throw e;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

// ── DELETE /api/admin/chest/:event_id?age_group_id= — clear (group or all) ────
router.delete('/:event_id', requireRole('Chairman', 'SuperAdmin'), async (req, res, next) => {
  try {
    const ag = grp(req.query.age_group_id);
    const reason = (req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to clear chest numbers.' });
    if (await groupLocked(req.params.event_id, ag))
      return res.status(409).json({ error: 'Chest numbers are locked — judging has started.' });
    const { rowCount } = await pool.query(
      `DELETE FROM chest_assignments WHERE event_id = $1 AND ($2::int IS NULL OR age_group_id = $2)`,
      [req.params.event_id, ag]);
    // Clearing a group resets it — drop any video-recording opt-ins for it too,
    // so they are re-captured fresh alongside the new chest assignment.
    const { rowCount: videoCleared } = await pool.query(
      `DELETE FROM video_requests WHERE event_id = $1 AND ($2::int IS NULL OR age_group_id = $2)`,
      [req.params.event_id, ag]);
    await logAudit({ actorId: req.user.id, actorRole: req.user.role,
      action: 'CLEAR_CHESTS', entity: 'chest_assignments', entityId: req.params.event_id, details: { age_group_id: ag, removed: rowCount, video_cleared: videoCleared, reason } });
    res.json({ removed: rowCount, video_cleared: videoCleared });
  } catch (err) { next(err); }
});

module.exports = router;
