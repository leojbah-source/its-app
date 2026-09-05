// Central API client for the ITS Admin Dashboard.
// Base URL priority:
//   1. VITE_API_BASE_URL if set (any environment)
//   2. local dev  -> http://localhost:4000 (Vite on 5173 talking to the API)
//   3. production -> '' (same origin: the backend serves this build, so /api/... is relative)
export const API_BASE =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

async function request(path, { method = 'GET', token, body, isFormData = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isFormData && body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: isFormData ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    throw new ApiError(
      `Could not reach the API at ${API_BASE}. Is the backend running?`,
      0,
      networkErr,
    );
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && (data.message || data.error)) ||
      (typeof data === 'string' && data) ||
      `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }

  return data;
}

/** Build a query string, dropping null/undefined/empty values. */
function qs(params = {}) {
  const cleaned = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const s = new URLSearchParams(cleaned).toString();
  return s ? `?${s}` : '';
}

export const authApi = {
  login: (email, password) =>
    request('/api/auth/login', { method: 'POST', body: { email, password } }),
  sendOtp: (phone) => request('/api/auth/send-otp', { method: 'POST', body: { phone } }),
  verifyOtp: (phone, otp) => request('/api/auth/verify-otp', { method: 'POST', body: { phone, otp } }),
  pwaLogin: (name_prefix, cpr_suffix) =>
    request('/api/auth/pwa-login', { method: 'POST', body: { name_prefix, cpr_suffix } }),
};

// Public board (no auth) — only ever returns published data.
export const publicApi = {
  year: () => request('/api/public/year'),
  schedule: (yearId) => request(`/api/public/schedule${qs({ year_id: yearId })}`),
  results: (yearId, eventId) => request(`/api/public/results${qs({ year_id: yearId, event_id: eventId })}`),
  resultCards: (yearId, eventId) => request(`/api/public/result-cards${qs({ year_id: yearId, event_id: eventId })}`),
  notices: (yearId) => request(`/api/public/notices${qs({ year_id: yearId })}`),
  awards: (yearId) => request(`/api/public/awards/${yearId}`),
};

// Participant PWA (token = pwa). Never exposes chest numbers (rule #22).
export const pwaApi = {
  mySchedule: (token) => request('/api/pwa/my-schedule', { token }),
  myResults: (token) => request('/api/pwa/my-results', { token }),
};

// Awards (Chairman/SuperAdmin). yearId may be 'active'.
export const awardsApi = {
  standings: (token, yearId = 'active') => request(`/api/admin/awards/${yearId}/standings`, { token }),
  exportCsv: (token, yearId = 'active') => request(`/api/admin/awards/${yearId}/export`, { token }),
};

// Branded print-outs (data only; the page renders + prints).
export const printoutsApi = {
  certificates: (token, yearId = 'active') => request(`/api/admin/printouts/certificates/${yearId}`, { token }),
  judgeReview: (token, yearId = 'active') => request(`/api/admin/printouts/judge-review/${yearId}`, { token }),
};

// Notices — admin CRUD (public read is publicApi.notices).
export const noticesApi = {
  list: (token, yearId = 'active') => request(`/api/admin/notices${qs({ year_id: yearId })}`, { token }),
  create: (token, body) => request('/api/admin/notices', { method: 'POST', token, body }),
  update: (token, id, body) => request(`/api/admin/notices/${id}`, { method: 'PUT', token, body }),
  remove: (token, id) => request(`/api/admin/notices/${id}`, { method: 'DELETE', token }),
  uploadFile: (token, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('/api/admin/notices/upload', { method: 'POST', token, body: fd, isFormData: true });
  },
};

// Finance (income / expenses / heads). yearId is a numeric year_config id.
export const financeApi = {
  summary: (token, yearId) => request(`/api/admin/finance/summary${qs({ year_id: yearId })}`, { token }),
  income: (token, yearId) => request(`/api/admin/finance/income${qs({ year_id: yearId })}`, { token }),
  addIncome: (token, body) => request('/api/admin/finance/income', { method: 'POST', token, body }),
  updateIncome: (token, id, body) => request(`/api/admin/finance/income/${id}`, { method: 'PUT', token, body }),
  deleteIncome: (token, id) => request(`/api/admin/finance/income/${id}`, { method: 'DELETE', token }),
  expenses: (token, yearId) => request(`/api/admin/finance/expenses${qs({ year_id: yearId })}`, { token }),
  addExpense: (token, body) => request('/api/admin/finance/expenses', { method: 'POST', token, body }),
  updateExpense: (token, id, body) => request(`/api/admin/finance/expenses/${id}`, { method: 'PUT', token, body }),
  deleteExpense: (token, id) => request(`/api/admin/finance/expenses/${id}`, { method: 'DELETE', token }),
  heads: (token, yearId) => request(`/api/admin/finance/expense-heads${qs({ year_id: yearId })}`, { token }),
  addHead: (token, body) => request('/api/admin/finance/expense-heads', { method: 'POST', token, body }),
  deleteHead: (token, id) => request(`/api/admin/finance/expense-heads/${id}`, { method: 'DELETE', token }),
  exportCsv: (token, yearId, type) => request(`/api/admin/finance/export${qs({ year_id: yearId, type })}`, { token }),
};

// Payment & refund verification (accountant / Chairman / Admin).
export const paymentsApi = {
  list: (token, { yearId, status, q } = {}) => request(`/api/admin/payments${qs({ year_id: yearId, status, q })}`, { token }),
  confirm: (token, id) => request(`/api/admin/payments/${id}/confirm`, { method: 'POST', token, body: {} }),
  reject: (token, id, reason) => request(`/api/admin/payments/${id}/reject`, { method: 'POST', token, body: { reason } }),
  refunds: (token, { yearId, status } = {}) => request(`/api/admin/refunds${qs({ year_id: yearId, status })}`, { token }),
  refundConfirm: (token, id, body) => request(`/api/admin/refunds/${id}/confirm`, { method: 'POST', token, body }),
  refundReject: (token, id) => request(`/api/admin/refunds/${id}/reject`, { method: 'POST', token, body: {} }),
};

// Judge-facing (token = judge). Chest numbers only; scoped per age group.
export const judgeApi = {
  events: (token) => request('/api/judge/events', { token }),
  briefing: (token, assignmentId) => request(`/api/judge/briefing/${assignmentId}`, { token }),
  groups: (token, assignmentId) => request(`/api/judge/events/${assignmentId}/groups`, { token }),
  sheet: (token, assignmentId, ageGroupId) =>
    request(`/api/judge/sheet/${assignmentId}?age_group_id=${ageGroupId}`, { token }),
  setCriteria: (token, assignmentId, criteria) =>
    request(`/api/judge/criteria/${assignmentId}`, { method: 'POST', token, body: { criteria } }),
  agreeCriteria: (token, assignmentId) =>
    request(`/api/judge/criteria/${assignmentId}/agree`, { method: 'POST', token, body: {} }),
  saveScores: (token, assignmentId, scores) =>
    request(`/api/judge/scores/${assignmentId}`, { method: 'POST', token, body: { scores } }),
};

export const yearConfigApi = {
  get: (token, year) =>
    request(`/api/admin/config/active${year ? `?year=${encodeURIComponent(year)}` : ''}`, { token }),
  update: (token, payload) =>
    request('/api/admin/config/active', { method: 'PUT', token, body: payload }),
  uploadAsset: (token, field, file) => {
    const fd = new FormData();
    fd.append('field', field);
    fd.append('file', file);
    return request('/api/admin/config/upload', { method: 'POST', token, body: fd, isFormData: true });
  },
  publish: (token, payload) =>
    request('/api/admin/config/active/publish', { method: 'POST', token, body: payload }),
  freezeRegistrations: (token) =>
    request('/api/admin/config/active/freeze', { method: 'POST', token }),
};

export const categoriesApi = {
  list: (token) => request('/api/admin/categories', { token }),
};

export const eventsApi = {
  list: (token, params = {}) => request(`/api/admin/events${qs(params)}`, { token }),

  /** Download all events as an Excel-compatible CSV. */
  exportCsv: async (token) => {
    const res = await fetch(`${API_BASE}/api/admin/events/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new ApiError('Export failed', res.status, null);
    return res.blob();
  },

  /** Upload an edited CSV back; upserts by event_code. */
  importCsv: async (token, csvText) => {
    const res = await fetch(`${API_BASE}/api/admin/events/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
      body: csvText,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new ApiError(data?.error || 'Import failed', res.status, data);
      throw err;
    }
    return data;
  },
  get: (token, id) => request(`/api/admin/events/${id}`, { token }),
  create: (token, payload) => request('/api/admin/events', { method: 'POST', token, body: payload }),
  update: (token, id, payload) =>
    request(`/api/admin/events/${id}`, { method: 'PUT', token, body: payload }),
  cancel: (token, id, reason) =>
    request(`/api/admin/events/${id}/cancel`, { method: 'POST', token, body: { reason } }),
  updateSlots: (token, id, slots) =>
    request(`/api/admin/events/${id}/slots`, { method: 'PUT', token, body: { slots } }),
};

// ── Registrations (admin) ────────────────────────────────────────────────────
export const registrationsApi = {
  /** List registrations; optional filters: event_id, status, age_group_id, search */
  list: (token, params = {}) =>
    request(`/api/admin/registrations${qs(params)}`, { token }),

  /** Per-event registration count summary */
  summary: (token) =>
    request('/api/admin/registrations/summary', { token }),

  /** Get single registration by id */
  get: (token, id) =>
    request(`/api/admin/registrations/${id}`, { token }),

  /** Update status / teacher fields */
  update: (token, id, payload) =>
    request(`/api/admin/registrations/${id}`, { method: 'PUT', token, body: payload }),

  /** Hard-delete (SuperAdmin / Admin only) */
  delete: (token, id) =>
    request(`/api/admin/registrations/${id}`, { method: 'DELETE', token }),

  /** CSV download URL (open in browser tab) */
  exportUrl: () => `${API_BASE}/api/admin/registrations/export`,
};

// ── Participants (admin) ─────────────────────────────────────────────────────
export const participantsApi = {
  /** Full verification detail: identity + scans, registrations, payments, audit. */
  detail: (token, id) => request(`/api/admin/participants/${id}/detail`, { token }),
  /** Mark CPR/identity verified, or flag an issue (note required; parent notified). */
  verify: (token, id, body) => request(`/api/admin/participants/${id}/verify`, { method: 'POST', token, body }),
  /** Chairman-only event corrections with mandatory reason. */
  chairmanEvents: (token, id, body) =>
    request(`/api/admin/participants/${id}/events`, { method: 'PUT', token, body }),
  /** Eligible individual events for add-corrections (public endpoint). */
  eligibleEvents: (token, ageGroupId, gender) =>
    request(`/api/register/events?age_group_id=${ageGroupId}&kind=individual${gender ? `&gender=${gender}` : ''}`, { token }),
  /** List participants; optional filters: search, school_id, age_group_id */
  list: (token, params = {}) =>
    request(`/api/admin/participants${qs(params)}`, { token }),
};

// ── Teams (admin) ────────────────────────────────────────────────────────────
export const teamsApi = {
  list: (token) => request('/api/admin/teams', { token }),
  members: (token, teamId) => request(`/api/admin/teams/${teamId}/members`, { token }),
};

export const listsApi = {
  byEvent: (token) => request('/api/admin/lists/by-event', { token }),
  byParticipant: (token) => request('/api/admin/lists/by-participant', { token }),
  final: (token) => request('/api/admin/lists/final', { token }),
  publishInitial: (token) => request('/api/admin/lists/publish-initial', { method: 'POST', token, body: {} }),
};

export const venuesApi = {
  list: (token) => request('/api/admin/schedule/venues', { token }),
  save: (token, venues) => request('/api/admin/schedule/venues', { method: 'PUT', token, body: { venues } }),
};

export const scheduleApi = {
  list: (token) => request('/api/admin/schedule', { token }),
  generateDraft: (token, body) => request('/api/admin/schedule/generate-draft', { method: 'POST', token, body }),
  update: (token, id, body) => request(`/api/admin/schedule/${id}`, { method: 'PUT', token, body }),
  publish: (token) => request('/api/admin/schedule/publish', { method: 'POST', token, body: {} }),
  categoryDates: (token) => request('/api/admin/schedule/category-dates', { token }),
  saveCategoryDates: (token, dates) => request('/api/admin/schedule/category-dates', { method: 'PUT', token, body: { dates } }),
};

// ── Schools lookup ───────────────────────────────────────────────────────────
export const timerApi = {
  myEvents: (token) => request('/api/timer/my-events', { token }),
  groups: (token, eventId) => request(`/api/timer/groups/${eventId}`, { token }),
  participants: (token, eventId, ageGroupId) =>
    request(`/api/timer/participants/${eventId}${ageGroupId ? `?age_group_id=${ageGroupId}` : ''}`, { token }),
  start: (token, eventId, body) => request(`/api/timer/${eventId}/start`, { method: 'POST', token, body }),
  stop: (token, eventId, registration_id) => request(`/api/timer/${eventId}/stop`, { method: 'POST', token, body: { registration_id } }),
  override: (token, eventId, body) => request(`/api/timer/${eventId}/override`, { method: 'POST', token, body }),
};

export const mcApi = {
  myEvents: (token) => request('/api/mc/my-events', { token }),
  script: (token, eventId) => request(`/api/mc/script/${eventId}`, { token }),
  participants: (token, eventId) => request(`/api/mc/participants/${eventId}`, { token }),
};

export const eventStaffApi = {
  users: (token, role) => request(`/api/admin/event-staff/users?role=${role}`, { token }),
  createUser: (token, body) => request('/api/admin/event-staff/users', { method: 'POST', token, body }),
  forEvent: (token, eventId) => request(`/api/admin/event-staff/event/${eventId}`, { token }),
  assign: (token, body) => request('/api/admin/event-staff/assign', { method: 'POST', token, body }),
  unassign: (token, role, assignmentId) => request(`/api/admin/event-staff/assign/${role}/${assignmentId}`, { method: 'DELETE', token }),
};

export const resultsApi = {
  groups: (token, eventId) => request(`/api/admin/results/${eventId}/groups`, { token }),
  get: (token, eventId, ag) => request(`/api/admin/results/${eventId}/${ag}`, { token }),
  compute: (token, eventId, ag) => request(`/api/admin/results/${eventId}/${ag}/compute`, { method: 'POST', token, body: {} }),
  reviewDivergence: (token, eventId, ag, registration_id, note) => request(`/api/admin/results/${eventId}/${ag}/divergence`, { method: 'POST', token, body: { registration_id, note } }),
  finalise: (token, eventId, ag) => request(`/api/admin/results/${eventId}/${ag}/finalise`, { method: 'POST', token, body: {} }),
  publish: (token, eventId, ag) => request(`/api/admin/results/${eventId}/${ag}/publish`, { method: 'POST', token, body: {} }),
  tiebreakUnlock: (token, eventId, ag) => request(`/api/admin/results/${eventId}/${ag}/tiebreak/unlock`, { method: 'POST', token, body: {} }),
  tiebreakMarks: (token, eventId, ag, unlock_id, marks) => request(`/api/admin/results/${eventId}/${ag}/tiebreak/marks`, { method: 'POST', token, body: { unlock_id, marks } }),
  setExtraPrize: (token, eventId, ag, registration_id, extra_prize_type) => request(`/api/admin/results/${eventId}/${ag}/extra-prize`, { method: 'POST', token, body: { registration_id, extra_prize_type } }),
  sheet: (token, eventId, ag) => request(`/api/admin/results/${eventId}/${ag}/sheet`, { token }),
};

export const chestApi = {
  groups: (token, eventId) => request(`/api/admin/chest/${eventId}/groups`, { token }),
  roster: (token, eventId, ageGroupId) =>
    request(`/api/admin/chest/${eventId}/roster${ageGroupId ? `?age_group_id=${ageGroupId}` : ''}`, { token }),
  markAttendance: (token, eventId, registration_id, present) =>
    request(`/api/admin/chest/${eventId}/attendance`, { method: 'POST', token, body: { registration_id, present } }),
  assignAuto: (token, eventId, age_group_id) =>
    request(`/api/admin/chest/${eventId}/assign-auto`, { method: 'POST', token, body: { age_group_id } }),
  assignTimeslot: (token, eventId, age_group_id) =>
    request(`/api/admin/chest/${eventId}/assign-timeslot`, { method: 'POST', token, body: { age_group_id } }),
  manual: (token, regId, event_id, chest_number) =>
    request(`/api/admin/chest/manual/${regId}`, { method: 'PUT', token, body: { event_id, chest_number } }),
  clear: (token, eventId, ageGroupId, reason) =>
    request(`/api/admin/chest/${eventId}${ageGroupId ? `?age_group_id=${ageGroupId}` : ''}`, { method: 'DELETE', token, body: { reason } }),
};

export const schoolsApi = {
  list: (token) => request('/api/admin/schools', { token }),
};

export const judgesApi = {
  list: (token) => request('/api/admin/judges', { token }),
  full: (token, id) => request(`/api/admin/judges/${id}/full`, { token }),
  create: (token, body) => request('/api/admin/judges', { method: 'POST', token, body }),
  update: (token, id, body) => request(`/api/admin/judges/${id}`, { method: 'PUT', token, body }),
  remove: (token, id) => request(`/api/admin/judges/${id}`, { method: 'DELETE', token }),
  blacklist: (token, id, reason) => request(`/api/admin/judges/${id}/blacklist`, { method: 'POST', token, body: { reason } }),
  unblacklist: (token, id) => request(`/api/admin/judges/${id}/unblacklist`, { method: 'POST', token, body: {} }),
  sendOtp: (token, id) => request(`/api/admin/judges/${id}/send-otp`, { method: 'POST', token, body: {} }),
  assignments: (token, id) => request(`/api/admin/judges/${id}/assignments`, { token }),
  eventJudges: (token, eventId) => request(`/api/admin/judges/event/${eventId}`, { token }),
  scheduleEvents: (token) => request('/api/admin/judges/schedule-events', { token }),
  candidates: (token, eventId) => request(`/api/admin/judges/candidates/${eventId}`, { token }),
  eventAssignments: (token) => request('/api/admin/judges/event-assignments', { token }),
  sendEventOtps: (token, eventId) => request(`/api/admin/judges/event/${eventId}/send-otps`, { method: 'POST', token, body: {} }),
  assign: (token, body) => request('/api/admin/judges/assign', { method: 'POST', token, body }),
  unassign: (token, assignmentId) => request(`/api/admin/judges/assign/${assignmentId}`, { method: 'DELETE', token }),
  blacklistReport: (token) => request('/api/admin/judges/blacklist-report', { token }),
};

export { ApiError };
