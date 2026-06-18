// src/utils/otp.js
const pool = require('../db');

function generateOtpCode() {
  const length = Number(process.env.OTP_LENGTH || 6);
  const max = 10 ** length;
  return String(Math.floor(Math.random() * max)).padStart(length, '0');
}

async function createOtp(phone) {
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + Number(process.env.OTP_EXPIRY_MINUTES || 10) * 60000);
  await pool.query(
    `INSERT INTO otp_codes (phone, code, expires_at, created_at) VALUES ($1, $2, $3, NOW())`,
    [phone, code, expiresAt]
  );
  return code;
}

async function verifyOtp(phone, code) {
  const { rows } = await pool.query(
    `SELECT id FROM otp_codes
     WHERE phone = $1 AND code = $2 AND expires_at > NOW() AND consumed_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [phone, code]
  );
  if (!rows[0]) return false;
  await pool.query(`UPDATE otp_codes SET consumed_at = NOW() WHERE id = $1`, [rows[0].id]);
  return true;
}

module.exports = { generateOtpCode, createOtp, verifyOtp };
