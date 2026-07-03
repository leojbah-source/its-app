// src/pages/register/registerApi.js
// API client for the parent-facing registration portal.
// Separate from the admin client.js — simpler, no admin-specific routes.

export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

async function req(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.error || data.message))
      || (typeof data === 'string' && data)
      || `Request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const portalApi = {
  // ── Public (no auth) ──────────────────────────────────────────────────────
  config: () =>
    req('/api/register/config'),

  schools: () =>
    req('/api/register/schools'),

  ageGroups: () =>
    req('/api/register/age-groups'),

  /** Events for the active year; pass ageGroupId to filter to participant's group. */
  events: (ageGroupId) =>
    req(`/api/register/events${ageGroupId ? `?age_group_id=${ageGroupId}` : ''}`),

  // ── Authenticated ─────────────────────────────────────────────────────────
  /** All participants created by or registered by the current user. */
  myParticipants: (token) =>
    req('/api/register/my-participants', { token }),

  /** Lookup a participant by CPR number in the active year. */
  participantLookup: (token, cprNumber) =>
    req(`/api/register/participant/lookup?cpr_number=${encodeURIComponent(cprNumber.trim())}`, { token }),

  /** Full participant profile + registrations. */
  participantGet: (token, id) =>
    req(`/api/register/participant/${id}`, { token }),

  /** Create a new participant (or returns existing if CPR already registered). */
  participantCreate: (token, data) =>
    req('/api/register/participant', { method: 'POST', token, body: data }),

  /** Bulk initial event selection (first-time). */
  eventsRegister: (token, participantId, event_ids) =>
    req(`/api/register/participant/${participantId}/events`, {
      method: 'POST', token, body: { event_ids },
    }),

  /** Add / remove events after initial registration. */
  eventsUpdate: (token, participantId, { add_event_ids = [], remove_event_ids = [] }) =>
    req(`/api/register/participant/${participantId}/events`, {
      method: 'PUT', token,
      body: { add_event_ids, remove_event_ids },
    }),

  /** Save a teacher name for a specific event registration. */
  teacherUpdate: (token, participantId, { event_id, teacher_type, teacher_name }) =>
    req(`/api/register/participant/${participantId}/teacher`, {
      method: 'PUT', token,
      body: { event_id, teacher_type, teacher_name },
    }),
};
