// src/utils/otp.js
const pool = require('../db');

function generateOtpCode() {
  const length = Number(process.env.OTP_LENGTH || 6);
  const max = 10 ** length;
  return String(Math.floor(Math.random() * max)).padStart(length, '0');
}

// Create a login OTP for a phone.
//   opts.standing = true  -> no expiry, reusable until reset/resend (deferred
//                            judging). Normal codes expire after
//                            OTP_EXPIRY_MINUTES and are consumed on first use.
// Any previously-active code for the same phone is invalidated first, so only
// the latest code is ever valid ("resend" replaces the old one).
async function createOtp(phone, opts = {}) {
  const standing = !!opts.standing;
  const code = generateOtpCode();
  await pool.query(
    `UPDATE otp_codes SET consumed_at = NOW()
     WHERE phone = $1 AND consumed_at IS NULL`,
    [phone]
  );
  const expiresAt = standing
    ? null
    : new Date(Date.now() + Number(process.env.OTP_EXPIRY_MINUTES || 10) * 60000);
  await pool.query(
    `INSERT INTO otp_codes (phone, code, expires_at, standing, created_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [phone, code, expiresAt, standing]
  );
  return code;
}

async function verifyOtp(phone, code) {
  const { rows } = await pool.query(
    `SELECT id, standing FROM otp_codes
     WHERE phone = $1 AND code = $2
       AND consumed_at IS NULL
       AND (standing = TRUE OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [phone, code]
  );
  if (!rows[0]) return false;
  // Standing codes stay valid for repeated logins until reset/resend;
  // one-shot codes are consumed on first use.
  if (!rows[0].standing) {
    await pool.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [rows[0].id]);
  }
  return true;
}

// Invalidate every active code for a phone ("reset"). Returns how many.
async function revokeOtps(phone) {
  const { rowCount } = await pool.query(
    `UPDATE otp_codes SET consumed_at = NOW()
     WHERE phone = $1 AND consumed_at IS NULL`,
    [phone]
  );
  return rowCount;
}

// The current active code for a phone (for Chairman/SuperAdmin visibility), or null.
async function currentOtp(phone) {
  const { rows } = await pool.query(
    `SELECT code, standing, expires_at FROM otp_codes
     WHERE phone = $1 AND consumed_at IS NULL
       AND (standing = TRUE OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return rows[0] || null;
}

module.exports = { generateOtpCode, createOtp, verifyOtp, revokeOtps, currentOtp };
