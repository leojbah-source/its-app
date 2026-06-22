// Central API client for the ITS Admin Dashboard.
// Base URL is read from VITE_API_BASE_URL, falling back to the local dev backend.
export const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

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

export const authApi = {
  login: (email, password) =>
    request('/api/auth/login', { method: 'POST', body: { email, password } }),
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
  list: (token, params = {}) => {
    const cleaned = Object.fromEntries(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
    );
    const qs = new URLSearchParams(cleaned).toString();
    return request(`/api/admin/events${qs ? `?${qs}` : ''}`, { token });
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

export { ApiError };
