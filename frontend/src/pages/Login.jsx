import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff, Lock, Sparkles, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import Button from '../components/ui/Button';

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);

  if (isAuthenticated) {
    const redirectTo = location.state?.from?.pathname || '/admin/config/year';
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setFormError(null);

    if (!username.trim() || !password) {
      setFormError('Enter both your username and password.');
      return;
    }

    setSubmitting(true);
    try {
      const data = await login(username.trim(), password);
      showToast(`Welcome back, ${data.user?.name || username}.`, 'success');
      navigate(location.state?.from?.pathname || '/admin/config/year', { replace: true });
    } catch (err) {
      setFormError(err.message || 'Invalid username or password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-navy-900 px-4 py-10">
      <div
        className="pointer-events-none absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(circle at 20% 20%, rgba(197,90,17,0.4), transparent 40%), radial-gradient(circle at 80% 80%, rgba(47,102,144,0.6), transparent 45%)',
        }}
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gold-500 shadow-lg shadow-gold-900/30">
            <Sparkles size={28} className="text-white" />
          </div>
          <h1 className="text-xl font-semibold text-white">Indian Talent Scan</h1>
          <p className="mt-1 text-sm text-navy-300">Kerala Catholic Association · Bahrain</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="animate-fade-in rounded-2xl border border-white/10 bg-white p-6 shadow-2xl"
          noValidate
        >
          <h2 className="text-base font-semibold text-navy-900">Admin sign in</h2>
          <p className="mt-1 text-sm text-slate-500">
            Use your event-management credentials to continue.
          </p>

          {formError && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}

          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-sm font-medium text-navy-800">
                Username or email
              </label>
              <div className="relative">
                <User size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  id="username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="e.g. coordinator@kcabah.com"
                  className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm text-slate-800 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-300"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-medium text-navy-800">
                Password
              </label>
              <div className="relative">
                <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-9 text-sm text-slate-800 shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-300"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <Button type="submit" variant="gold" loading={submitting} className="mt-1 w-full">
              Sign in
            </Button>
          </div>
        </form>

        <p className="mt-5 text-center text-xs text-navy-400">
          Roles: SuperAdmin · Admin · Coordinator · Chairman · Judge · Viewer
        </p>
      </div>
    </div>
  );
}
