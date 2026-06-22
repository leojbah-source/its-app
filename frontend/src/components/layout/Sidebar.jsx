import { NavLink } from 'react-router-dom';
import {
  Settings,
  ListChecks,
  Users,
  Gavel,
  CalendarClock,
  Trophy,
  Wallet,
  Sparkles,
} from 'lucide-react';

const NAV_ITEMS = [
  { to: '/admin/config/year', label: 'Year Setup', icon: Settings, active: true },
  { to: '/admin/events', label: 'Events', icon: ListChecks, active: true },
  { label: 'Registrations', icon: Users, active: false },
  { label: 'Judges', icon: Gavel, active: false },
  { label: 'Schedule', icon: CalendarClock, active: false },
  { label: 'Awards', icon: Trophy, active: false, badge: 'Chairman' },
  { label: 'Finance', icon: Wallet, active: false },
];

export default function Sidebar() {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-navy-800 text-navy-50">
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gold-500 font-bold text-white">
          <Sparkles size={20} />
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-white">Indian Talent Scan</p>
          <p className="text-xs text-navy-300">KCA Bahrain · Admin</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto scroll-thin px-3 py-4">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          if (!item.active) {
            return (
              <div
                key={item.label}
                className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-navy-400"
                title="Coming in a later build"
              >
                <span className="flex items-center gap-3">
                  <Icon size={17} />
                  {item.label}
                </span>
                <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide text-navy-400">
                  {item.badge ? item.badge : 'Soon'}
                </span>
              </div>
            );
          }
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? 'bg-gold-500 text-white shadow-sm' : 'text-navy-100 hover:bg-white/10'
                }`
              }
            >
              <Icon size={17} />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-white/10 px-5 py-4 text-xs text-navy-400">
        talentscan.kcabah.com
      </div>
    </aside>
  );
}
