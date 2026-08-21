import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Settings, ListChecks, Users, Gavel, CalendarClock, Trophy, Wallet,
  Sparkles, ClipboardList, ChevronDown, ClipboardCheck, Megaphone,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

const NAV_ITEMS = [
  { to: '/admin/config/year', label: 'Year Setup', icon: Settings, active: true },
  { to: '/admin/events', label: 'Events', icon: ListChecks, active: true },
  { to: '/admin/registrations', label: 'Registrations', icon: Users, active: true },
  { to: '/admin/lists', label: 'Lists', icon: ClipboardList, active: true },
  { to: '/admin/schedule', label: 'Schedule', icon: CalendarClock, active: true },
  { to: '/admin/event-day', label: 'Event Day', icon: ClipboardCheck, active: true },
  {
    group: 'Judging', icon: Gavel, roles: ['SuperAdmin', 'Chairman'],
    children: [
      { to: '/admin/judging/judges', label: 'Judges', active: true },
      { to: '/admin/judging/assignment', label: 'Event assignment', active: true },
      { to: '/admin/judging/results', label: 'Results', active: true },
    ],
  },
  { to: '/admin/awards', label: 'Awards', icon: Trophy, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/notices', label: 'Notices', icon: Megaphone, active: true, roles: ['SuperAdmin', 'Admin', 'Chairman'] },
  { to: '/admin/finance', label: 'Finance', icon: Wallet, active: true, roles: ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'] },
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
  const { user } = useAuth();
  const role = user?.role;

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

      <div className="border-t border-white/10 px-5 py-4 text-xs text-navy-400">
        talentscan.kcabah.com
      </div>
    </aside>
  );
}
