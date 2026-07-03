// src/pages/register/Landing.jsx
// Public landing page at /register.
// Redirects to dashboard if already authenticated.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, UserPlus, CalendarDays } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import { portalApi } from './registerApi';

export default function Landing() {
  const { isAuthenticated } = useParentAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);

  useEffect(() => {
    if (isAuthenticated) navigate('/register/dashboard', { replace: true });
  }, [isAuthenticated, navigate]);

  useEffect(() => {
    portalApi.config().then(setConfig).catch(() => null);
  }, []);

  const deadline = config?.reg_deadline ? new Date(config.reg_deadline) : null;
  const now = new Date();
  const daysLeft = deadline ? Math.ceil((deadline - now) / (1000 * 60 * 60 * 24)) : null;
  const isOpen = daysLeft === null || daysLeft > 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-navy-800 via-navy-900 to-slate-900 flex flex-col items-center justify-center px-6 py-12 text-white">
      {/* Logo block */}
      <div className="flex flex-col items-center gap-4 mb-10">
        <div className="flex h-20 w-20 items-center justify-center rounded-3xl bg-gold-500 shadow-2xl text-4xl">
          🎭
        </div>
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Indian Talent Scan</h1>
          <p className="text-navy-300 text-base mt-1.5">KCA Bahrain · Participant Registration</p>
        </div>
      </div>

      {/* Registration status pill */}
      {daysLeft !== null && (
        <div className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium mb-8 border ${
          !isOpen
            ? 'bg-red-500/20 text-red-200 border-red-500/30'
            : daysLeft <= 3
              ? 'bg-yellow-500/20 text-yellow-200 border-yellow-500/30'
              : 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30'
        }`}>
          <CalendarDays size={16} />
          {!isOpen
            ? `Registration closed`
            : `Registration closes in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`}
        </div>
      )}

      {/* Action cards */}
      <div className="w-full max-w-sm space-y-4">
        <button
          onClick={() => navigate('/register/login')}
          className="w-full flex items-center gap-4 rounded-2xl bg-white/10 hover:bg-white/15 active:bg-white/20 border border-white/20 p-5 text-left transition-all"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gold-500/80 shrink-0">
            <LogIn size={24} />
          </div>
          <div>
            <p className="font-semibold text-lg leading-tight">Sign In</p>
            <p className="text-sm text-navy-300 mt-0.5">I already have an account</p>
          </div>
        </button>

        <button
          onClick={() => navigate('/register/signup')}
          className="w-full flex items-center gap-4 rounded-2xl bg-white/10 hover:bg-white/15 active:bg-white/20 border border-white/20 p-5 text-left transition-all"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/80 shrink-0">
            <UserPlus size={24} />
          </div>
          <div>
            <p className="font-semibold text-lg leading-tight">Create Account</p>
            <p className="text-sm text-navy-300 mt-0.5">Register as parent / guardian</p>
          </div>
        </button>
      </div>

      <p className="mt-10 text-xs text-navy-400 text-center max-w-xs leading-relaxed">
        Create an account to register your child for events in the Indian Talent Scan competition hosted by KCA Bahrain.
      </p>
    </div>
  );
}
