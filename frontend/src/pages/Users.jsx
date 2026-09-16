// src/pages/Users.jsx
// Staff account management (SuperAdmin / Admin only): create office/finance
// users who check registrations and confirm payments, change their role,
// activate/deactivate, and reset passwords.
import { useCallback, useEffect, useState } from 'react';
import { UserPlus, KeyRound, Check, X } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import { Input } from '../components/ui/FormField';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { usersApi } from '../api/client';

const ROLE_NOTE = {
  Admin: 'Full access to every screen.',
  Coordinator: 'View registrations, confirm payments, edit entries.',
  Chairman: 'View registrations and confirm payments.',
};

const selectCls =
  'rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500';

export default function Users() {
  const { token, user } = useAuth();
  const { showToast } = useToast();
  const isSuper = user?.role === 'SuperAdmin';
  // Admin can assign Coordinator/Chairman; only SuperAdmin can assign Admin.
  const assignableRoles = isSuper ? ['Admin', 'Coordinator', 'Chairman'] : ['Coordinator', 'Chairman'];

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [resetFor, setResetFor] = useState(null); // user id whose password is being reset
  const [resetPw, setResetPw] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', password: '', role: 'Coordinator' });
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      setRows(await usersApi.list(token));
    } catch (err) {
      setError(err.message || 'Could not load users.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Can the current user edit this target account?
  const canManage = (target) => {
    if (target.id === user?.id) return false;                       // not yourself
    if (!isSuper && (target.role === 'Admin' || target.role === 'SuperAdmin')) return false;
    return true;
  };

  async function handleAdd(e) {
    e.preventDefault();
    setAdding(true);
    try {
      await usersApi.create(token, {
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        password: form.password,
        role: form.role,
      });
      showToast(`${form.full_name.trim()} added as ${form.role}.`, 'success');
      setForm({ full_name: '', email: '', phone: '', password: '', role: 'Coordinator' });
      setShowAdd(false);
      load();
    } catch (err) {
      showToast(err.message || 'Could not create the user.', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function patch(id, body, okMsg) {
    setBusyId(id);
    try {
      await usersApi.update(token, id, body);
      if (okMsg) showToast(okMsg, 'success');
      await load();
    } catch (err) {
      showToast(err.message || 'Update failed.', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReset(id) {
    if (resetPw.length < 8) { showToast('Password must be at least 8 characters.', 'error'); return; }
    await patch(id, { password: resetPw }, 'Password reset.');
    setResetFor(null); setResetPw('');
  }

  return (
    <AdminLayout
      title="Users"
      subtitle="Staff accounts for checking registrations and confirming payments."
      actions={
        <Button variant="primary" icon={UserPlus} onClick={() => setShowAdd((s) => !s)}>
          {showAdd ? 'Close' : 'Add user'}
        </Button>
      }
    >
      <div className="mx-auto flex max-w-4xl flex-col gap-5">
        {showAdd && (
          <Card title="Add a staff user">
            <form onSubmit={handleAdd} className="grid gap-4 sm:grid-cols-2">
              <Input label="Full name" required value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
              <Input label="Email" type="email" required value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })} />
              <Input label="Phone (optional)" value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              <div>
                <label className="mb-1 block text-sm font-medium text-slate-700">Role</label>
                <select className={`${selectCls} w-full`} value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  {assignableRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <p className="mt-1 text-xs text-slate-400">{ROLE_NOTE[form.role]}</p>
              </div>
              <Input label="Temporary password" type="text" required value={form.password}
                hint="At least 8 characters — the user can change it later."
                onChange={(e) => setForm({ ...form, password: e.target.value })} />
              <div className="flex items-end">
                <Button type="submit" variant="primary" loading={adding}>Create user</Button>
              </div>
            </form>
          </Card>
        )}

        {loading ? (
          <PageLoader label="Loading users…" />
        ) : error ? (
          <ErrorBanner message={error} onRetry={load} />
        ) : (
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-3 py-2 font-medium">Name</th>
                    <th className="px-3 py-2 font-medium">Email</th>
                    <th className="px-3 py-2 font-medium">Role</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => {
                    const editable = canManage(u);
                    const roleOptions = Array.from(new Set([...assignableRoles, u.role]));
                    const self = u.id === user?.id;
                    return (
                      <tr key={u.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-3 py-2.5 font-medium text-slate-800">
                          {u.full_name}{self && <span className="ml-1.5 text-xs text-slate-400">(you)</span>}
                        </td>
                        <td className="px-3 py-2.5 text-slate-600">{u.email}</td>
                        <td className="px-3 py-2.5">
                          {u.role === 'SuperAdmin' || !editable ? (
                            <Badge tone={u.role === 'SuperAdmin' ? 'gold' : 'navy'}>{u.role}</Badge>
                          ) : (
                            <select
                              className={selectCls}
                              value={u.role}
                              disabled={busyId === u.id}
                              onChange={(e) => patch(u.id, { role: e.target.value }, `Role changed to ${e.target.value}.`)}
                            >
                              {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
                            </select>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={u.is_active ? 'success' : 'slate'}>
                            {u.is_active ? 'Active' : 'Inactive'}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5">
                          {editable ? (
                            <div className="flex items-center justify-end gap-2">
                              {resetFor === u.id ? (
                                <span className="flex items-center gap-1">
                                  <input
                                    type="text"
                                    autoFocus
                                    value={resetPw}
                                    placeholder="New password"
                                    onChange={(e) => setResetPw(e.target.value)}
                                    className="w-36 rounded-md border border-slate-300 px-2 py-1 text-sm"
                                  />
                                  <button title="Save" onClick={() => handleReset(u.id)}
                                    className="rounded-md bg-emerald-600 p-1.5 text-white hover:bg-emerald-700">
                                    <Check size={14} />
                                  </button>
                                  <button title="Cancel" onClick={() => { setResetFor(null); setResetPw(''); }}
                                    className="rounded-md border border-slate-300 p-1.5 text-slate-500 hover:bg-slate-50">
                                    <X size={14} />
                                  </button>
                                </span>
                              ) : (
                                <>
                                  <button
                                    onClick={() => { setResetFor(u.id); setResetPw(''); }}
                                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                                  >
                                    <KeyRound size={13} /> Reset password
                                  </button>
                                  <button
                                    disabled={busyId === u.id}
                                    onClick={() => patch(u.id, { is_active: !u.is_active },
                                      u.is_active ? 'User deactivated.' : 'User activated.')}
                                    className={`rounded-md px-2 py-1 text-xs font-medium ${
                                      u.is_active
                                        ? 'border border-red-200 text-red-600 hover:bg-red-50'
                                        : 'border border-emerald-200 text-emerald-700 hover:bg-emerald-50'}`}
                                  >
                                    {u.is_active ? 'Deactivate' : 'Activate'}
                                  </button>
                                </>
                              )}
                            </div>
                          ) : (
                            <span className="block text-right text-xs text-slate-300">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && (
                    <tr><td colSpan={5} className="px-3 py-10 text-center text-sm text-slate-400">
                      No staff users yet. Click “Add user” to create one.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <p className="text-xs text-slate-400">
          Parents, judges, MC and Timer accounts are managed elsewhere and are not shown here.
        </p>
      </div>
    </AdminLayout>
  );
}
