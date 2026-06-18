// src/routes/auth.routes.js  (mounted at /api/auth)
const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const { createOtp, verifyOtp } = require('../utils/otp');
const { sendWhatsApp } = require('../utils/notify');
const { logAudit } = require('../utils/audit');

const router = express.Router();

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  });
}

// POST /api/auth/login  (email + password -> JWT, for SuperAdmin/Admin/Coordinator/Chairman/Viewer)
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password are required' });

    const { rows } = await pool.query(
      `SELECT id, email, password_hash, name, role FROM users WHERE email = $1`,
      [email.toLowerCase()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ id: user.id, role: user.role, type: 'staff', email: user.email });
    await logAudit({ actorId: user.id, actorRole: user.role, action: 'LOGIN', entity: 'users', entityId: user.id });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/send-otp  (phone -> OTP; Convener/Admin initiates manually for judges - rule #12)
router.post('/send-otp', async (req, res, next) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required' });

    const { rows } = await pool.query(`SELECT id, is_blacklisted FROM judges WHERE phone = $1`, [phone]);
    if (!rows[0]) return res.status(404).json({ error: 'No judge found with this phone number' });

    const code = await createOtp(phone);
    await sendWhatsApp(phone, `Your KCA ITS judge login OTP is ${code}. Valid for ${process.env.OTP_EXPIRY_MINUTES || 10} minutes.`);
    res.json({ message: 'OTP sent', judgeId: rows[0].id, isBlacklisted: rows[0].is_blacklisted });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-otp  (phone + OTP -> JWT for the judge)
router.post('/verify-otp', async (req, res, next) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'phone and otp are required' });

    const valid = await verifyOtp(phone, otp);
    if (!valid) return res.status(401).json({ error: 'Invalid or expired OTP' });

    const { rows } = await pool.query(`SELECT id, name, is_blacklisted FROM judges WHERE phone = $1`, [phone]);
    const judge = rows[0];
    if (!judge) return res.status(404).json({ error: 'Judge not found' });

    const token = signToken({ id: judge.id, judgeId: judge.id, role: 'Judge', type: 'judge', phone });
    res.json({ token, judge: { id: judge.id, name: judge.name, isBlacklisted: judge.is_blacklisted } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/pwa-login  ({name_prefix, cpr_suffix} -> JWT) - rule #21
router.post('/pwa-login', async (req, res, next) => {
  try {
    const { name_prefix, cpr_suffix } = req.body;
    if (!name_prefix || !cpr_suffix) {
      return res.status(400).json({ error: 'name_prefix and cpr_suffix are required' });
    }
    if (name_prefix.length !== 4 || cpr_suffix.length !== 4) {
      return res.status(400).json({ error: 'name_prefix must be 4 chars and cpr_suffix must be 4 digits' });
    }

    const { rows } = await pool.query(
      `SELECT id, name, cpr_number, age_group FROM children
       WHERE LOWER(LEFT(name, 4)) = LOWER($1) AND RIGHT(cpr_number, 4) = $2`,
      [name_prefix, cpr_suffix]
    );
    if (!rows[0]) return res.status(401).json({ error: 'No matching participant found' });
    if (rows.length > 1) {
      // Ambiguous match - require contacting admin rather than guessing identity
      return res.status(409).json({ error: 'Multiple matches found, please contact the KCA ITS desk' });
    }

    const child = rows[0];
    const token = signToken({ childId: child.id, role: 'PWA', type: 'pwa' });
    res.json({ token, child: { id: child.id, name: child.name, ageGroup: child.age_group } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
