// src/pages/register/ForgotPassword.jsx
// Parent requests a password-reset link by email. The response is always the
// same generic confirmation, so the page never reveals whether an email has
// an account.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { portalApi } from './registerApi';
import RegisterLayout from './RegisterLayout';

export default function ForgotPassword() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await portalApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(err.message || 'Could not send the reset email. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <RegisterLayout title="Check your email">
        <div className="mt-2 space-y-5">
          <div className="flex items-start gap-3 rounded-xl bg-green-50 border border-green-200 px-4 py-4">
            <MailCheck size={22} className="mt-0.5 shrink-0 text-green-600" />
            <div className="text-sm text-slate-700">
              If an account exists for <span className="font-semibold">{email.trim()}</span>, a
              password reset link has been sent. Please check your inbox — and your spam
              or junk folder, just in case.
              <div className="mt-2 text-slate-500">The link is valid for 1 hour.</div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/register/login')}
            className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 transition-colors"
          >
            Back to Sign In
          </button>
          <p className="text-center text-sm text-slate-500">
            Didn't get it?{' '}
            <button
              type="button"
              onClick={() => setSent(false)}
              className="text-navy-700 font-semibold hover:underline"
            >
              Try again
            </button>
          </p>
        </div>
      </RegisterLayout>
    );
  }

  return (
    <RegisterLayout title="Forgot password">
      <form onSubmit={handleSubmit} className="space-y-5 mt-2">
        <p className="text-sm text-slate-600">
          Enter the email address you used to register. We'll send you a link to set a
          new password.
        </p>

        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">
            Email address
          </label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent"
            placeholder="parent@example.com"
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
          {loading ? 'Sending…' : 'Send reset link'}
        </button>

        <p className="text-center text-sm text-slate-500">
          Remembered it?{' '}
          <button
            type="button"
            onClick={() => navigate('/register/login')}
            className="text-navy-700 font-semibold hover:underline"
          >
            Back to Sign In
          </button>
        </p>
      </form>
    </RegisterLayout>
  );
}
