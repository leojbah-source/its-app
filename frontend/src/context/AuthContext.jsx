import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { authApi, ApiError } from '../api/client';

const AuthContext = createContext(null);

// Per spec: the token lives only in React state. A page refresh signs the
// user out — there is no localStorage/sessionStorage persistence anywhere.
export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | loading | error
  const [error, setError] = useState(null);

  const login = useCallback(async (username, password) => {
    setStatus('loading');
    setError(null);
    try {
      const data = await authApi.login(username, password);
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
