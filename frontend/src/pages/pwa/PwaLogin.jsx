// src/pages/pwa/PwaLogin.jsx
// Participant login (rule #21): first 4 letters of the participant's name +
// last 4 digits of their CPR. No chest numbers anywhere in this app (rule #22).
import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UserRound, ArrowLeft } from 'lucide-react';
import { usePwaAuth } from '../../context/PwaAuthContext';

export default function PwaLogin() {
  const navigate = useNavigate();
  const { login, status, error } = usePwaAuth();
  const [namePrefix, setNamePrefix] = useState('');
  const [cprSuffix, setCprSuffix] = useState('');
  const busy = status === 'loading';
  const valid = namePrefix.trim().length === 4 && /^\d{4}$/.test(cprSuffix);

  async function submit(e) {
    e.preventDefault();
    if (!valid) return;
    try { await login(namePrefix.trim(), cprSuffix); navigate('/pwa/me'); } catch { /* error shown */ }
  }

  const input = 'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-center text-lg tracking-widest focus:outline-none focus:ring-2 focus:ring-navy-300';
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-navy-600 text-white"><UserRound size={22} /></div>
          <h1 className="text-lg font-bold text-navy-800">My Results</h1>
          <p className="mt-1 text-sm text-slate-500">Enter the first 4 letters of your name and the last 4 digits of your CPR.</p>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">First 4 letters of name</label>
            <input value={namePrefix} onChange={(e) => setNamePrefix(e.target.value.slice(0, 4))} maxLength={4} autoCapitalize="characters" placeholder="e.g. ANJA" className={input} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Last 4 digits of CPR</label>
            <input value={cprSuffix} onChange={(e) => setCprSuffix(e.target.value.replace(/\D/g, '').slice(0, 4))} maxLength={4} inputMode="numeric" placeholder="e.g. 4821" className={input} />
          </div>
          {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          <button type="submit" disabled={!valid || busy} className="w-full rounded-lg bg-navy-600 py-2.5 text-sm font-semibold text-white disabled:bg-navy-300">
            {busy ? 'Checking…' : 'View my results'}
          </button>
        </form>
        <div className="mt-4 text-center">
          <Link to="/pwa" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-navy-700"><ArrowLeft size={14} /> Public results board</Link>
        </div>
      </div>
    </div>
  );
}
