// src/pages/register/Signup.jsx
// Parent account creation page for the registration portal.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import RegisterLayout from './RegisterLayout';

export default function Signup() {
  const { signup } = useParentAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    full_name: '', email: '', phone: '', whatsapp_number: '', kca_member_no: '',
    password: '', confirm: '',
  });
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function set(k) {
    return (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await signup({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        whatsapp_number: form.whatsapp_number.trim() || undefined,
        kca_member_no: form.kca_member_no.trim() || undefined,
        password: form.password,
      });
      navigate('/register/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Account creation failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    'w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent';

  return (
    <RegisterLayout title="Create Account">
      <form onSubmit={handleSubmit} className="space-y-4 mt-2">
        {/* Full name */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Full name <span className="text-red-500">*</span>
          </label>
          <input
            required
            value={form.full_name}
            onChange={set('full_name')}
            className={inputClass}
            placeholder="Parent / Guardian name"
          />
        </div>

        {/* Email */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Email address <span className="text-red-500">*</span>
          </label>
          <input
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={set('email')}
            className={inputClass}
            placeholder="you@example.com"
          />
        </div>

        {/* Phone (optional) */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Phone <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <input
            type="tel"
            value={form.phone}
            onChange={set('phone')}
            className={inputClass}
            placeholder="+973 3XXX XXXX"
          />
        </div>

        {/* WhatsApp */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            WhatsApp number <span className="text-red-500">*</span>
          </label>
          <input
            type="tel"
            required
            value={form.whatsapp_number}
            onChange={set('whatsapp_number')}
            className={inputClass}
            placeholder="+973 3XXX XXXX"
          />
          <p className="text-xs text-slate-400 mt-1">
            Schedule updates and confirmations are sent on WhatsApp.
          </p>
        </div>

        {/* KCA member ID */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            KCA member ID <span className="text-slate-400 font-normal">(optional)</span>
          </label>
          <input
            value={form.kca_member_no}
            onChange={set('kca_member_no')}
            className={inputClass}
            placeholder="e.g. KCA1234"
          />
          <p className="text-xs text-slate-400 mt-1">
            We verify this with KCA — active members get reduced event fees.
          </p>
        </div>

        {/* Password */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Password <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <input
              type={showPw ? 'text' : 'password'}
              required
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              className={`${inputClass} pr-12`}
              placeholder="Min. 6 characters"
            />
            <button
              type="button"
              onClick={() => setShowPw(!showPw)}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-1"
            >
              {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>

        {/* Confirm password */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Confirm password <span className="text-red-500">*</span>
          </label>
          <input
            type={showPw ? 'text' : 'password'}
            required
            autoComplete="new-password"
            value={form.confirm}
            onChange={set('confirm')}
            className={inputClass}
          />
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
          {loading ? 'Creating account…' : 'Create Account'}
        </button>

        <p className="text-center text-sm text-slate-500">
          Already have an account?{' '}
          <button
            type="button"
            onClick={() => navigate('/register/login')}
            className="text-navy-700 font-semibold hover:underline"
          >
            Sign in
          </button>
        </p>
      </form>
    </RegisterLayout>
  );
}
