// src/context/JudgeAuthContext.jsx
// Auth for the judge scoring portal. Login is phone + OTP (the OTP is sent by
// the admin from Event assignment, incl. via WhatsApp). Token persists in
// sessionStorage so a judge isn't signed out when the tablet sleeps.
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { authApi } from '../api/client';

const TOKEN_KEY = 'its_judge_token';
const INFO_KEY = 'its_judge_info';
const JudgeAuthContext = createContext(null);

export function JudgeAuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY));
  const [judge, setJudge] = useState(() => {
    try { const s = sessionStorage.getItem(INFO_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [error, setError] = useState(null);
  const [status, setStatus] = useState('idle');

  const sendOtp = useCallback(async (phone) => {
    setError(null);
    return authApi.sendOtp(phone); // { message, judgeId, isBlacklisted }
  }, []);

  const login = useCallback(async (phone, otp) => {
    setStatus('loading'); setError(null);
    try {
      const data = await authApi.verifyOtp(phone, otp); // { token, judge }
      sessionStorage.setItem(TOKEN_KEY, data.token);
      sessionStorage.setItem(INFO_KEY, JSON.stringify(data.judge || {}));
      setToken(data.token); setJudge(data.judge || {}); setStatus('idle');
      return data;
    } catch (err) { setError(err.message); setStatus('error'); throw err; }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(INFO_KEY);
    setToken(null); setJudge(null);
  }, []);

  const value = useMemo(() => ({
    token, judge, error, status, isAuthenticated: Boolean(token), sendOtp, login, logout,
  }), [token, judge, error, status, sendOtp, login, logout]);

  return <JudgeAuthContext.Provider value={value}>{children}</JudgeAuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useJudgeAuth() {
  const ctx = useContext(JudgeAuthContext);
  if (!ctx) throw new Error('useJudgeAuth must be used within JudgeAuthProvider');
  return ctx;
}
