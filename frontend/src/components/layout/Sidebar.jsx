import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  Settings, ListChecks, Users, Gavel, CalendarClock, Trophy, Wallet,
  Sparkles, ClipboardList, ChevronDown, ClipboardCheck, Megaphone, BadgeDollarSign,
  UserCog, UserCheck, Combine, Video, Award, ShieldAlert, Home, Radio,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import rpLogo from '../../assets/research-point-logo.png';
import { publicApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);

// Organiser roles. NOTE: 'Admin' is intentionally NOT in ORG — the Admin role is
// scoped to a small, safe set of pages (Registrations, Event assignment, Event Day,
// Team Event Day, Videography, Users) and is added explicitly where allowed below.
const ORG = ['SuperAdmin', 'Coordinator', 'Chairman', 'Viewer'];
// Every role that uses the admin area (and so the Home / Welcome page).
export const ADMIN_AREA_ROLES = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Registrar', 'Accountant', 'Media', 'EventStaff', 'Viewer'];

export const NAV_ITEMS = [
  { to: '/admin/welcome', label: 'Home', icon: Home, active: true, roles: ADMIN_AREA_ROLES },
  { to: '/admin/events', label: 'Events', icon: ListChecks, active: true, roles: ORG },
  { to: '/admin/registrations', label: 'Registrations', icon: Users, active: true, roles: [...ORG, 'Admin', 'Registrar'] },
  { to: '/admin/lists', label: 'Lists', icon: ClipboardList, active: true, roles: ORG },
  { to: '/admin/consolidation', label: 'Consolidation', icon: Combine, active: true, roles: ORG },
  { to: '/admin/schedule', label: 'Schedule', icon: CalendarClock, active: true, roles: [...ORG, 'EventStaff'] },
  { to: '/admin/judging/assignment', label: 'Event assignment', icon: UserCheck, active: true, roles: ['SuperAdmin', 'Admin', 'Chairman'] },
  { to: '/admin/event-day', label: 'Event Day', icon: ClipboardCheck, active: true, roles: [...ORG, 'Admin', 'EventStaff'] },
  { to: '/admin/team-event-day', label: 'Team Event Day', icon: ClipboardList, active: true, roles: [...ORG, 'Admin', 'EventStaff'] },
  { to: '/admin/live', label: 'Live progress', icon: Radio, active: true, roles: ADMIN_AREA_ROLES },
  { to: '/admin/judging/judges', label: 'Judges', icon: Gavel, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/judging/results', label: 'Results', icon: Award, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/awards', label: 'Awards', icon: Trophy, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/media', label: 'Results & posters', icon: Trophy, active: true, roles: ['Media'] },
  { to: '/admin/video', label: 'Videography', icon: Video, active: true, roles: ['Media', 'SuperAdmin', 'Admin', 'Coordinator', 'Chairman', 'Viewer'] },
  { to: '/admin/notices', label: 'Notices', icon: Megaphone, active: true, roles: ['SuperAdmin', 'Chairman'] },
  { to: '/admin/payments', label: 'Payments', icon: BadgeDollarSign, active: true, roles: ['SuperAdmin', 'Coordinator', 'Chairman', 'Accountant'] },
  { to: '/admin/finance', label: 'Finance', icon: Wallet, active: true, roles: ['SuperAdmin', 'Coordinator', 'Chairman', 'Viewer', 'Accountant'] },
  { to: '/admin/users', label: 'Users', icon: UserCog, active: true, roles: ['SuperAdmin', 'Admin'] },
  { to: '/admin/security', label: 'Security', icon: ShieldAlert, active: true, roles: ['SuperAdmin', 'Chairman'] },
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
    // The ITS logo is public branding — use the public endpoint so EVERY admin
    // role (EventStaff / Media / Viewer included) can load it. The privileged
    // /config/active endpoint would 403 for those roles and fire a security
    // alert, even though the sidebar only needs the logo.
    let alive = true;
    publicApi
      .year()
      .then((cfg) => { if (alive) setLogo(asset(cfg?.its_logo_url)); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

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
        <p className="text-sm font-semibold text-white">TalentHub</p>
        <div className="mt-2 inline-block rounded bg-white p-px">
          <img src={rpLogo} alt="Research Point WLL" className="block h-auto w-28" />
        </div>
        <p className="mt-2 text-[10px] text-navy-500">talentscan.kcabah.com</p>
      </div>
    </aside>
  );
}
