// src/pages/register/Landing.jsx
// Public landing page at /register.
// Redirects to dashboard if already authenticated.

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogIn, UserPlus, CalendarDays, Sparkles, FileText } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import { portalApi, API_BASE } from './registerApi';
import BrandMark from '../../components/ui/BrandMark';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);

function StatusPill({ label, st }) {
  if (!st) return null;
  const tone = !st.open
    ? 'bg-red-500/20 text-red-200 border-red-500/30'
    : st.days !== null && st.days <= 3
      ? 'bg-yellow-500/20 text-yellow-200 border-yellow-500/30'
      : 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30';
  const text = !st.open
    ? 'closed'
    : st.days === null
      ? 'open'
      : `closes in ${st.days} day${st.days !== 1 ? 's' : ''}`;
  return (
    <div className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium ${tone}`}>
      <CalendarDays size={16} />
      <span><b>{label}:</b> {text}</span>
    </div>
  );
}

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

  // Individual and team registration have SEPARATE deadlines — show each on its
  // own so parents aren't told "closed" when only one of them has closed.
  const statusFor = (d) => {
    if (!d) return { open: true, days: null };          // no deadline set = open
    const days = Math.ceil((new Date(d) - new Date()) / (1000 * 60 * 60 * 24));
    return { open: days > 0, days };
  };
  const indiv = config ? statusFor(config.reg_deadline) : null;
  const team = config ? statusFor(config.team_reg_deadline) : null;

  const kcaLogo = asset(config?.kca_logo_url);
  const sponsorLogo = asset(config?.sponsor_logo_url);

  return (
    <div className="min-h-screen bg-gradient-to-br from-navy-800 via-navy-900 to-slate-900 flex flex-col text-white">
      {/* Top brand band — KCA + title sponsor */}
      {(kcaLogo || sponsorLogo) && (
        <header className="flex items-center justify-center gap-4 px-6 pt-6 pb-3 sm:gap-6">
          {kcaLogo && (
            <div className="flex items-center justify-center rounded-lg bg-white p-1.5 shadow-md">
              <img src={kcaLogo} alt="Kerala Catholic Association Bahrain" className="h-10 w-auto object-contain sm:h-12" />
            </div>
          )}
          {kcaLogo && sponsorLogo && <span className="h-8 w-px bg-white/20" aria-hidden="true" />}
          {sponsorLogo && (
            <div className="flex items-center justify-center rounded-lg bg-white p-1.5 shadow-md">
              <img src={sponsorLogo} alt={config?.sponsor_name || 'Title sponsor'} className="h-10 w-auto object-contain sm:h-12" />
            </div>
          )}
        </header>
      )}

      <main className="flex flex-1 flex-col items-center justify-center px-6 pb-12 pt-4">
      {/* Logo block */}
      <div className="flex flex-col items-center gap-4 mb-10">
        <BrandMark className="h-20 w-20 rounded-3xl shadow-2xl" imgClassName="p-1.5" fallback={Sparkles} fallbackSize={40} />
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Indian Talent Scan</h1>
          <p className="text-navy-300 text-base mt-1.5">KCA Bahrain · Participant Registration</p>
        </div>
      </div>

      {/* Registration status — individual and team shown separately */}
      {config && (
        <div className="mb-8 flex flex-col items-center gap-2">
          <StatusPill label="Individual entries" st={indiv} />
          <StatusPill label="Team entries" st={team} />
          {indiv && !indiv.open && team && team.open && (
            <p className="mt-1 max-w-xs text-center text-xs text-emerald-200/90">
              Individual registration has closed, but <b>team registration is still open</b> — sign in or create an account to register a team.
            </p>
          )}
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

      {/* Rules & Regulations — read before registering */}
      {asset(config?.rules_pdf_url) && (
        <a
          href={asset(config.rules_pdf_url)}
          target="_blank"
          rel="noreferrer"
          className="mt-8 inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-sm font-medium text-white hover:bg-white/15 active:bg-white/20 transition-all"
        >
          <FileText size={16} />
          Read the Rules &amp; Regulations
        </a>
      )}

      <p className="mt-10 text-xs text-navy-400 text-center max-w-xs leading-relaxed">
        Create an account to register your child for events in the Indian Talent Scan competition hosted by KCA Bahrain.
        Please read the Rules &amp; Regulations before you begin.
      </p>
    </main>
    </div>
  );
}
