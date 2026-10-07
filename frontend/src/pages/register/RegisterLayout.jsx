// src/pages/register/RegisterLayout.jsx
// Mobile-first layout wrapper for the parent registration portal.
// No admin sidebar. Sticky navy header with ITS branding + optional back button.

import { useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Sparkles, LogOut, ChevronLeft, UserCog } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import BrandMark from '../../components/ui/BrandMark';
import { portalApi } from './registerApi';

export default function RegisterLayout({
  children,
  title,
  subtitle,
  showBack = false,
  backTo = '/register/dashboard',
}) {
  const { isAuthenticated, user, logout, token } = useParentAuth();
  const navigate = useNavigate();
  const [profileOpen, setProfileOpen] = useState(false);

  function handleLogout() {
    logout();
    navigate('/register', { replace: true });
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* ── Sticky header ──────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-20 bg-navy-800 text-white shadow-md">
        <div className="flex items-center justify-between px-4 py-3 max-w-lg mx-auto w-full">
          {/* Left: back button or logo */}
          <div className="flex items-center gap-2 min-w-0">
            {showBack && (
              <button
                onClick={() => navigate(backTo)}
                className="p-1.5 rounded-md hover:bg-white/10 shrink-0"
                aria-label="Go back"
              >
                <ChevronLeft size={22} />
              </button>
            )}
            <div className="flex items-center gap-2 min-w-0">
              <BrandMark className="h-8 w-8 rounded-lg shrink-0" fallback={Sparkles} fallbackSize={15} />
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight truncate">Indian Talent Scan</p>
                <p className="text-[10px] text-navy-300 leading-tight">KCA Bahrain</p>
              </div>
            </div>
          </div>

          {/* Right: user name + logout */}
          {isAuthenticated && (
            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              <button
                onClick={() => setProfileOpen(true)}
                className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-navy-100 hover:bg-white/10"
                aria-label="My details"
                title="Edit my details"
              >
                <UserCog size={16} />
                <span className="hidden sm:block truncate max-w-[110px]">{user?.full_name?.split(' ')[0] || user?.email}</span>
              </button>
              <button
                onClick={handleLogout}
                className="p-1.5 rounded-md hover:bg-white/10 text-navy-300 hover:text-white"
                aria-label="Sign out"
              >
                <LogOut size={17} />
              </button>
            </div>
          )}
        </div>

        {/* Page title row */}
        {title && (
          <div className="px-4 pb-3 max-w-lg mx-auto w-full">
            <h1 className="text-xl font-bold leading-tight truncate">{title}</h1>
            {subtitle && <p className="text-xs text-navy-300 mt-0.5">{subtitle}</p>}
          </div>
        )}
      </header>

      {/* ── Main content ───────────────────────────────────────────────────── */}
      <main className="flex-1 px-4 py-6 max-w-lg mx-auto w-full">
        {children}
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="text-center text-xs text-slate-400 py-4 pb-8">
        talentscan.kcabah.com · KCA Bahrain
      </footer>
      {profileOpen && <ProfileModal token={token} onClose={() => setProfileOpen(false)} />}
    </div>
  );
}

function ProfileModal({ token, onClose }) {
  const [form, setForm] = useState({ full_name: '', phone: '', whatsapp_number: '', whatsapp_number_2: '', kca_member_no: '' });
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  useEffect(() => {
    let alive = true;
    portalApi.getAccount(token)
      .then((a) => { if (!alive) return; setForm({ full_name: a.full_name || '', phone: a.phone || '', whatsapp_number: a.whatsapp_number || '', whatsapp_number_2: a.whatsapp_number_2 || '', kca_member_no: a.kca_member_no || '' }); setEmail(a.email || ''); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
    return () => { alive = false; };
  }, [token]);

  async function save() {
    setBusy(true); setErr(''); setOk('');
    try { await portalApi.updateAccount(token, form); setOk('Your details have been saved.'); setTimeout(onClose, 900); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const inp = 'w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 px-3 py-6" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-1 text-base font-semibold text-navy-900">My details</h2>
        <p className="mb-3 text-xs text-slate-500">Your contact number is used for confirmations and reminders. Please keep it up to date.</p>
        {loading ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Full name</label>
              <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} className={inp} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Email (used to sign in — cannot be changed here)</label>
              <input value={email} disabled className={`${inp} bg-slate-50 text-slate-400`} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Contact number</label>
                <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="8-digit Bahrain no." className={inp} />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">WhatsApp (with code)</label>
                <input value={form.whatsapp_number} onChange={(e) => setForm({ ...form, whatsapp_number: e.target.value })} placeholder="+973…" className={inp} />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Second WhatsApp number (optional) — e.g. the other parent</label>
              <input value={form.whatsapp_number_2} onChange={(e) => setForm({ ...form, whatsapp_number_2: e.target.value })} placeholder="+973…" className={inp} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">KCA member number (optional)</label>
              <input value={form.kca_member_no} onChange={(e) => setForm({ ...form, kca_member_no: e.target.value })} className={inp} />
            </div>
            {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
            {ok && <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{ok}</div>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600">Cancel</button>
              <button onClick={save} disabled={busy} className="rounded-lg bg-navy-700 px-4 py-2 text-sm font-medium text-white hover:bg-navy-800 disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
