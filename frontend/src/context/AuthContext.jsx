import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { authApi, ApiError } from '../api/client';

const AuthContext = createContext(null);

// Session persists in sessionStorage so a page refresh (or a tablet waking from
// sleep) does NOT sign the user out — important for MC/Timer day-of tablets and
// convenient for admins. It clears when the browser tab is closed. (The judge
// and parent portals use the same pattern.)
const TOKEN_KEY = 'its_staff_token';
const USER_KEY = 'its_staff_user';

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try { const s = sessionStorage.getItem(USER_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState(null);

  // If we have a token but the stored user was lost, recover minimal fields
  // from the JWT payload so role-based routing/UI still works after a refresh.
  useEffect(() => {
    if (token && !user) {
      try {
        const p = JSON.parse(atob(token.split('.')[1]));
        const decoded = { id: p.id, role: p.role, email: p.email, full_name: p.name || p.email, name: p.name };
        setUser(decoded);
        sessionStorage.setItem(USER_KEY, JSON.stringify(decoded));
      } catch {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken(null);
      }
    }
  }, [token, user]);

  const login = useCallback(async (username, password) => {
    setStatus('loading');
    setError(null);
    try {
      const data = await authApi.login(username, password);
      sessionStorage.setItem(TOKEN_KEY, data.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(data.user || {}));
      setToken(data.token);
      setUser(data.user || null);
      setStatus('idle');
      return data;
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Sign in failed. Please try again.';
      setError(message);
      setStatus('error');
      throw err;
    }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
    setStatus('idle');
    setError(null);
  }, []);

  const value = useMemo(
    () => ({
      token,
      user,
      status,
      error,
      isAuthenticated: Boolean(token),
      login,
      logout,
    }),
    [token, user, status, error, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
