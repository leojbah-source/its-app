// src/utils/phone.js
// Phone-number validation shared across the registration portal.
//
// Contact numbers (parent phone, guardian phone, team captain) are Bahrain
// numbers: exactly 8 digits, ignoring spaces and an optional +973 / 00973
// country code. WhatsApp numbers may be from any country, so they are only
// checked for a sane international length (8–15 digits, optional leading +).

export const onlyDigits = (s) => String(s ?? '').replace(/\D/g, '');

/** Strip an optional Bahrain country code and return the local digits. */
export function bahrainLocal(raw) {
  let d = onlyDigits(raw);
  if (d.startsWith('00973')) d = d.slice(5);
  else if (d.length === 11 && d.startsWith('973')) d = d.slice(3);
  return d;
}

/** True when `raw` is a valid Bahrain contact number (8 local digits). */
export const isBahrainPhone = (raw) => bahrainLocal(raw).length === 8;

/** True when `raw` is a plausible international number (8–15 digits). */
export function isIntlPhone(raw) {
  const d = onlyDigits(raw);
  return d.length >= 8 && d.length <= 15;
}
