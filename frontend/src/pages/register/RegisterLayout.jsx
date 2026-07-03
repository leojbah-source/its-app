// src/pages/register/RegisterLayout.jsx
// Mobile-first layout wrapper for the parent registration portal.
// No admin sidebar. Sticky navy header with ITS branding + optional back button.

import { useNavigate } from 'react-router-dom';
import { Sparkles, LogOut, ChevronLeft } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';

export default function RegisterLayout({
  children,
  title,
  subtitle,
  showBack = false,
  backTo = '/register/dashboard',
}) {
  const { isAuthenticated, user, logout } = useParentAuth();
  const navigate = useNavigate();

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
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gold-500 shrink-0">
                <Sparkles size={15} className="text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight truncate">Indian Talent Scan</p>
                <p className="text-[10px] text-navy-300 leading-tight">KCA Bahrain</p>
              </div>
            </div>
          </div>

          {/* Right: user name + logout */}
          {isAuthenticated && (
            <div className="flex items-center gap-2 shrink-0 ml-2">
              <span className="text-xs text-navy-200 hidden sm:block truncate max-w-[130px]">
                {user?.full_name?.split(' ')[0] || user?.email}
              </span>
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
    </div>
  );
}
