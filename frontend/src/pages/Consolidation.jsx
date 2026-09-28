// src/pages/Consolidation.jsx
// Post-registration consolidation of the entry lists, one action at a time.
// Counting unit is one event × one age-group of completed registrations.
//   • UNDER (< min): merge a Boys/Girls pair into a "(Common)" event, or cancel.
//   • OVER  (> split, stage): split into two events (by gender, or A/B by age).
// Every action moves the affected registrations, records itself, notifies the
// parents (WhatsApp + email) and can be reverted from the history below.

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { RefreshCw, Combine, Scissors, Ban, Undo2, CheckCircle2, TriangleAlert } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { consolidationApi } from '../api/client';

const canAct = (role) => ['SuperAdmin', 'Admin', 'Chairman'].includes(role);
const canSplit = (role) => ['SuperAdmin', 'Chairman'].includes(role);
const fmt = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const genderLabel = { boys: 'Boys', girls: 'Girls', common: 'Common', none: '—' };

export default function Consolidation() {
  const { token, user } = useAuth();
  const role = user?.role;
  const [data, setData] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState(null); // { type:'merge'|'cancel'|'split', cell, ... }
  const [ageFilter, setAgeFilter] = useState('all');
  const historyRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [rev, hist] = await Promise.all([consolidationApi.review(token), consolidationApi.history(token)]);
      setData(rev); setHistory(hist);
    } catch (e) { setError(e.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const flashOk = (m) => { setFlash(m); setTimeout(() => setFlash(''), 8000); };
  const jumpToHistory = () => setTimeout(() => historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);

  async function doMerge(cell, notify = true) {
    setBusy(true);
    try {
      const boys = cell.gender_split === 'boys' ? cell : cell.partner;
      const girls = cell.gender_split === 'girls' ? cell : cell.partner;
      const r = await consolidationApi.merge(token, {
        age_group_id: cell.age_group_id,
        boys_event_id: (cell.gender_split === 'boys' ? cell.event_id : cell.partner.event_id),
        girls_event_id: (cell.gender_split === 'girls' ? cell.event_id : cell.partner.event_id),
        notify,
      });
      void boys; void girls;
      flashOk(`Merged into ${r.common_event.event_name} — ${r.moved} entr${r.moved === 1 ? 'y' : 'ies'} moved${notify ? ', parents notified' : ' (no notifications sent)'}. You can undo this from Recent actions below.`);
      setModal(null); await load(); jumpToHistory();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function doCancel(cell, reason, notify = true) {
    setBusy(true);
    try {
      const r = await consolidationApi.cancel(token, { event_id: cell.event_id, age_group_id: cell.age_group_id, reason, notify });
      flashOk(`Cancelled — ${r.affected} entr${r.affected === 1 ? 'y' : 'ies'} affected${notify ? ', parent(s) notified to change or request a refund' : ' (no notifications sent)'}. Undo from Recent actions below.`);
      setModal(null); await load(); jumpToHistory();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function doSplit(cell, mode, notify = true) {
    setBusy(true);
    try {
      const r = await consolidationApi.split(token, { event_id: cell.event_id, age_group_id: cell.age_group_id, mode, notify });
      flashOk(`Split into ${r.events.map((x) => `${x.event_name} (${x.count})`).join(' + ')}${notify ? ' — parents notified' : ' (no notifications sent)'}. Undo from Recent actions below.`);
      setModal(null); await load(); jumpToHistory();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function doRevert(id) {
    if (!window.confirm('Revert this action? Registrations move back to their original event(s). Parents are NOT auto-notified of the revert.')) return;
    setBusy(true);
    try {
      const r = await consolidationApi.revert(token, id);
      flashOk(`Reverted — ${r.restored} registration(s) moved back.`);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function publishFinal() {
    if (!window.confirm('Publish the Final list? This stamps the final event & participant lists as published.')) return;
    setBusy(true);
    try { await consolidationApi.publishFinal(token); flashOk('Final list published.'); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (loading) return <AdminLayout><PageLoader label="Loading consolidation…" /></AdminLayout>;

  const cells = data?.cells || [];
  const attention = cells.filter((c) => c.status !== 'ok');
  const base = showAll ? cells : attention;
  const shown = ageFilter === 'all' ? base : base.filter((c) => String(c.age_group_id) === ageFilter);
  const ageGroups = [];
  const seen = new Set();
  for (const c of [...cells].sort((a, b) => (a.ag_sort ?? 99) - (b.ag_sort ?? 99))) {
    if (c.age_group_id != null && !seen.has(c.age_group_id)) { seen.add(c.age_group_id); ageGroups.push({ id: c.age_group_id, code: c.age_group_code }); }
  }
  const counts = {
    under: cells.filter((c) => c.status === 'under').length,
    over: cells.filter((c) => c.status === 'over').length,
    cancelled: cells.filter((c) => c.status === 'cancelled').length,
  };
  const th = data?.thresholds || { min: 5, split: 25 };

  return (
    <AdminLayout>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-navy-800">List Consolidation</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-500">
            Runs after the Initial list is published. Each event × age-group is checked against the
            thresholds: merge or cancel cells under <b>{th.min}</b>, split stage cells over <b>{th.split}</b>.
            Do one action at a time — every action is recorded below and can be reverted.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" icon={RefreshCw} onClick={load} disabled={busy}>Refresh</Button>
          {['SuperAdmin', 'Admin'].includes(role) && (
            <Button variant="gold" size="sm" onClick={publishFinal} disabled={busy}>Publish Final list</Button>
          )}
        </div>
      </div>

      {!data?.initial_published && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          The Initial list has not been published yet. Consolidation is normally done after publishing it, so registrations have settled.
        </div>
      )}
      {data?.final_published && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 size={16} /> Final list published {fmt(data.final_published_at)}.
        </div>
      )}
      {flash && <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">{flash}</div>}
      {error && <div className="mb-4"><ErrorBanner message={error} onRetry={() => setError('')} /></div>}

      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label={`Under ${th.min}`} value={counts.under} tone="amber" />
        <Stat label={`Over ${th.split}`} value={counts.over} tone="violet" />
        <Stat label="Cancelled" value={counts.cancelled} tone="red" />
      </div>

      <Card
        title="Cells needing attention"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-slate-400">Age:</span>
              <button onClick={() => setAgeFilter('all')}
                className={`rounded-md px-2 py-1 text-xs font-medium ${ageFilter === 'all' ? 'bg-navy-600 text-white' : 'bg-slate-100 text-slate-600'}`}>All</button>
              {ageGroups.map((g) => (
                <button key={g.id} onClick={() => setAgeFilter(String(g.id))}
                  className={`rounded-md px-2 py-1 text-xs font-medium ${ageFilter === String(g.id) ? 'bg-navy-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{g.code}</button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-500">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show all cells
            </label>
          </div>
        }
      >
        {shown.length === 0 ? (
          <div className="py-10 text-center text-sm text-slate-400">
            {attention.length === 0 ? 'Every event × age-group is within the thresholds. Nothing to consolidate.' : 'No cells to show.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
                  <th className="py-2 pr-3">Event</th>
                  <th className="px-3">Group</th>
                  <th className="px-3">Age</th>
                  <th className="px-3 text-center">Entries</th>
                  <th className="px-3">Status</th>
                  <th className="px-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((c) => (
                  <tr key={`${c.event_id}:${c.age_group_id}`} className="border-b border-slate-100">
                    <td className="py-2 pr-3">
                      <span className="font-mono text-xs text-navy-500">{c.event_code}</span>{' '}
                      <span className="text-slate-800">{c.base || c.event_name}</span>
                      {c.is_generated && <Badge tone="navy" className="ml-2">generated</Badge>}
                      <div className="text-[11px] text-slate-400">{c.category_name}</div>
                    </td>
                    <td className="px-3 text-slate-600">{genderLabel[c.gender_split] || c.gender_split}</td>
                    <td className="px-3 text-slate-600">{c.age_group_code}</td>
                    <td className="px-3 text-center font-semibold text-slate-800">
                      {c.count}
                      {(c.boys_count > 0 || c.girls_count > 0) && (
                        <div className="text-[10px] font-normal text-slate-400">♂{c.boys_count} · ♀{c.girls_count}</div>
                      )}
                    </td>
                    <td className="px-3"><StatusBadge status={c.status} /></td>
                    <td className="px-3">
                      {c.status === 'cancelled' && <span className="text-xs text-slate-400">See history to undo</span>}
                      {c.status === 'under' && canAct(role) && (
                        c.suggestion === 'merge' && c.partner ? (
                          <Button size="sm" variant="primary" icon={Combine} onClick={() => setModal({ type: 'merge', cell: c })}>
                            Merge with {c.partner.event_code}
                          </Button>
                        ) : (
                          <Button size="sm" variant="danger" icon={Ban} onClick={() => setModal({ type: 'cancel', cell: c })}>
                            Cancel cell
                          </Button>
                        )
                      )}
                      {c.status === 'over' && canSplit(role) && (
                        <Button size="sm" variant="primary" icon={Scissors} onClick={() => setModal({ type: 'split', cell: c, mode: c.gender_split === 'common' || c.gender_split === 'none' ? 'gender' : 'age' })}>
                          Split…
                        </Button>
                      )}
                      {c.status === 'under' && !canAct(role) && <span className="text-xs text-slate-400">view only</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-6" ref={historyRef}>
        <Card title="Recent actions">
          {history.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-400">No consolidation actions yet.</div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <KindBadge kind={h.kind} />
                      <span className="truncate text-sm text-slate-800">{h.note}</span>
                    </div>
                    <div className="text-[11px] text-slate-400">
                      {h.age_group_code ? `${h.age_group_code} · ` : ''}{fmt(h.created_at)}{h.created_by_name ? ` · ${h.created_by_name}` : ''}
                      {h.reverted_at && <span className="text-red-500"> · reverted {fmt(h.reverted_at)}{h.reverted_by_name ? ` by ${h.reverted_by_name}` : ''}</span>}
                    </div>
                  </div>
                  {!h.reverted_at && canAct(role) && (
                    <Button size="sm" variant="outline" icon={Undo2} onClick={() => doRevert(h.id)} disabled={busy}>Undo</Button>
                  )}
                  {h.reverted_at && <Badge tone="neutral">reverted</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {modal && (
        <ActionModal modal={modal} busy={busy} onClose={() => setModal(null)}
          onMerge={doMerge} onCancel={doCancel} onSplit={doSplit} min={th.min} />
      )}
    </AdminLayout>
  );
}

function Stat({ label, value, tone }) {
  const tones = { amber: 'text-amber-700 bg-amber-50 border-amber-200', violet: 'text-violet-700 bg-violet-50 border-violet-200', red: 'text-red-700 bg-red-50 border-red-200' };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs font-medium">{label}</div>
    </div>
  );
}
function StatusBadge({ status }) {
  if (status === 'under') return <Badge tone="warning">under</Badge>;
  if (status === 'over') return <Badge tone="navy">over</Badge>;
  if (status === 'cancelled') return <Badge tone="danger">cancelled</Badge>;
  return <Badge tone="success">ok</Badge>;
}
function KindBadge({ kind }) {
  const map = { merge: ['success', 'Merge'], cancel: ['danger', 'Cancel'], split: ['navy', 'Split'] };
  const [tone, label] = map[kind] || ['neutral', kind];
  return <Badge tone={tone}>{label}</Badge>;
}

function ActionModal({ modal, busy, onClose, onMerge, onCancel, onSplit, min }) {
  const c = modal.cell;
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState(modal.mode || 'gender');
  const [notify, setNotify] = useState(true);
  const genderSplittable = c.gender_split === 'common' || c.gender_split === 'none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        {modal.type === 'merge' && (
          <>
            <h3 className="text-lg font-bold text-navy-800">Merge into a Common event</h3>
            <p className="mt-2 text-sm text-slate-600">
              Combine <b>{c.event_code}</b> ({c.count}) and <b>{c.partner.event_code}</b> ({c.partner.cnt}) for
              age group <b>{c.age_group_code}</b> into <b>{c.base} (Common)</b>. Combined entries:{' '}
              <b>{c.count + c.partner.cnt}</b>. All these registrations move to the new event and the parents
              are notified by WhatsApp + email.
            </p>
            <label className="mt-5 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify parents (WhatsApp + email)</label>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" icon={Combine} loading={busy} onClick={() => onMerge(c, notify)}>Merge now</Button>
            </div>
          </>
        )}
        {modal.type === 'cancel' && (
          <>
            <h3 className="text-lg font-bold text-navy-800">Cancel this event cell</h3>
            <p className="mt-2 text-sm text-slate-600">
              <b>{c.event_code} — {c.base || c.event_name}</b>, age group <b>{c.age_group_code}</b>, has {c.count}{' '}
              entr{c.count === 1 ? 'y' : 'ies'} (under {min}). It will be hidden from the lists and the {c.count}{' '}
              parent(s) notified to choose another event or request a refund. You handle the swap/refund manually.
            </p>
            <label className="mt-4 block text-xs font-medium text-slate-500">Reason (optional, not shown to parents)</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="e.g. only 2 entries" />
            <label className="mt-5 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify parents (WhatsApp + email)</label>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>Back</Button>
              <Button variant="danger" icon={Ban} loading={busy} onClick={() => onCancel(c, reason, notify)}>Cancel cell</Button>
            </div>
          </>
        )}
        {modal.type === 'split' && (
          <>
            <h3 className="text-lg font-bold text-navy-800">Split into two events</h3>
            <p className="mt-2 text-sm text-slate-600">
              <b>{c.event_code} — {c.base || c.event_name}</b>, age group <b>{c.age_group_code}</b>, has <b>{c.count}</b> entries.
              Choose how to split it into two new events. Registrations move automatically and, unless you turn it off below, parents are notified.
            </p>
            <div className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              This cell has <b>{c.boys_count}</b> boys and <b>{c.girls_count}</b> girls.
            </div>
            <div className="mt-4 space-y-2">
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${mode === 'gender' ? 'border-navy-400 bg-navy-50' : 'border-slate-200'} ${!genderSplittable ? 'opacity-50' : ''}`}>
                <input type="radio" name="mode" className="mt-1" checked={mode === 'gender'} disabled={!genderSplittable} onChange={() => setMode('gender')} />
                <span className="text-sm"><b>By gender</b> — Boys and Girls{!genderSplittable ? ' (this event already has a fixed gender)' : ''}</span>
              </label>
              <label className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 ${mode === 'age' ? 'border-navy-400 bg-navy-50' : 'border-slate-200'}`}>
                <input type="radio" name="mode" className="mt-1" checked={mode === 'age'} onChange={() => setMode('age')} />
                <span className="text-sm"><b>By age</b> — A (older half) and B (younger half)</span>
              </label>
            </div>
            <label className="mt-5 flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Notify parents (WhatsApp + email)</label>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button variant="primary" icon={Scissors} loading={busy} onClick={() => onSplit(c, mode, notify)}>Split now</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
