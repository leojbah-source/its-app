// src/pages/judging/Videography.jsx
// Videographer / Media view. Pick a date and event; see the live opted-in list
// (who wants a paid video of their performance) and tick each as recorded.
// The list auto-refreshes every 5 minutes so new opt-ins taken at the desk
// during the event appear without a manual reload. A CSV export gives the
// videographer a prep sheet of everyone who opted, by date and event.
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { Video, RefreshCw, Download, Check, Circle } from 'lucide-react';
import AdminLayout from '../../components/layout/AdminLayout';
import { Card, Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { PageLoader } from '../../components/ui/States';
import { useAuth } from '../../context/AuthContext';
import { scheduleApi, videoApi } from '../../api/client';

const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';
const fmtDay = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : d);
const money = (v) => `BHD ${Number(v || 0).toFixed(3)}`;
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes

export default function Videography() {
  const { token } = useAuth();
  const [schedule, setSchedule] = useState([]);
  const [date, setDate] = useState('');
  const [eventId, setEventId] = useState('');
  const [groupFilter, setGroupFilter] = useState('');
  const [rows, setRows] = useState([]);
  const [linkEdit, setLinkEdit] = useState({});
  const [linkBusy, setLinkBusy] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [flash, setFlash] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => { scheduleApi.list(token).then(setSchedule).catch((e) => setFlash(e.message)); }, [token]);

  const dates = useMemo(() => [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(), [schedule]);
  useEffect(() => { if (!date && dates.length) setDate(dates[0]); }, [dates, date]);

  // Video recording is offered for dance events (category NATYA), all team events, and Fashion Show.
  const isVideoEvent = (r) => r.event_kind === 'team'
    || /natya/i.test(r.category_code || '') || /dance/i.test(r.category_name || '')
    || /fashion/i.test(r.event_name || '');

  const events = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (date && String(r.event_date).slice(0, 10) !== date) continue;
      if (!isVideoEvent(r)) continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);

  useEffect(() => { setEventId(''); setRows([]); setGroupFilter(''); }, [date]);

  const load = useCallback(async (quiet = false) => {
    if (!eventId) { setRows([]); return; }
    if (!quiet) setLoading(true);
    try {
      const data = await videoApi.requests(token, { event_id: eventId });
      setRows(data); setLastSync(new Date());
    } catch (err) { setFlash(err.message); }
    finally { if (!quiet) setLoading(false); }
  }, [token, eventId]);

  useEffect(() => { setGroupFilter(''); load(); }, [load]);

  // Auto-refresh every 5 minutes while an event is selected.
  useEffect(() => {
    if (!eventId) return;
    pollRef.current = setInterval(() => load(true), REFRESH_MS);
    return () => clearInterval(pollRef.current);
  }, [eventId, load]);

  // Only the age groups scheduled for THIS event on THIS date (from the schedule's
  // per-session age_groups) — not every group that has video requests on other days.
  const scheduledCodes = useMemo(() => {
    const set = new Set();
    if (!date || !eventId) return set;
    for (const r of schedule) {
      if (String(r.event_date).slice(0, 10) !== date) continue;
      if (String(r.event_id) !== String(eventId)) continue;
      for (const c of String(r.age_groups || '').split(',').map((x) => x.trim()).filter(Boolean)) set.add(c);
    }
    return set;
  }, [schedule, date, eventId]);

  const scheduledRows = useMemo(
    () => (scheduledCodes.size ? rows.filter((r) => scheduledCodes.has(r.age_group)) : rows),
    [rows, scheduledCodes]);

  const groups = useMemo(() => {
    const m = new Map();
    for (const r of scheduledRows) if (r.age_group && !m.has(r.age_group)) m.set(r.age_group, r.age_group_label || r.age_group);
    return [...m.entries()].map(([code, label]) => ({ code, label }));
  }, [scheduledRows]);

  const visible = useMemo(() => (groupFilter ? scheduledRows.filter((r) => r.age_group === groupFilter) : scheduledRows), [scheduledRows, groupFilter]);
  const counts = useMemo(() => ({
    total: visible.length,
    recorded: visible.filter((r) => r.recorded).length,
    pending: visible.filter((r) => !r.recorded).length,
  }), [visible]);

  const evName = events.find((e) => String(e.event_id) === String(eventId));

  async function saveLink(row) {
    const url = (linkEdit[row.registration_id] ?? row.video_url ?? '').trim();
    setLinkBusy(row.registration_id);
    try {
      const r = await videoApi.setLink(token, row.registration_id, url);
      setRows((prev) => prev.map((x) => (x.registration_id === row.registration_id ? { ...x, video_url: r.video_url } : x)));
      setLinkEdit((m) => { const n = { ...m }; delete n[row.registration_id]; return n; });
    } catch (e) { setFlash(e.message); }
    finally { setLinkBusy(null); }
  }

  async function toggleRecorded(row) {
    setBusyId(row.registration_id);
    setRows((prev) => prev.map((x) => (x.registration_id === row.registration_id ? { ...x, recorded: !x.recorded } : x)));
    try { await videoApi.setRecorded(token, row.registration_id, !row.recorded); }
    catch (err) { setFlash(err.message); load(true); }
    finally { setBusyId(null); }
  }

  // Export the FULL list of video requests (every date, event and age group,
  // with the recording status) for file preparation — not just the selected event.
  async function downloadCsv() {
    try {
      const csv = await videoApi.requestsCsv(token, {});
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'video-requests-all.csv';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setFlash(err.message); }
  }

  return (
    <AdminLayout>
      <div className="mb-5">
        <h1 className="text-xl font-bold text-navy-800">Videography</h1>
        <p className="mt-1 text-sm text-slate-500">
          Opted-in performances for the selected event. The list refreshes automatically every 5 minutes;
          tick each one as you record it. Use “Download list” to prepare your files afterwards.
        </p>
      </div>

      {flash && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{flash}</div>}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Date</label>
            <select className={`${sel} mt-1`} value={date} onChange={(e) => setDate(e.target.value)}>
              {dates.length === 0 && <option value="">No scheduled dates</option>}
              {dates.map((d) => <option key={d} value={d}>{fmtDay(d)}</option>)}
            </select>
          </div>
          <div className="min-w-[260px] flex-1">
            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Event</label>
            <select className={`${sel} mt-1 w-full`} value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Select an event…</option>
              {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.code} · {e.name}</option>)}
            </select>
          </div>
          {groups.length > 1 && (
            <div>
              <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Group</label>
              <select className={`${sel} mt-1`} value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
                <option value="">All groups</option>
                {groups.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
              </select>
            </div>
          )}
          <Button variant="outline" size="sm" icon={RefreshCw} onClick={() => load()}>Refresh</Button>
          <Button variant="gold" size="sm" icon={Download} onClick={downloadCsv}>Download all (CSV)</Button>
        </div>
      </Card>

      {eventId && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone="navy">{counts.total} opted</Badge>
            <Badge tone="success">{counts.recorded} recorded</Badge>
            <Badge tone="gold">{counts.pending} pending</Badge>
            <div className="flex-1" />
            {lastSync && <span className="text-xs text-slate-400">Updated {lastSync.toLocaleTimeString()}</span>}
          </div>

          <Card className="p-0 overflow-hidden">
            {loading ? <div className="p-6"><PageLoader label="Loading opted-in list…" /></div>
              : visible.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No video requests yet for this event.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 w-16">Chest</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Group</th>
                        <th className="px-3 py-2">Payment</th>
                        <th className="px-3 py-2">Video link</th>
                        <th className="px-3 py-2 text-right">Recorded</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(() => {
                        let lastG = null; const out = [];
                        visible.forEach((r) => {
                          const g = r.age_group_label || r.age_group || '—';
                          if (g !== lastG) {
                            lastG = g;
                            out.push(
                              <tr key={`grp-${g}`} className="bg-slate-100">
                                <td colSpan={6} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-navy-700">{g}</td>
                              </tr>
                            );
                          }
                          out.push(
                        <tr key={r.registration_id} className={r.recorded ? 'bg-emerald-50/40' : 'hover:bg-slate-50'}>
                          <td className="px-3 py-2">{r.chest_number != null ? <span className="font-mono font-semibold text-navy-800">{r.chest_number}</span> : <span className="text-slate-300">—</span>}</td>
                          <td className="px-3 py-2 font-medium text-slate-800">{r.name}</td>
                          <td className="px-3 py-2 text-slate-500">{r.age_group_label || r.age_group || '—'}</td>
                          <td className="px-3 py-2">
                            <Badge tone={r.payment_method === 'benefitpay' ? 'navy' : 'slate'}>{r.payment_method === 'benefitpay' ? 'BenefitPay' : 'Cash'}</Badge>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              <input value={linkEdit[r.registration_id] ?? r.video_url ?? ''}
                                onChange={(e) => setLinkEdit((m) => ({ ...m, [r.registration_id]: e.target.value }))}
                                placeholder="paste share link"
                                className="w-40 rounded border border-slate-300 px-2 py-1 text-xs" />
                              <Button size="sm" variant="outline" loading={linkBusy === r.registration_id} onClick={() => saveLink(r)}>Save</Button>
                              {r.video_url && <a href={r.video_url} target="_blank" rel="noreferrer" className="text-[10px] text-navy-600 underline">open</a>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button size="sm" variant={r.recorded ? 'primary' : 'outline'} icon={r.recorded ? Check : Circle}
                              loading={busyId === r.registration_id} onClick={() => toggleRecorded(r)}>
                              {r.recorded ? 'Recorded' : 'Mark recorded'}
                            </Button>
                          </td>
                        </tr>
                          );
                        });
                        return out;
                      })()}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
        </>
      )}
    </AdminLayout>
  );
}
