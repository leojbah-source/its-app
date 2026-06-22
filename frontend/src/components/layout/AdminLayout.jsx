import { LogOut } from 'lucide-react';
import Sidebar from './Sidebar';
import { useAuth } from '../../context/AuthContext';
import { Badge } from '../ui/Card';

export default function AdminLayout({ title, subtitle, actions, children }) {
  const { user, logout } = useAuth();

  return (
    <div className="flex h-screen bg-slate-50">
      <Sidebar />
      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
          <div>
            <h1 className="text-xl font-semibold text-navy-900">{title}</h1>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-3">
            {actions}
            <div className="mx-1 h-8 w-px bg-slate-200" />
            <div className="text-right">
              <p className="text-sm font-medium text-slate-800">{user?.name || 'Admin User'}</p>
              <Badge tone="navy">{user?.role || 'Admin'}</Badge>
            </div>
            <button
              onClick={logout}
              className="flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-slate-500 hover:bg-slate-100 hover:text-red-600"
              title="Sign out"
            >
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        </header>
        <main className="flex-1 overflow-y-auto scroll-thin px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
