// src/pages/Security.jsx
// Senior-staff security view: blocked access attempts (with who/what/when) and
// any action taken by a parent ('Viewer') account inside admin. Read-only.
import { useEffect, useState, useCallback } from 'react';
import { ShieldAlert, RefreshCw, AlertTriangle, UserX, CaseUpper, Undo2 } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../context/AuthContext';
import { securityApi, maintenanceApi } from '../api/client';
import Button from '../components/ui/Button';
import { Badge } from '../components/ui/Card';
import { EmptyState, ErrorBanner, PageLoader } from '../components/ui/States';

const fmt = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export default function Security() {
  const { token, user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setLoading(true); setErr('');
    securityApi.audit(token)
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not load security log'))
      .finally(() => setLoading(false));
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // ── Data maintenance (SuperAdmin): uppercase participant names ──────────────
  const isSuper = user?.role === 'SuperAdmin';
  const [mStatus, setMStatus] = useState(null);
  const [mMsg, setMMsg] = useState('');
  const [mErr, setMErr] = useState('');
  const [mBusy, setMBusy] = useState('');
  const [confirmUpper, setConfirmUpper] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);

  const loadMStatus = useCallback(() => {
    if (!isSuper) return;
    maintenanceApi.namesStatus(token).then(setMStatus).catch(() => setMStatus(null));
  }, [token, isSuper]);
  useEffect(() => { loadMStatus(); }, [loadMStatus]);

  async function doUppercase() {
    setMBusy('up'); setMMsg(''); setMErr('');
    try {
      const r = await maintenanceApi.uppercaseNames(token);
      setMMsg(`Done — ${r.changed} name${r.changed === 1 ? '' : 's'} converted to uppercase. Originals are backed up and can be restored.`);
      setConfirmUpper(false); loadMStatus();
    } catch (e) { setMErr(e.message || 'Could not update names.'); }
    finally { setMBusy(''); }
  }
  async function doRestore() {
    setMBusy('restore'); setMMsg(''); setMErr('');
    try {
      const r = await maintenanceApi.restoreNames(token);
      setMMsg(`Restored ${r.restored} name${r.restored === 1 ? '' : 's'} to their original spelling.`);
      setConfirmRestore(false); loadMStatus();
    } catch (e) { setMErr(e.message || 'Could not restore names.'); }
    finally { setMBusy(''); }
  }

  const s = data?.summary;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800">
              <ShieldAlert size={22} className="text-red-600" /> Security
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Blocked access attempts and any admin action by a parent account. Views are not tracked — only blocked attempts and actions.
            </p>
          </div>
          <Button variant="outline" size="sm" icon={RefreshCw} onClick={load}>Refresh</Button>
        </div>

        {loading ? <PageLoader message="Loading security log…" />
        : err ? <ErrorBanner message={err} onRetry={load} />
        : (
          <>
            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                ['Blocked attempts', s?.denied_total ?? 0, 'total'],
                ['In last 24h', s?.denied_24h ?? 0, 'recent'],
                ['Distinct accounts', s?.denied_actors ?? 0, 'who'],
                ['Admin-only acts by a parent', s?.viewer_actions_total ?? 0, 'should be 0'],
              ].map(([label, val, chip]) => (
                <div key={label} className="rounded-lg border border-slate-200 bg-white p-4">
                  <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{label}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold text-slate-900">{val}</span>
                    <Badge tone={Number(val) > 0 && (label !== 'Blocked attempts') ? 'danger' : 'slate'}>{chip}</Badge>
                  </div>
                </div>
              ))}
            </div>

            {/* Blocked attempts */}
            <section>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-2">
                <AlertTriangle size={16} className="text-amber-600" /> Blocked access attempts
              </h2>
              {(!data.denied || data.denied.length === 0) ? (
                <EmptyState title="No blocked attempts recorded" description="Nothing has been blocked. New attempts will appear here and alert SuperAdmins." />
              ) : (
                <div className="overflow-x-auto scroll-thin rounded-lg border border-slate-200">
                  <table className="w-full min-w-[820px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2.5 font-medium">When</th>
                        <th className="px-3 py-2.5 font-medium">Account</th>
                        <th className="px-3 py-2.5 font-medium">Role</th>
                        <th className="px-3 py-2.5 font-medium">Tried</th>
                        <th className="px-3 py-2.5 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.denied.map((r) => (
                        <tr key={r.id} className="hover:bg-slate-50 align-top">
                          <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{fmt(r.changed_at)}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium text-slate-800">{r.full_name || r.email || 'Unknown'}</span>
                            {r.email && <span className="block text-[11px] text-slate-400">{r.email}</span>}
                          </td>
                          <td className="px-3 py-2">
                            <Badge tone={['SuperAdmin','Admin','Coordinator','Chairman','Registrar','Accountant','Media'].includes(r.user_role) ? 'slate' : 'danger'}>
                              {r.user_role || 'anonymous'}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-xs font-mono text-slate-600">{r.method} {r.path || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{r.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            {/* Parent-account admin actions */}
            <section>
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-1">
                <UserX size={16} className="text-red-600" /> Admin-only actions by a parent account
              </h2>
              <p className="text-[11px] text-slate-400 mb-2">Normal registration activity (registering, paying, confirming) is excluded — only staff-only actions done by a parent account would appear here.</p>
              {(!data.viewer_actions || data.viewer_actions.length === 0) ? (
                <EmptyState title="None found" description="No parent ('Viewer') account performed any recorded admin action — any past misuse was view-only." />
              ) : (
                <div className="overflow-x-auto scroll-thin rounded-lg border border-red-200">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-red-50 text-left text-xs uppercase tracking-wide text-red-700">
                      <tr>
                        <th className="px-3 py-2.5 font-medium">When</th>
                        <th className="px-3 py-2.5 font-medium">Account</th>
                        <th className="px-3 py-2.5 font-medium">Action</th>
                        <th className="px-3 py-2.5 font-medium">On</th>
                        <th className="px-3 py-2.5 font-medium">Reason</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.viewer_actions.map((r) => (
                        <tr key={r.id} className="hover:bg-red-50/40 align-top">
                          <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">{fmt(r.changed_at)}</td>
                          <td className="px-3 py-2">
                            <span className="font-medium text-slate-800">{r.full_name || r.email || 'Unknown'}</span>
                            {r.email && <span className="block text-[11px] text-slate-400">{r.email}</span>}
                          </td>
                          <td className="px-3 py-2 text-xs font-mono text-slate-700">{r.action}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{r.table_name}{r.record_id ? ` #${r.record_id}` : ''}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{r.reason || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {isSuper && (
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-800">
              <CaseUpper size={18} className="text-navy-600" /> Data maintenance — participant names
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Convert every participant&rsquo;s name to UPPERCASE for the active year, for a uniform look on
              all lists, certificates and result cards. The original spellings are backed up first and can be
              restored at any time. Safe to run more than once.
            </p>
            {mStatus && (
              <p className="mt-2 text-xs text-slate-600">
                {mStatus.to_change} name{mStatus.to_change === 1 ? '' : 's'} not yet uppercase
                {mStatus.backup_exists ? ` · ${mStatus.backup_rows} original name${mStatus.backup_rows === 1 ? '' : 's'} backed up` : ''}
              </p>
            )}
            {mMsg && <p className="mt-2 rounded-md bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-700">{mMsg}</p>}
            {mErr && <p className="mt-2 rounded-md bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{mErr}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {!confirmUpper ? (
                <Button size="sm" variant="primary" icon={CaseUpper}
                  onClick={() => { setConfirmUpper(true); setConfirmRestore(false); }}
                  disabled={mStatus && mStatus.to_change === 0}>
                  Back up &amp; make names UPPERCASE
                </Button>
              ) : (
                <>
                  <span className="text-xs text-slate-600">Back up originals, then uppercase {mStatus?.to_change ?? ''} names?</span>
                  <Button size="sm" variant="primary" loading={mBusy === 'up'} onClick={doUppercase}>Yes, do it</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmUpper(false)}>Cancel</Button>
                </>
              )}

              {mStatus?.backup_exists && mStatus.backup_rows > 0 && (
                !confirmRestore ? (
                  <Button size="sm" variant="outline" icon={Undo2}
                    onClick={() => { setConfirmRestore(true); setConfirmUpper(false); }}>
                    Restore original names
                  </Button>
                ) : (
                  <>
                    <span className="text-xs text-slate-600">Restore the backed-up original spellings?</span>
                    <Button size="sm" variant="danger" loading={mBusy === 'restore'} onClick={doRestore}>Yes, restore</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRestore(false)}>Cancel</Button>
                  </>
                )
              )}
            </div>
            <p className="mt-3 text-[11px] text-slate-400">
              Tip: download Registrations &rarr; Export Excel first as an extra offline backup before running this.
            </p>
          </section>
        )}
      </div>
    </AdminLayout>
  );
}
