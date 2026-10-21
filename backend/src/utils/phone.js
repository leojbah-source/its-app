// src/utils/phone.js
// Canonical phone handling so judge login never fails on formatting.
// Bahrain mobiles are 8 digits. We reduce any input — with +973, 00973, a
// leading 0, spaces, dashes, brackets or stray invisible characters — to the
// bare 8-digit local number, and match on the last 8 digits so stored and
// typed numbers always line up.
function digitsOnly(raw) {
  return String(raw == null ? '' : raw).replace(/[^0-9]/g, '');
}

function normalizePhone(raw) {
  let d = digitsOnly(raw);
  if (d.startsWith('00973')) d = d.slice(5);        // 00 973 XXXXXXXX
  else if (d.length === 11 && d.startsWith('973')) d = d.slice(3); // 973 XXXXXXXX
  if (d.length === 9 && d.startsWith('0')) d = d.slice(1);         // 0XXXXXXXX
  return d;
}

// The key we compare on: the last 8 digits of the normalized number.
function phoneKey(raw) {
  return normalizePhone(raw).slice(-8);
}

module.exports = { digitsOnly, normalizePhone, phoneKey };
