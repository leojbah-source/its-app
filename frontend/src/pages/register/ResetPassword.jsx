// src/pages/register/ResetPassword.jsx
// Parent sets a new password using the single-use token from the reset email
// (?token=... in the link). On success they are sent back to Sign In.

import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import { portalApi } from './registerApi';
import RegisterLayout from './RegisterLayout';

export default function ResetPassword() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') || '';

  const [form, setForm] = useState({ password: '', confirm: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setLoading(true);
    try {
      await portalApi.resetPassword(token, form.password);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not reset your password. Please request a new link.');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <RegisterLayout title="Reset password">
        <div className="mt-2 space-y-5">
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            This reset link is incomplete or invalid. Please request a new one.
          </div>
          <button
            type="button"
            onClick={() => navigate('/register/forgot')}
            className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 transition-colors"
          >
            Request a new link
          </button>
        </div>
      </RegisterLayout>
    );
  }

  if (done) {
    return (
      <RegisterLayout title="Password updated">
        <div className="mt-2 space-y-5">
          <div className="flex items-start gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-4">
            <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-green-600" />
            <div className="text-sm text-slate-700">
              Your password has been updated. You can now sign in with your new password.
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/register/login')}
            className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 transition-colors"
          >
            Go to Sign In
          </button>
        </div>
      </RegisterLayout>
    );
  }

  return (
    <RegisterLayout title="Set a new password">
      <form onSubmit={handleSubmit} className="space-y-5 mt-2">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            New password
          </label>
          <div className="relative">
            <input
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-4 py-3.5 pr-12 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent"
              placeholder="At least 6 characters"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1"
              aria-label={showPw ? 'Hide password' : 'Show password'}
            >
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Confirm new password
          </label>
          <input
            type={showPw ? 'text' : 'password'}
            required
            autoComplete="new-password"
            value={form.confirm}
            onChange={(e) => setForm({ ...form, confirm: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent"
            placeholder="Re-enter your new password"
          />
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 disabled:opacity-60 transition-colors"
        >
          {loading ? 'Updating…' : 'Update password'}
        </button>
      </form>
    </RegisterLayout>
  );
}
