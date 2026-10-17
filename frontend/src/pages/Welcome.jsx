// src/pages/Welcome.jsx
// Harmless default landing after sign-in. Shows a greeting and quick links to
// only the pages the signed-in role may open — so nobody lands on Year Setup by
// mistake and changes something.
import { Link } from 'react-router-dom';
import AdminLayout from '../components/layout/AdminLayout';
import { Card } from '../components/ui/Card';
import { useAuth } from '../context/AuthContext';
import { NAV_ITEMS } from '../components/layout/Sidebar';

export default function Welcome() {
  const { user } = useAuth();
  const role = user?.role;
  const items = NAV_ITEMS.filter(
    (i) => i.active && i.to !== '/admin/welcome' && (!i.roles || i.roles.includes(role)),
  );

  return (
    <AdminLayout title={`Welcome${user?.name ? `, ${user.name}` : ''}`}
      subtitle="Pick a section to get started. You'll only see the areas you have access to.">
      <Card>
        <p className="text-sm text-slate-600">
          You're signed in as <span className="font-semibold text-navy-800">{role}</span>.
          Use the menu on the left, or one of the shortcuts below.
        </p>
      </Card>

      {items.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((i) => {
            const Icon = i.icon;
            return (
              <Link key={i.to} to={i.to}
                className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-navy-300 hover:bg-navy-50">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-navy-100 text-navy-700">
                  <Icon size={20} />
                </span>
                <span className="text-sm font-semibold text-navy-800">{i.label}</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <Card className="mt-4"><p className="py-6 text-center text-sm text-slate-400">No sections are assigned to your role yet.</p></Card>
      )}
    </AdminLayout>
  );
}
