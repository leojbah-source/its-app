import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { authApi, ApiError } from '../api/client';

const PwaAuthContext = createContext(null);

// Participant PWA session (rule #21 login: first 4 of name + last 4 of CPR).
// sessionStorage so a refresh on a phone doesn't sign the participant out.
const TOKEN_KEY = 'its_pwa_token';
const USER_KEY = 'its_pwa_participant';

export function PwaAuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [participant, setParticipant] = useState(() => {
    try { const s = sessionStorage.getItem(USER_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const login = useCallback(async (namePrefix, cprSuffix) => {
    setStatus('loading'); setError(null);
    try {
      const data = await authApi.pwaLogin(namePrefix, cprSuffix);
      sessionStorage.setItem(TOKEN_KEY, data.token);
      sessionStorage.setItem(USER_KEY, JSON.stringify(data.participant || {}));
      setToken(data.token); setParticipant(data.participant || null); setStatus('idle');
      return data;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign in failed.');
      setStatus('error'); throw err;
    }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(USER_KEY);
    setToken(null); setParticipant(null); setStatus('idle'); setError(null);
  }, []);

  const value = useMemo(
    () => ({ token, participant, status, error, isAuthenticated: Boolean(token), login, logout }),
    [token, participant, status, error, login, logout],
  );
  return <PwaAuthContext.Provider value={value}>{children}</PwaAuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function usePwaAuth() {
  const ctx = useContext(PwaAuthContext);
  if (!ctx) throw new Error('usePwaAuth must be used within a PwaAuthProvider');
  return ctx;
}
