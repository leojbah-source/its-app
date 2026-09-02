// src/pages/register/registerApi.js
// API client for the parent-facing registration portal.
// Separate from the admin client.js — simpler, no admin-specific routes.

export const API_BASE =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

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

  /** Events for the active year; filter by age group, gender and kind. */
  events: (ageGroupId, gender, kind) => {
    const q = new URLSearchParams();
    if (ageGroupId) q.set('age_group_id', ageGroupId);
    if (gender) q.set('gender', gender);
    if (kind) q.set('kind', kind);
    const qs = q.toString();
    return req(`/api/register/events${qs ? `?${qs}` : ''}`);
  },

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

  /** Correct participant details (resets admin verification to pending). */
  participantUpdate: (token, id, data) =>
    req(`/api/register/participant/${id}`, { method: 'PATCH', token, body: data }),

  /** Create a new participant (or returns existing if CPR already registered). */
  participantCreate: (token, data) =>
    req('/api/register/participant', { method: 'POST', token, body: data }),

  /** Bulk initial event selection (first-time). */
  eventsRegister: (token, participantId, event_ids) =>
    req(`/api/register/participant/${participantId}/events`, {
      method: 'POST', token, body: { event_ids },
    }),

  /** Add / remove events after initial registration. removal_reason is
   *  required when remove_event_ids is non-empty (goes on the refund record). */
  eventsUpdate: (token, participantId, { add_event_ids = [], remove_event_ids = [], removal_reason }) =>
    req(`/api/register/participant/${participantId}/events`, {
      method: 'PUT', token,
      body: { add_event_ids, remove_event_ids, removal_reason },
    }),

  /** Re-verify the logged-in parent's KCA membership (after renewing). */
  membershipRefresh: (token, member_no) =>
    req('/api/register/membership/refresh', { method: 'POST', token, body: { member_no } }),

  /** Fee summary: per-event fees, payments, refunds, balance due. */
  fees: (token, participantId) =>
    req(`/api/register/participant/${participantId}/fees`, { token }),

  /** Submit a payment: { amount, method: 'cash'|'benefitpay'|'bank_transfer', reference, proof_url, notes } */
  paymentSubmit: (token, participantId, data) =>
    req(`/api/register/participant/${participantId}/payment`, {
      method: 'POST', token, body: data,
    }),

  /** Final confirmation: sends summary email + WhatsApp acknowledgement. */
  participantConfirm: (token, participantId) =>
    req(`/api/register/participant/${participantId}/confirm`, { method: 'POST', token, body: {} }),

  // ── Teams ────────────────────────────────────────────────────────────────
  myTeams: (token) => req('/api/register/my-teams', { token }),
  teamGet: (token, id) => req(`/api/register/team/${id}`, { token }),
  /** { event_id, team_name, school_id?, members: [{full_name,dob,cpr_number,gender?,school_id?}] } */
  teamCreate: (token, data) => req('/api/register/team', { method: 'POST', token, body: data }),
  teamAddMembers: (token, id, members) =>
    req(`/api/register/team/${id}/members`, { method: 'POST', token, body: { members } }),
  teamPayment: (token, id, data) =>
    req(`/api/register/team/${id}/payment`, { method: 'POST', token, body: data }),
  /** Upload a CPR scan for the team (image or PDF; may contain several members). */
  teamDocUpload: async (token, id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API_BASE}/api/register/team/${id}/documents`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'Upload failed');
    return d;
  },

  /** Save a teacher name. apply_to_all=true copies it to every dance (or
   *  music) event the participant has selected. */
  teacherUpdate: (token, participantId, { event_id, teacher_type, teacher_name, apply_to_all }) =>
    req(`/api/register/participant/${participantId}/teacher`, {
      method: 'PUT', token,
      body: { event_id, teacher_type, teacher_name, apply_to_all },
    }),
};
