// src/routes/admin.finance.routes.js  (mounted at /api/admin/finance)
const express = require('express');
const pool = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);
const staffRoles = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];
const editRoles = ['SuperAdmin', 'Admin', 'Coordinator'];

function toCsv(rows, columns) {
  const header = columns.join(',');
  const body = rows.map((r) =>
    columns.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')
  );
  return [header, ...body].join('\n');
}

// ---------------------------------------------------------------- INCOME --
// GET /api/admin/finance/income?year_id=
router.get('/income', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM finance_income WHERE ($1::int IS NULL OR year_id = $1) ORDER BY date DESC, id DESC`,
      [year_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/finance/income
router.post('/income', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { year_id, source, amount, date, notes } = req.body;
    if (!year_id || !source || amount == null || !date) {
      return res.status(400).json({ error: 'year_id, source, amount and date are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO finance_income (year_id, source, amount, date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [year_id, source, amount, date, notes || null, req.user.id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CREATE_INCOME', entity: 'finance_income', entityId: rows[0].id, details: { source, amount } });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/finance/income/:id
router.put('/income/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { source, amount, date, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE finance_income SET
         source = COALESCE($1, source),
         amount = COALESCE($2, amount),
         date = COALESCE($3, date),
         notes = COALESCE($4, notes)
       WHERE id = $5 RETURNING *`,
      [source, amount, date, notes, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Income record not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_INCOME', entity: 'finance_income', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/finance/income/:id
router.delete('/income/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`DELETE FROM finance_income WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Income record not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_INCOME', entity: 'finance_income', entityId: req.params.id });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------- EXPENSES --
// GET /api/admin/finance/expenses?year_id=&expense_head_id=
router.get('/expenses', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id, expense_head_id } = req.query;
    const { rows } = await pool.query(
      `SELECT e.*, h.name AS expense_head_name
       FROM finance_expenses e
       LEFT JOIN finance_expense_heads h ON h.id = e.expense_head_id
       WHERE ($1::int IS NULL OR e.year_id = $1)
         AND ($2::int IS NULL OR e.expense_head_id = $2)
       ORDER BY e.date DESC, e.id DESC`,
      [year_id || null, expense_head_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/finance/expenses
router.post('/expenses', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { year_id, expense_head_id, amount, date, vendor, notes } = req.body;
    if (!year_id || !expense_head_id || amount == null || !date) {
      return res.status(400).json({ error: 'year_id, expense_head_id, amount and date are required' });
    }
    const { rows } = await pool.query(
      `INSERT INTO finance_expenses (year_id, expense_head_id, amount, date, vendor, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [year_id, expense_head_id, amount, date, vendor || null, notes || null, req.user.id]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CREATE_EXPENSE', entity: 'finance_expenses', entityId: rows[0].id, details: { expense_head_id, amount } });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/finance/expenses/:id
router.put('/expenses/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { expense_head_id, amount, date, vendor, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE finance_expenses SET
         expense_head_id = COALESCE($1, expense_head_id),
         amount = COALESCE($2, amount),
         date = COALESCE($3, date),
         vendor = COALESCE($4, vendor),
         notes = COALESCE($5, notes)
       WHERE id = $6 RETURNING *`,
      [expense_head_id, amount, date, vendor, notes, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Expense record not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_EXPENSE', entity: 'finance_expenses', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/finance/expenses/:id
router.delete('/expenses/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`DELETE FROM finance_expenses WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Expense record not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_EXPENSE', entity: 'finance_expenses', entityId: req.params.id });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------- EXPENSE HEADS --
// GET /api/admin/finance/expense-heads?year_id=
router.get('/expense-heads', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    const { rows } = await pool.query(
      `SELECT * FROM finance_expense_heads WHERE ($1::int IS NULL OR year_id = $1) ORDER BY name`,
      [year_id || null]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/finance/expense-heads
router.post('/expense-heads', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { year_id, name } = req.body;
    if (!year_id || !name) return res.status(400).json({ error: 'year_id and name are required' });
    const { rows } = await pool.query(
      `INSERT INTO finance_expense_heads (year_id, name) VALUES ($1,$2) RETURNING *`,
      [year_id, name]
    );
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'CREATE_EXPENSE_HEAD', entity: 'finance_expense_heads', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// PUT /api/admin/finance/expense-heads/:id
router.put('/expense-heads/:id', requireRole(...editRoles), async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await pool.query(
      `UPDATE finance_expense_heads SET name = $1 WHERE id = $2 RETURNING *`,
      [name, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Expense head not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'UPDATE_EXPENSE_HEAD', entity: 'finance_expense_heads', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/admin/finance/expense-heads/:id
router.delete('/expense-heads/:id', requireRole('SuperAdmin', 'Admin'), async (req, res, next) => {
  try {
    const { rows: inUse } = await pool.query(`SELECT id FROM finance_expenses WHERE expense_head_id = $1 LIMIT 1`, [req.params.id]);
    if (inUse[0]) {
      return res.status(409).json({ error: 'Cannot delete: expense head is referenced by existing expense records' });
    }
    const { rows } = await pool.query(`DELETE FROM finance_expense_heads WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Expense head not found' });
    await logAudit({ actorId: req.user.id, actorRole: req.user.role, action: 'DELETE_EXPENSE_HEAD', entity: 'finance_expense_heads', entityId: req.params.id });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------------- //
// GET /api/admin/finance/summary?year_id=
router.get('/summary', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id } = req.query;
    if (!year_id) return res.status(400).json({ error: 'year_id query parameter is required' });

    const { rows: incomeRows } = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_income FROM finance_income WHERE year_id = $1`,
      [year_id]
    );
    const { rows: expenseByHead } = await pool.query(
      `SELECT h.id AS expense_head_id, h.name AS expense_head_name, COALESCE(SUM(e.amount), 0) AS total
       FROM finance_expense_heads h
       LEFT JOIN finance_expenses e ON e.expense_head_id = h.id AND e.year_id = $1
       WHERE h.year_id = $1
       GROUP BY h.id, h.name
       ORDER BY h.name`,
      [year_id]
    );
    const totalExpenses = expenseByHead.reduce((sum, r) => sum + Number(r.total), 0);
    const totalIncome = Number(incomeRows[0].total_income);

    res.json({
      yearId: Number(year_id),
      totalIncome,
      totalExpenses,
      net: totalIncome - totalExpenses,
      expenseByHead,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/finance/export?year_id=&type=income|expenses  (default: combined ledger)
router.get('/export', requireRole(...staffRoles), async (req, res, next) => {
  try {
    const { year_id, type } = req.query;
    if (!year_id) return res.status(400).json({ error: 'year_id query parameter is required' });

    if (type === 'income') {
      const { rows } = await pool.query(`SELECT * FROM finance_income WHERE year_id = $1 ORDER BY date`, [year_id]);
      const csv = toCsv(rows, ['id', 'source', 'amount', 'date', 'notes', 'created_by']);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="income_${year_id}.csv"`);
      return res.send(csv);
    }

    if (type === 'expenses') {
      const { rows } = await pool.query(
        `SELECT e.*, h.name AS expense_head_name FROM finance_expenses e
         LEFT JOIN finance_expense_heads h ON h.id = e.expense_head_id
         WHERE e.year_id = $1 ORDER BY e.date`,
        [year_id]
      );
      const csv = toCsv(rows, ['id', 'expense_head_name', 'amount', 'date', 'vendor', 'notes', 'created_by']);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="expenses_${year_id}.csv"`);
      return res.send(csv);
    }

    // Combined ledger: income as positive entries, expenses as negative entries
    const { rows: income } = await pool.query(
      `SELECT date, 'income' AS kind, source AS description, amount FROM finance_income WHERE year_id = $1`,
      [year_id]
    );
    const { rows: expenses } = await pool.query(
      `SELECT e.date, 'expense' AS kind, COALESCE(h.name, 'Uncategorised') AS description, -e.amount AS amount
       FROM finance_expenses e LEFT JOIN finance_expense_heads h ON h.id = e.expense_head_id
       WHERE e.year_id = $1`,
      [year_id]
    );
    const ledger = [...income, ...expenses].sort((a, b) => new Date(a.date) - new Date(b.date));
    const csv = toCsv(ledger, ['date', 'kind', 'description', 'amount']);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="finance_ledger_${year_id}.csv"`);
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
