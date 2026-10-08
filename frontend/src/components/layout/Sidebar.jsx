import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Settings, ListChecks, Users, Gavel, CalendarClock, Trophy, Wallet,
  Sparkles, ClipboardList, ChevronDown, ClipboardCheck, Megaphone, BadgeDollarSign,
  UserCog, UserCheck, Combine, Video, Award,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { yearConfigApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);

// Organiser roles (everyone EXCEPT the day-of MC/Timer roles, who use /mc, /timer).
const ORG = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'];

const NAV_ITEMS = [
  { to: '/admin/events', label: 'Events', icon: ListChecks, active: true, roles: ORG },
  { to: '/admin/registrations', label: 'Registrations', icon: Users, active: true, roles: [...ORG, 'Registrar'] },
  { to: '/admin/lists', label: 'Lists', icon: ClipboardList, active: true, roles: ORG },
  { to: '/admin/consolidation', label: 'Consolidation', icon: Combine, active: true, roles: ORG },
  { to: '/admin/schedule', label: 'Schedule', icon: CalendarClock, active: true, roles: ORG },
  { to: '/admin/judging/assignment', label: 'Event assignment', icon: UserCheck, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/event-day', label: 'Event Day', icon: ClipboardCheck, active: true, roles: ORG },
  { to: '/admin/team-event-day', label: 'Team Event Day', icon: ClipboardList, active: true, roles: ORG },
  { to: '/admin/judging/judges', label: 'Judges', icon: Gavel, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/judging/results', label: 'Results', icon: Award, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/awards', label: 'Awards', icon: Trophy, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/media', label: 'Results & posters', icon: Trophy, active: true, roles: ['Media'] },
  { to: '/admin/video', label: 'Videography', icon: Video, active: true, roles: ['Media', 'SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'] },
  { to: '/admin/notices', label: 'Notices', icon: Megaphone, active: true, roles: ['SuperAdmin', 'Admin', 'Chairman'] },
  { to: '/admin/payments', label: 'Payments', icon: BadgeDollarSign, active: true, roles: ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Accountant'] },
  { to: '/admin/finance', label: 'Finance', icon: Wallet, active: true, roles: ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer', 'Accountant'] },
  { to: '/admin/users', label: 'Users', icon: UserCog, active: true, roles: ['SuperAdmin', 'Admin'] },
  { to: '/admin/config/year', label: 'Year Setup', icon: Settings, active: true, roles: ORG },
];

function NavGroup({ item }) {
  const [open, setOpen] = useState(true);
  const Icon = item.icon;
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-navy-100 hover:bg-white/10"
      >
        <span className="flex items-center gap-3"><Icon size={17} />{item.group}</span>
        <ChevronDown size={15} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="mt-0.5 space-y-0.5 pl-5">
          {item.children.map((c) => (c.active ? (
            <NavLink
              key={c.label}
              to={c.to}
              className={({ isActive }) =>
                `block rounded-md px-3 py-1.5 text-sm transition-colors ${
                  isActive ? 'bg-gold-500 text-white' : 'text-navy-200 hover:bg-white/10'
                }`
              }
            >
              {c.label}
            </NavLink>
          ) : (
            <div
              key={c.label}
              className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-navy-400"
              title="Coming in a later build"
            >
              {c.label}
              <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wide">Soon</span>
            </div>
          )))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar() {
  const { user, token } = useAuth();
  const role = user?.role;

  // Use the uploaded ITS logo in the header when one exists; fall back to the icon.
  const [logo, setLogo] = useState(null);
  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    yearConfigApi
      .get(token)
      .then((cfg) => { if (alive) setLogo(asset(cfg?.its_logo_url)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [token]);

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col bg-navy-800 text-navy-50">
      <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
        <div
          className={`flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg ${
            logo ? 'bg-white' : 'bg-gold-500 font-bold text-white'
          }`}
        >
          {logo ? (
            <img src={logo} alt="ITS" className="h-full w-full object-contain p-0.5" />
          ) : (
            <Sparkles size={20} />
          )}
        </div>
        <div>
          <p className="text-sm font-semibold leading-tight text-white">Indian Talent Scan</p>
          <p className="text-xs text-navy-300">KCA Bahrain · Admin</p>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto scroll-thin px-3 py-4">
        {NAV_ITEMS.map((item) => {
          if (item.group) {
            if (item.roles && !item.roles.includes(role)) return null;
            return <NavGroup key={item.group} item={item} />;
          }
          if (item.roles && !item.roles.includes(role)) return null;
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

      <div className="border-t border-white/10 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 40 40" className="h-8 w-8 shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="rpLogo" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#f59e0b" />
                <stop offset="50%" stopColor="#ef4444" />
                <stop offset="100%" stopColor="#8b5cf6" />
              </linearGradient>
            </defs>
            <rect x="0" y="0" width="40" height="40" rx="9" fill="url(#rpLogo)" />
            <text x="20" y="29" textAnchor="middle" fontFamily="Georgia, 'Times New Roman', serif" fontWeight="800" fontSize="25" fill="#ffffff">R</text>
          </svg>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-white">TalentHub</p>
            <p className="text-[11px] text-navy-300">by Research Point WLL</p>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-navy-500">talentscan.kcabah.com</p>
      </div>
    </aside>
  );
}
