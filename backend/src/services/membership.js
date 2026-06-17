'use strict';

/**
 * services/membership.js
 * ---------------------------------------------------------------------------
 * KCA Indian Talent Scan — KCA membership verification.
 *
 * Calls the live membership API (mem.kcabah.com) to confirm a member number
 * is valid and paid up to date. Used during registration and again by
 * awards.js when computing the KCA Special Group Championship.
 *
 * The HTTP client and timeout are injectable so this can be unit tested
 * without a real network call:
 *
 *   verifyMembership(memberNo, requiredUpToDate, { fetchImpl, timeoutMs, baseUrl })
 * ---------------------------------------------------------------------------
 */

const DEFAULT_BASE_URL =
  process.env.KCA_MEMBERSHIP_API_URL || 'https://mem.kcabah.com/api/verify';
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Verifies a member number against the live KCA membership API.
 *
 * @param {string} memberNo
 * @param {string|number} requiredUpToDate - e.g. a year ('2026') or a date
 *        the membership's `paid_up_to` value must meet or exceed. Pass
 *        null/undefined to skip the paid-up-to comparison.
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable fetch (defaults to global fetch)
 * @param {number} [opts.timeoutMs] - request timeout in ms (default 3000)
 * @param {string} [opts.baseUrl] - override the verify endpoint base URL
 * @returns {Promise<{valid: boolean, name?: string|null, active?: boolean, error?: string}>}
 */
async function verifyMembership(memberNo, requiredUpToDate, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const baseUrl = opts.baseUrl || DEFAULT_BASE_URL;

  if (!fetchImpl) {
    return { valid: false, error: 'API_UNAVAILABLE' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `${baseUrl}?member_no=${encodeURIComponent(memberNo)}`;
    const response = await fetchImpl(url, { signal: controller.signal });

    if (!response.ok) {
      return { valid: false, error: 'API_UNAVAILABLE' };
    }

    const data = await response.json();

    const paidUpToOk =
      requiredUpToDate == null ||
      (data.paid_up_to != null && data.paid_up_to >= requiredUpToDate);

    return {
      valid: Boolean(data.valid),
      name: data.name ?? null,
      active: Boolean(data.active) && paidUpToOk,
    };
  } catch (err) {
    // Covers network errors, timeouts (AbortError), and JSON parse failures.
    return { valid: false, error: 'API_UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { verifyMembership };
