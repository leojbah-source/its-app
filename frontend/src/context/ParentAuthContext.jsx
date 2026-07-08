// src/context/ParentAuthContext.jsx
// Auth context for the public parent registration portal.
// Unlike the admin AuthContext (in-memory only), this persists the token in
// sessionStorage so parents aren't signed out when switching to camera/gallery
// on mobile. Session clears when the browser tab is closed.

import { createContext, useCallback, useContext, useMemo, useState, useEffect } from 'react';

const SESSION_TOKEN_KEY = 'its_parent_token';
const SESSION_USER_KEY  = 'its_parent_user';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';

const ParentAuthContext = createContext(null);

export function ParentAuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(SESSION_TOKEN_KEY));
  const [user,  setUser]  = useState(() => {
    try {
      const s = sessionStorage.getItem(SESSION_USER_KEY);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  });
  const [status, setStatus] = useState('idle');
  const [error,  setError]  = useState(null);

  // If we have a token but no user (e.g. sessionStorage was partially cleared),
  // try to decode the minimal fields from the JWT payload.
  useEffect(() => {
    if (token && !user) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const decoded = { id: payload.id, email: payload.email, full_name: payload.name || payload.email, role: payload.role };
        setUser(decoded);
        sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(decoded));
      } catch {
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        setToken(null);
      }
    }
  }, [token, user]);

  const _persist = useCallback((tok, usr) => {
    // Normalize: login returns {name}, signup/me returns {full_name}
    const normalized = { ...usr, full_name: usr.full_name || usr.name || usr.email };
    sessionStorage.setItem(SESSION_TOKEN_KEY, tok);
    sessionStorage.setItem(SESSION_USER_KEY, JSON.stringify(normalized));
    setToken(tok);
    setUser(normalized);
  }, []);

  const login = useCallback(async (email, password) => {
    setStatus('loading');
    setError(null);
    try {
      const res  = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      _persist(data.token, data.user);
      setStatus('idle');
      return data;
    } catch (err) {
      setError(err.message);
      setStatus('error');
      throw err;
    }
  }, [_persist]);

  const signup = useCallback(async ({ full_name, email, phone, whatsapp_number, kca_member_no, password }) => {
    setStatus('loading');
    setError(null);
    try {
      const res  = await fetch(`${API_BASE}/api/register/account`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ full_name, email, phone, whatsapp_number, kca_member_no, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Account creation failed');
      // Auto-login after signup
      return await login(email, password);
    } catch (err) {
      if (err.message !== 'Account creation failed') throw err; // re-throw login errors as-is
      setError(err.message);
      setStatus('error');
      throw err;
    }
  }, [login]);

  const logout = useCallback(() => {
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    sessionStorage.removeItem(SESSION_USER_KEY);
    setToken(null);
    setUser(null);
    setStatus('idle');
    setError(null);
  }, []);

  const value = useMemo(
    () => ({ token, user, status, error, isAuthenticated: Boolean(token), login, signup, logout }),
    [token, user, status, error, login, signup, logout],
  );

  return <ParentAuthContext.Provider value={value}>{children}</ParentAuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useParentAuth() {
  const ctx = useContext(ParentAuthContext);
  if (!ctx) throw new Error('useParentAuth must be used within a ParentAuthProvider');
  return ctx;
}
