// src/pages/Schedule.jsx
// Schedule preparation (Blueprint §4.7): generate a draft with the scheduler
// service (no participant double-booked, max 2 events/day per participant,
// same-category venue clustering), review & adjust rows, then publish.

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Wand2, CheckCircle2, Save } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { scheduleApi, venuesApi } from '../api/client';

const inputCls = 'rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

function RowEditor({ row, token, onSaved }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);

  function start() {
    setF({
      event_date: String(row.event_date).slice(0, 10),
      start_time: (row.start_time || '').slice(0, 5),
      end_time: (row.end_time || '').slice(0, 5),
      venue: row.venue || '',
    });
    setEdit(true);
  }
  async function save() {
    setBusy(true);
    try {
      await scheduleApi.update(token, row.id, f);
      setEdit(false);
      onSaved();
    } catch (err) { alert(err.message); }
    finally { setBusy(false); }
  }

  if (!edit) {
    return (
      <button onClick={start} className="text-xs font-medium text-navy-600 underline">
        Adjust
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input type="date" value={f.event_date} onChange={(e) => setF({ ...f, event_date: e.target.value })} className={inputCls} />
      <input type="time" value={f.start_time} onChange={(e) => setF({ ...f, start_time: e.target.value })} className={`${inputCls} w-24`} />
      <input type="time" value={f.end_time} onChange={(e) => setF({ ...f, end_time: e.target.value })} className={`${inputCls} w-24`} />
      <input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} placeholder="Venue" className={`${inputCls} w-28`} />
      <Button variant="primary" size="sm" icon={Save} loading={busy} onClick={save}>Save</Button>
      <Button variant="outline" size="sm" onClick={() => setEdit(false)}>Cancel</Button>
    </div>
  );
}

