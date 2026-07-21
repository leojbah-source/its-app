// src/pages/judge/JudgeLogin.jsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Gavel, LogIn, Send } from 'lucide-react';
import { useJudgeAuth } from '../../context/JudgeAuthContext';

export default function JudgeLogin() {
  const { login, sendOtp } = useJudgeAuth();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function requestOtp() {
    if (!phone.trim()) { setErr('Enter your phone number.'); return; }
    setBusy(true); setErr(''); setMsg('');
    try { await sendOtp(phone.trim()); setMsg('OTP sent. Check your WhatsApp/SMS.'); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function submit(e) {
    e.preventDefault();
    if (!phone.trim()) { setErr('Enter your phone number.'); return; }
    setBusy(true); setErr('');
    try { await login(phone.trim(), otp.trim()); navigate('/judge'); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  const inp = 'w-full rounded-lg border border-slate-300 px-4 py-3 text-base focus:outline-none focus:ring-2 focus:ring-navy-400';
  return (
    <div className="min-h-screen flex items-center justify-center bg-navy-800 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-7 shadow-xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-gold-500 text-white"><Gavel size={22} /></div>
          <div>
            <p className="text-lg font-semibold text-navy-900">Judge Scoring</p>
            <p className="text-xs text-slate-500">Indian Talent Scan · KCA Bahrain</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Phone number</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 39207951" className={inp} inputMode="tel" />
          </div>
          <button type="button" onClick={requestOtp} disabled={busy}
            className="inline-flex items-center gap-2 text-sm font-medium text-navy-600 hover:underline disabled:text-slate-400">
            <Send size={14} /> Send OTP to my phone
          </button>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">OTP <span className="font-normal text-slate-400">(if required)</span></label>
            <input value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code" className={inp} inputMode="numeric" />
          </div>
          {msg && <p className="text-sm text-green-600">{msg}</p>}
          {err && <p className="text-sm text-red-600">{err}</p>}
          <button type="submit" disabled={busy}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-navy-600 px-4 py-3 text-base font-semibold text-white hover:bg-navy-700 disabled:bg-navy-300">
            <LogIn size={18} /> {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-center text-xs text-slate-400">Enter the OTP if the organisers ask for it. During testing you may sign in with your phone alone.</p>
      </div>
    </div>
  );
}
