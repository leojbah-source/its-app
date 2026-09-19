import { useState } from 'react';
import { LogOut, KeyRound, X, Eye, EyeOff } from 'lucide-react';
import Sidebar from './Sidebar';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { authApi } from '../../api/client';
import { Badge } from '../ui/Card';
import Button from '../ui/Button';

export default function AdminLayout({ title, subtitle, actions, children }) {
  const { user, logout, token } = useAuth();
  const [pwOpen, setPwOpen] = useState(false);

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold text-navy-900">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-3">
            {actions}
            <div className="mx-1 h-8 w-px bg-slate-200" />
            <div className="text-right">
              <p className="text-sm font-medium text-slate-800">{user?.name || 'Admin User'}</p>
              <Badge tone="navy">{user?.role || 'Admin'}</Badge>
            </div>
            <button
              onClick={() => setPwOpen(true)}
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-navy-700"
              title="Change password"
            >
              <KeyRound size={16} />
              Change password
            </button>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-red-600"
              title="Sign out"
            >
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto scroll-thin px-6 py-6">{children}</main>
      </div>

      {pwOpen && <ChangePasswordModal token={token} onClose={() => setPwOpen(false)} />}
    </div>
  );
}

function ChangePasswordModal({ token, onClose }) {
  const { showToast } = useToast();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const inputCls =
    'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500';

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (next.length < 8) { setError('New password must be at least 8 characters.'); return; }
    if (next !== confirm) { setError('New password and confirmation do not match.'); return; }
    setBusy(true);
    try {
      await authApi.changePassword(token, cur, next);
      showToast('Password changed.', 'success');
      onClose();
    } catch (err) {
      setError(err.message || 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold text-navy-900">
            <KeyRound size={18} /> Change password
          </h2>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Current password</label>
            <input type={show ? 'text' : 'password'} autoComplete="current-password" required
              value={cur} onChange={(e) => setCur(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">New password</label>
            <div className="relative">
              <input type={show ? 'text' : 'password'} autoComplete="new-password" required
                value={next} onChange={(e) => setNext(e.target.value)} className={`${inputCls} pr-11`} />
              <button type="button" onClick={() => setShow((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-400">At least 8 characters.</p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Confirm new password</label>
            <input type={show ? 'text' : 'password'} autoComplete="new-password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} />
          </div>
          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>Update password</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
