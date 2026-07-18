// src/pages/judging/Assignment.jsx
// Judging → Event assignment. One row per scheduled event (earliest date
// first) with venue/time/age-group/entries summary and 3 judge slots. Assign
// picks judges whose expertise matches the event's category (strict); briefing
// OTPs for an event's judges are sent from here. Chairman/SuperAdmin only.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, UserPlus, KeyRound, Mic } from 'lucide-react';
import AdminLayout from '../../components/layout/AdminLayout';
import { Card, Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { PageLoader, ErrorBanner } from '../../components/ui/States';
import { useAuth } from '../../context/AuthContext';
import { judgesApi, eventStaffApi } from '../../api/client';

export default function Assignment() {
  const { token } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [sendingId, setSendingId] = useState(null);
  const [otpInfo, setOtpInfo] = useState(null);

  const [modalEvent, setModalEvent] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [modalErr, setModalErr] = useState('');
  const [mcEvent, setMcEvent] = useState(null);
  const [mcData, setMcData] = useState({ mc: [], timer: [] });
  const [mcUsers, setMcUsers] = useState([]);
  const [mcPick, setMcPick] = useState('');
  const [newMc, setNewMc] = useState({ full_name: '', email: '', password: '' });
  const [mcBusy, setMcBusy] = useState(false);
  const [mcMsg, setMcMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setRows(await judgesApi.eventAssignments(token)); }
    catch (err) { setError(err.message || 'Failed to load assignments'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  async function openAssign(ev) {
    setModalEvent(ev); setModalErr(''); setCandidates([]);
    setSelected(new Set(ev.judges.map((j) => j.judge_id)));
    try {
      const r = await judgesApi.candidates(token, ev.event_id);
      const ids = new Set(r.candidates.map((c) => c.id));
      const extra = ev.judges.filter((j) => !ids.has(j.judge_id))
        .map((j) => ({ id: j.judge_id, full_name: j.full_name, is_blacklisted: j.is_blacklisted, has_phone: j.has_phone, assigned: true, off_category: true }));
      setCandidates([...r.candidates, ...extra]);
    } catch (err) { setModalErr(err.message); }
  }

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function saveAssign() {
    if (!modalEvent) return;
    setBusy(true); setModalErr('');
    const asgMap = new Map(modalEvent.judges.map((j) => [j.judge_id, j.assignment_id]));
    const currentIds = new Set(asgMap.keys());
    const toAssign = [...selected].filter((id) => !currentIds.has(id));
    const toRemove = [...currentIds].filter((id) => !selected.has(id));
    try {
      for (const id of toAssign) {
        try {
          await judgesApi.assign(token, { judge_id: id, event_id: modalEvent.event_id });
        } catch (err) {
          if (err.data?.requiresChairmanConfirmation
              && window.confirm(`${err.data.warning}\n\nAssign anyway?`)) {
            await judgesApi.assign(token, { judge_id: id, event_id: modalEvent.event_id, chairman_confirmed: true });
          } else throw err;
        }
      }
      for (const id of toRemove) await judgesApi.unassign(token, asgMap.get(id));
      setModalEvent(null); setFlash('Judges updated.'); load();
    } catch (err) { setModalErr(err.message); }
    finally { setBusy(false); }
  }

  async function sendOtps(ev) {
    setSendingId(ev.event_id); setFlash('');
    try {
      const r = await judgesApi.sendEventOtps(token, ev.event_id);
      setOtpInfo({ event: `${ev.event_code} · ${ev.event_name}`, ...r });
    } catch (err) { setFlash(err.message); }
    finally { setSendingId(null); }
  }

  async function openMc(ev) {
    setMcEvent(ev); setMcPick(''); setNewMc({ full_name: '', email: '', password: '' }); setMcMsg('');
    try { const [d, u] = await Promise.all([eventStaffApi.forEvent(token, ev.event_id), eventStaffApi.users(token, 'MC')]); setMcData(d); setMcUsers(u); }
    catch (e) { setFlash(e.message); }
  }
  async function assignMc() {
    if (!mcPick) return; setMcBusy(true);
    try { await eventStaffApi.assign(token, { role: 'MC', user_id: Number(mcPick), event_id: mcEvent.event_id });
      setMcData(await eventStaffApi.forEvent(token, mcEvent.event_id)); setMcPick(''); setMcMsg('MC assigned.'); }
    catch (e) { setMcMsg(e.message); } finally { setMcBusy(false); }
  }
  async function unassignMc(assignmentId) {
    try { await eventStaffApi.unassign(token, 'MC', assignmentId); setMcData(await eventStaffApi.forEvent(token, mcEvent.event_id)); setMcMsg('Removed.'); }
    catch (e) { setMcMsg(e.message); }
  }
  async function createMc() {
    if (!newMc.full_name.trim() || !newMc.password) { setFlash('MC name and password are required.'); return; }
    setMcBusy(true);
    try { const u = await eventStaffApi.createUser(token, { ...newMc, role: 'MC' });
      setMcUsers(await eventStaffApi.users(token, 'MC')); setMcPick(String(u.id)); setNewMc({ full_name: '', email: '', password: '' });
      setMcMsg(`MC "${u.full_name}" created — now click Assign.`); }
    catch (e) { setMcMsg(e.message); } finally { setMcBusy(false); }
  }

  const slot = (judges, i) => judges[i]?.full_name || <span className="text-slate-300">—</span>;

  return (
    <AdminLayout title="Event assignment"
      subtitle="Assign 3 judges per event (matched to the event's category), then send their briefing OTPs."
      actions={<Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>}>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      <Card className="p-0 overflow-hidden">
        {loading ? <div className="p-6"><PageLoader label="Loading assignments…" /></div>
          : error ? <div className="p-6"><ErrorBanner message={error} onRetry={load} /></div>
          : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-400">No scheduled events yet — generate the schedule first.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Date</th>
                    <th className="px-3 py-2">Time</th>
                    <th className="px-3 py-2">Venue</th>
                    <th className="px-3 py-2">Event</th>
                    <th className="px-3 py-2">Ages</th>
                    <th className="px-3 py-2">Entries</th>
                    <th className="px-3 py-2">Judge 1</th>
                    <th className="px-3 py-2">Judge 2</th>
                    <th className="px-3 py-2">Judge 3</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((ev) => (
                    <tr key={ev.event_id} className="hover:bg-slate-50 align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-600">
                        {ev.earliest_date}
                        {!ev.published && <span className="ml-1 text-[10px] text-amber-600">(draft)</span>}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-xs text-slate-600">
                        {ev.first_start || '—'}
                        {ev.session_count > 1 && <span className="ml-1 text-[10px] text-slate-400">+{ev.session_count - 1}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{ev.venues || '—'}</td>
                      <td className="px-3 py-2">
                        <div>
                          <span className="font-mono text-xs text-navy-700 mr-1.5">{ev.event_code}</span>
                          <span className="font-medium text-slate-800">{ev.event_name}</span>
                          <Badge tone={ev.judges.length === 3 ? 'success' : ev.judges.length > 3 ? 'gold' : 'slate'} className="ml-2">
                            {ev.judges.length}/3
                          </Badge>
                        </div>
                        <div className="text-[11px] text-slate-400">{ev.category_name || '—'}</div>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{ev.age_groups || '—'}</td>
                      <td className="px-3 py-2"><Badge tone="navy">{ev.entries ?? 0}</Badge></td>
                      <td className="px-3 py-2 text-xs">{slot(ev.judges, 0)}</td>
                      <td className="px-3 py-2 text-xs">{slot(ev.judges, 1)}</td>
                      <td className="px-3 py-2 text-xs">
                        {slot(ev.judges, 2)}
                        {ev.judges.length > 3 && <span className="ml-1 text-[10px] text-slate-400">+{ev.judges.length - 3}</span>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1.5">
                          <Button size="sm" variant="outline" icon={UserPlus} onClick={() => openAssign(ev)}>Assign</Button>
                          <Button size="sm" variant="ghost" icon={KeyRound} loading={sendingId === ev.event_id}
                            disabled={ev.judges.length === 0} onClick={() => sendOtps(ev)} title="Send briefing OTPs to this event's judges">OTP</Button>
                          <Button size="sm" variant="ghost" icon={Mic} onClick={() => openMc(ev)} title="Assign an MC to this event">MC</Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      <ConfirmDialog
        open={!!modalEvent}
        title={modalEvent ? `Assign judges — ${modalEvent.event_code} ${modalEvent.event_name}` : ''}
        description={modalEvent ? `Category: ${modalEvent.category_name || '—'}. Showing judges whose expertise matches; pick 3.` : ''}
        confirmLabel="Save" variant="primary" loading={busy}
        onCancel={() => setModalEvent(null)} onConfirm={saveAssign}>
        <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200 divide-y divide-slate-100">
          {candidates.length === 0 && (
            <p className="px-3 py-4 text-xs text-slate-400">
              No judges have this category in their expertise. Add it on the Judges page first.
            </p>
          )}
          {candidates.map((c) => (
            <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
              <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)}
                className="h-4 w-4 rounded border-slate-300" />
              <span className="flex-1 text-slate-800">{c.full_name}</span>
              {c.off_category && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">off-category</span>}
              {c.is_blacklisted && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-600">blacklisted</span>}
              {!c.has_phone && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">no phone</span>}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{selected.size} selected · 3 per event recommended.</p>
        {modalErr && <p className="mt-1 text-xs text-red-600">{modalErr}</p>}
      </ConfirmDialog>

      {otpInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOtpInfo(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-900">Judge OTPs — {otpInfo.event}</h3>
            <p className="mt-1 text-xs text-slate-500">
              {otpInfo.delivered > 0 ? `${otpInfo.delivered} sent via WhatsApp automatically. ` : 'WhatsApp API not configured. '}
              Tap “Open WhatsApp” to send each judge their OTP.
            </p>
            <div className="mt-3 divide-y divide-slate-100 rounded-md border border-slate-200">
              {(otpInfo.links || []).map((l) => {
                const code = (otpInfo.dev_codes || []).find((d) => d.name === l.name)?.code;
                return (
                  <div key={l.phone} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div>
                      <div className="font-medium text-slate-800">{l.name}</div>
                      <div className="text-xs text-slate-500">{l.phone}{code ? ` · code ${code}` : ''}{l.delivered ? ' · sent ✓' : ''}</div>
                    </div>
                    {l.url && (
                      <a href={l.url} target="_blank" rel="noreferrer"
                        className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700">Open WhatsApp</a>
                    )}
                  </div>
                );
              })}
              {(!otpInfo.links || otpInfo.links.length === 0) && <p className="px-3 py-3 text-xs text-slate-400">No judges with a phone number.</p>}
            </div>
            {otpInfo.skipped?.length > 0 && (
              <p className="mt-2 text-xs text-amber-600">No phone on file: {otpInfo.skipped.join(', ')}</p>
            )}
            <div className="mt-4 text-right">
              <button onClick={() => setOtpInfo(null)} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Done</button>
            </div>
          </div>
        </div>
      )}
      {mcEvent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setMcEvent(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-900">MC — {mcEvent.event_code} {mcEvent.event_name}</h3>
            {mcMsg && <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">{mcMsg}</p>}
            <div className="mt-3">
              <p className="mb-1 text-xs font-medium text-slate-500">Assigned MC</p>
              {mcData.mc.length === 0 ? <p className="text-sm text-slate-400">None yet.</p> : mcData.mc.map((m) => (
                <div key={m.assignment_id} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-1.5 text-sm">
                  <span>{m.full_name}{m.email ? ` · ${m.email}` : ''}</span>
                  <button onClick={() => unassignMc(m.assignment_id)} className="text-xs text-red-600 hover:underline">Remove</button>
                </div>))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <select value={mcPick} onChange={(e) => setMcPick(e.target.value)} className="flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                <option value="">Pick an existing MC…</option>
                {mcUsers.map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.email ? ` · ${u.email}` : ''}</option>)}
              </select>
              <button onClick={assignMc} disabled={!mcPick || mcBusy} className="rounded-md bg-navy-600 px-3 py-1.5 text-sm text-white disabled:bg-navy-300">Assign</button>
            </div>
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="mb-1 text-xs font-medium text-slate-500">Or create a new MC account (they log in with email + password)</p>
              <div className="space-y-2">
                <input value={newMc.full_name} onChange={(e) => setNewMc({ ...newMc, full_name: e.target.value })} placeholder="Full name" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                <input value={newMc.email} onChange={(e) => setNewMc({ ...newMc, email: e.target.value })} placeholder="Email (used to log in)" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                <input value={newMc.password} onChange={(e) => setNewMc({ ...newMc, password: e.target.value })} placeholder="Password" className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                <button onClick={createMc} disabled={mcBusy} className="rounded-md border border-navy-300 px-3 py-1.5 text-sm text-navy-700 disabled:opacity-50">Create MC</button>
              </div>
            </div>
            <div className="mt-4 text-right"><button onClick={() => setMcEvent(null)} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Done</button></div>
          </div>
        </div>
      )}
    </AdminLayout>
  );
}
