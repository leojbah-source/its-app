// src/utils/registration.js
// Shared, side-effect-free registration helpers used by the admin
// "mark complete" and Excel-import features. These mirror the local helpers in
// routes/register.routes.js (the parent-facing flow) so admin-side actions apply
// the exact same rules — fees, gender/age-group eligibility, CPR↔DOB check.
// Additive: register.routes.js keeps its own copies and is not modified.

const pool = require('../db');

/** BHD uses 3 decimal places. */
const round3 = (x) => Math.round(Number(x) * 1000) / 1000;

const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

/** Strip an optional Bahrain country code and return the local digits. */
function bahrainLocal(raw) {
  let d = onlyDigits(raw);
  if (d.startsWith('00973')) d = d.slice(5);
  else if (d.length === 11 && d.startsWith('973')) d = d.slice(3);
  return d;
}
/** True when `raw` is a valid Bahrain contact number (8 local digits). */
const isBahrainPhone = (raw) => bahrainLocal(raw).length === 8;
/** True when `raw` is a plausible international number (8–15 digits). */
function isIntlPhone(raw) {
  const d = onlyDigits(raw);
  return d.length >= 8 && d.length <= 15;
}

/** Fee for one event: member rate when KCA membership is verified active. */
function eventFee(ev, memberActive) {
  const std = Number(ev.fee_amount || 0);
  if (!memberActive) return round3(std);
  return round3(ev.member_fee_amount != null ? Number(ev.member_fee_amount) : std);
}

/** Gender eligibility (§4.1 event gender split): 'boys' = M, 'girls' = F. */
function genderEligible(genderSplit, participantGender) {
  if (genderSplit === 'boys')  return participantGender === 'M';
  if (genderSplit === 'girls') return participantGender === 'F';
  return true; // 'common' / 'none' / unset
}

/**
 * Bahrain CPR format: YYMM##### (9 digits; a leading 0 may be dropped, so
 * 8 digits is also valid). Returns an error string when the CPR prefix does
 * not match the DOB, else null.
 */
function cprDobMismatch(cpr, dob) {
  const digits = String(cpr).replace(/\D/g, '');
  if (digits.length !== 8 && digits.length !== 9)
    return 'CPR number must be 8 or 9 digits';
  const full = digits.length === 8 ? '0' + digits : digits;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return 'Invalid date of birth';
  const yy = String(d.getFullYear() % 100).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  if (full.slice(0, 2) !== yy || full.slice(2, 4) !== mm)
    return `CPR starts with ${full.slice(0, 4)} but date of birth ${dob} requires ${yy}${mm} (YYMM)`;
  return null;
}

/** The PARENT account's membership drives member rates (collected at signup). */
async function parentMemberActive(db, userId) {
  const d = db || pool;
  const { rows } = await d.query(
    `SELECT membership_status FROM users WHERE id = $1`, [userId]);
  return rows[0]?.membership_status === 'active';
}

/** Looks up the age_group_id for a given DOB (ISO string) within a year. */
async function resolveAgeGroup(dob, yearId, db) {
  const d = db || pool;
  const { rows } = await d.query(
    `SELECT id FROM age_groups
     WHERE year_id = $1 AND dob_from <= $2::date AND dob_to >= $2::date
     LIMIT 1`,
    [yearId, dob],
  );
  return rows[0]?.id || null;
}

module.exports = {
  round3, onlyDigits, bahrainLocal, isBahrainPhone, isIntlPhone,
  eventFee, genderEligible, cprDobMismatch, parentMemberActive, resolveAgeGroup,
};
