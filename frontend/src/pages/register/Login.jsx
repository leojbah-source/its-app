// src/pages/register/Login.jsx
// Parent login page for the registration portal.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import RegisterLayout from './RegisterLayout';

export default function Login() {
  const { login } = useParentAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await login(form.email.trim(), form.password);
      navigate('/register/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Sign in failed. Please check your email and password.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <RegisterLayout title="Sign In">
      <form onSubmit={handleSubmit} className="space-y-5 mt-2">
        {/* Email */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Email address
          </label>
          <input
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            className="w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent"
            placeholder="parent@example.com"
          />
        </div>

        {/* Password */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Password
          </label>
          <div className="relative">
            <input
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="current-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="w-full rounded-xl border border-slate-300 px-4 py-3.5 pr-12 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent"
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

        {/* Error */}
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 disabled:opacity-60 transition-colors mt-2"
        >
          {loading ? 'Signing in…' : 'Sign In'}
        </button>

        {/* Switch to signup */}
        <p className="text-center text-sm text-slate-500">
          No account?{' '}
          <button
            type="button"
            onClick={() => navigate('/register/signup')}
            className="text-navy-700 font-semibold hover:underline"
          >
            Create one
          </button>
        </p>
      </form>
    </RegisterLayout>
  );
}