export default function Schedule() {
  const { token } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [unplaced, setUnplaced] = useState([]);

  // Draft-generation inputs (venues + availability come from the facility
  // setup in Year Setup; here we only pick the window + buffer)
  const [showGen, setShowGen] = useState(false);
  const [venues, setVenues] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [buffer, setBuffer] = useState(30);
  const [maxGroups, setMaxGroups] = useState(3);
  const [generating, setGenerating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rowsData, venueData] = await Promise.all([
        scheduleApi.list(token),
        venuesApi.list(token).catch(() => []),
      ]);
      setRows(rowsData);
      setVenues(venueData);
    } catch (err) {
      setError(err.message || 'Failed to load schedule');
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function generate() {
    setGenerating(true);
    setFlash('');
    setUnplaced([]);
    try {
      const r = await scheduleApi.generateDraft(token, {
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        reporting_buffer_minutes: Number(buffer) || 30,
        max_groups_per_session: Number(maxGroups) || 3,
      });
      setFlash(`Draft generated: ${r.scheduled} events placed${r.unplaced.length ? `, ${r.unplaced.length} could not be placed` : ''}.`);
      setUnplaced(r.unplaced || []);
      setShowGen(false);
      load();
    } catch (err) { setFlash(err.message); }
    finally { setGenerating(false); }
  }

  async function publish() {
    if (!window.confirm('Publish the draft schedule? Rows become CONFIRMED and visible downstream.')) return;
    try {
      const r = await scheduleApi.publish(token);
      setFlash(`Schedule published — ${r.confirmed} events confirmed.`);
      load();
    } catch (err) { setFlash(err.message); }
  }

  // group rows by date
  const byDate = rows.reduce((acc, r) => {
    const d = String(r.event_date).slice(0, 10);
    (acc[d] ??= []).push(r);
    return acc;
  }, {});
  const draftCount = rows.filter((r) => r.status === 'draft').length;

  return (
    <AdminLayout
      title="Schedule"
      subtitle="Auto-generate a draft over the competition window, adjust as needed, then publish. No participant is double-booked or given more than 2 events per day."
      actions={
        <>
          <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
          <Button variant="outline" icon={Wand2} onClick={() => setShowGen((x) => !x)}>
            Generate draft…
          </Button>
          <Button variant="gold" icon={CheckCircle2} onClick={publish} disabled={draftCount === 0}>
            Publish schedule ({draftCount} draft)
          </Button>
        </>
      }
    >
      {flash && (
        <p className="mb-4 rounded-lg bg-navy-50 border border-navy-200 px-4 py-2 text-sm text-navy-700">{flash}</p>
      )}

      {showGen && (
        <Card className="mb-4">
          <div className="space-y-3">
            <div>
              <p className="text-xs font-medium text-slate-600 mb-1.5">
                Venues &amp; availability (from Year Setup → Venues / facility setup)
              </p>
              {venues.length === 0 ? (
                <p className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
                  No venues defined yet — set them up in Year Setup first.
                </p>
              ) : (
                <ul className="space-y-1">
                  {venues.map((v) => {
                    const dayStr = Object.entries(v.weekday_hours || {})
                      .map(([d, h]) => `${d} ${h.start}–${h.end}`).join(', ');
                    return (
                      <li key={v.id} className="text-xs text-slate-600">
                        <b>{v.name}</b>
                        {v.has_stage ? ' · stage' : ' · no stage'}
                        {v.capacity ? ` · cap ${v.capacity}` : ''}
                        {v.suitable_for?.length ? ` · ${v.suitable_for.join('/')}` : ' · all events'}
                        {' · '}
                        {dayStr || (
                          <span className="text-amber-600 font-semibold">
                            NO DAYS SET — this venue will never be used! Set its availability in Year Setup.
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  From (blank = Year Setup start date)
                </label>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  To (blank = Year Setup end date)
                </label>
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Reporting buffer (min)
                </label>
                <input type="number" min={0} value={buffer}
                  onChange={(e) => setBuffer(e.target.value)} className={`${inputCls} w-24`} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Max age groups combined per session
                </label>
                <select value={maxGroups} onChange={(e) => setMaxGroups(e.target.value)} className={inputCls}>
                  <option value={1}>1 (each group separate)</option>
                  <option value={2}>2</option>
                  <option value={3}>3 (judge-efficient)</option>
                </select>
              </div>
            </div>
            <p className="text-xs text-amber-600">
              Generating replaces the current DRAFT rows (confirmed rows are kept). Events are
              only placed in venues that suit their category, have capacity, and are open that day.
            </p>
            <Button variant="primary" icon={Wand2} loading={generating}
              disabled={venues.length === 0} onClick={generate}>
              Generate draft schedule
            </Button>
          </div>
        </Card>
      )}

      {unplaced.length > 0 && (
        <Card className="mb-4">
          <p className="text-sm font-semibold text-red-700 mb-2">
            {unplaced.length} event(s) could not be placed:
          </p>
          <ul className="text-xs text-red-700 space-y-1.5">
            {unplaced.map((u, i) => (
              <li key={i} className="border-l-2 border-red-200 pl-2">
                <span className="font-semibold">
                  {u.event_code ? `${u.event_code} — ${u.event_name}` : `Event #${u.event_id}`}
                </span>
                {u.entries != null && (
                  <span className="text-red-500"> ({u.entries} entries{u.needed_minutes ? `, ~${u.needed_minutes} min needed` : ''})</span>
                )}
                <p className="text-red-600 font-normal">{u.reason}</p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-500 mt-2">
            Fix the venue availability/hours in Year Setup or widen the date window, then regenerate.
          </p>
        </Card>
      )}

      <Card>
        {loading ? <PageLoader label="Loading schedule…" />
          : error ? <ErrorBanner message={error} onRetry={load} />
          : rows.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">
              No schedule yet — use "Generate draft…" once registrations are closed.
            </p>
          ) : (
            <div className="space-y-6">
              {Object.entries(byDate).map(([date, list]) => (
                <div key={date}>
                  <h3 className="text-sm font-semibold text-navy-800 mb-2">
                    {new Date(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  </h3>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
                          <th className="px-3 py-2">Time</th>
                          <th className="px-3 py-2">Venue</th>
                          <th className="px-3 py-2">Event</th>
                          <th className="px-3 py-2">Category</th>
                          <th className="px-3 py-2">Entries</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {list.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-50">
                            <td className="px-3 py-2 font-mono text-xs">
                              {(r.start_time || '').slice(0, 5)}–{(r.end_time || '').slice(0, 5)}
                            </td>
                            <td className="px-3 py-2 text-slate-600">{r.venue || '—'}</td>
                            <td className="px-3 py-2">
                              <span className="font-mono text-xs text-navy-700 mr-1.5">{r.event_code}</span>
                              <span className="font-medium text-slate-800">{r.event_name}</span>
                              {r.age_groups && (
                                <span className="ml-1.5 rounded bg-gold-100 text-gold-700 px-1.5 py-0.5 text-[10px] font-semibold">
                                  {r.age_groups}
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs text-slate-500">{r.category_name || '—'}</td>
                            <td className="px-3 py-2"><Badge tone="navy">{r.entries}</Badge></td>
                            <td className="px-3 py-2">
                              <Badge tone={r.status === 'confirmed' ? 'success' : r.status === 'completed' ? 'gold' : 'slate'}>
                                {r.status}
                              </Badge>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <RowEditor row={r} token={token} onSaved={load} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
      </Card>
    </AdminLayout>
  );
}
