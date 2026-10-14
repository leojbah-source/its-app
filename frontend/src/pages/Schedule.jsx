// src/pages/Schedule.jsx
// Schedule preparation (Blueprint §4.7): generate a draft with the scheduler
// service (no participant double-booked, max 2 events/day per participant,
// same-category venue clustering), review & adjust rows, then publish.

import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Wand2, CheckCircle2, Save, Lock, Unlock, Trash2 } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { scheduleApi, venuesApi } from '../api/client';

const inputCls = 'rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

const toMin = (t) => { const [h, m] = String(t || '0:0').split(':').map(Number); return (h * 60 + (m || 0)); };
const fmtMin = (mins) => {
  const x = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};
// Expand a schedule row into one entry per age group, with a staggered
// reporting time for stage events (each group reports `lead` min before its
// turn; groups run back-to-back within the combined sitting).
function perGroupRows(r, lead) {
  const groups = (r.groups && r.groups.length)
    ? r.groups
    : [{ code: r.age_groups || '—', entries: r.entries }];
  const perMin = r.allotted_time_seconds ? Math.round((r.allotted_time_seconds / 60) * 10) / 10 : null;
  const startMin = r.start_time ? toMin(r.start_time) : null;
  let offset = 0;
  return groups.map((g) => {
    let reportMin = null;
    if (startMin != null) {
      if (r.is_stage_event) {
        reportMin = startMin + offset - lead;
        offset += Math.round((g.entries || 0) * (perMin || 5));
      } else {
        reportMin = startMin - lead;
      }
    }
    return { ...g, reportMin, perMin };
  });
}

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
      const chk = await scheduleApi.checkMove(token, row.id, f);
      if (chk?.warnings?.length) {
        const ok = window.confirm(
          'Heads up — this move may break the rules:\n\n• ' + chk.warnings.join('\n• ') + '\n\nSave anyway?');
        if (!ok) { setBusy(false); return; }
      }
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
  const { token, user } = useAuth();
  const canEdit = user?.role !== 'EventStaff';
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
  const [gap, setGap] = useState(15);
  const [maxGroups, setMaxGroups] = useState(3);
  const [catDates, setCatDates] = useState([]);  // [{id,code,name,not_before_date}]
  const [generating, setGenerating] = useState(false);
  const [excludeCats, setExcludeCats] = useState(() => new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rowsData, venueData, catData] = await Promise.all([
        scheduleApi.list(token),
        venuesApi.list(token).catch(() => []),
        scheduleApi.categoryDates(token).catch(() => []),
      ]);
      setRows(rowsData);
      setVenues(venueData);
      setCatDates(catData);
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
      // Save the per-category earliest dates first so the draft honours them.
      const dateMap = {};
      for (const c of catDates) dateMap[c.id] = c.not_before_date || null;
      await scheduleApi.saveCategoryDates(token, dateMap).catch(() => {});
      const r = await scheduleApi.generateDraft(token, {
        start_date: startDate || undefined,
        end_date: endDate || undefined,
        reporting_buffer_minutes: Number(buffer) || 30,
        gap_minutes: gap === '' ? 15 : Number(gap),
        max_groups_per_session: Number(maxGroups) || 3,
        exclude_category_ids: [...excludeCats],
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

  async function lock() {
    if (!window.confirm('Lock the current placements as a phase? Locked events stay fixed when you generate later phases.')) return;
    try {
      const r = await scheduleApi.lock(token);
      setFlash(`Locked ${r.locked} event(s) — they stay fixed in later generations.`);
      load();
    } catch (err) { setFlash(err.message); }
  }

  async function unlock() {
    if (!window.confirm('Unlock all locked events? They can then be moved or regenerated.')) return;
    try {
      const r = await scheduleApi.unlock(token);
      setFlash(`Unlocked ${r.unlocked} event(s).`);
      load();
    } catch (err) { setFlash(err.message); }
  }

  async function drop(row) {
    if (!window.confirm(`Remove ${row.event_code} ${row.event_name} from the schedule?`)) return;
    try {
      await scheduleApi.remove(token, row.id);
      setFlash(`Removed ${row.event_code} from the schedule.`);
      load();
    } catch (err) { setFlash(err.message); }
  }

  async function clearDrafts() {
    if (!window.confirm('Delete ALL draft (unlocked) schedule rows? Locked and confirmed rows are kept.')) return;
    try {
      const r = await scheduleApi.clearDrafts(token);
      setFlash(`Cleared ${r.cleared} draft row(s).`);
      load();
    } catch (err) { setFlash(err.message); }
  }

  async function cycleState(row) {
    const cur = row.is_locked ? 'locked' : row.looks_good ? 'looks_good' : 'draft';
    const next = cur === 'draft' ? 'looks_good' : cur === 'looks_good' ? 'locked' : 'draft';
    try { await scheduleApi.rowState(token, row.id, next); load(); }
    catch (err) { setFlash(err.message); }
  }

  async function removeGroup(row, code) {
    if (!window.confirm(`Remove age group ${code} from ${row.event_code} ${row.event_name}?`)) return;
    try {
      await scheduleApi.removeGroup(token, row.id, code);
      setFlash(`Removed ${code} from ${row.event_code}.`);
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
  const lockedCount = rows.filter((r) => r.is_locked).length;
  const pureDraftCount = rows.filter((r) => r.status === 'draft' && !r.is_locked && !r.looks_good).length;
  const unlockedCount = rows.filter((r) => !r.is_locked).length;

  return (
    <AdminLayout
      title="Schedule"
      subtitle="Auto-generate a draft over the competition window, adjust as needed, then publish. No participant is double-booked or given more than 2 events per day."
      actions={
        <>
          <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
          {canEdit && (
            <>
              <Button variant="outline" icon={Wand2} onClick={() => setShowGen((x) => !x)}>
                Generate draft…
              </Button>
              {pureDraftCount > 0 && (
                <Button variant="outline" icon={Trash2} onClick={clearDrafts}>
                  Clear drafts ({pureDraftCount})
                </Button>
              )}
              <Button variant="gold" icon={CheckCircle2} onClick={publish} disabled={draftCount === 0}>
                Publish schedule ({draftCount} draft)
              </Button>
              <Button variant="outline" icon={Lock} onClick={lock} disabled={unlockedCount === 0}>
                Lock phase
              </Button>
              {lockedCount > 0 && (
                <Button variant="ghost" icon={Unlock} onClick={unlock}>
                  Unlock ({lockedCount})
                </Button>
              )}
            </>
          )}
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
                  Report lead (min before turn)
                </label>
                <input type="number" min={0} value={buffer}
                  onChange={(e) => setBuffer(e.target.value)} className={`${inputCls} w-24`} />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Gap between events (min)
                </label>
                <input type="number" min={0} value={gap}
                  onChange={(e) => setGap(e.target.value)} className={`${inputCls} w-24`} />
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

            {catDates.length > 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-2">
                  Hold back categories (schedule in a later phase) — e.g. Dance until the India judges' dates are fixed
                </p>
                <div className="flex flex-wrap gap-2">
                  {catDates.map((c) => {
                    const held = excludeCats.has(c.id);
                    return (
                      <button key={c.id} type="button"
                        onClick={() => setExcludeCats((prev) => {
                          const n = new Set(prev);
                          if (n.has(c.id)) n.delete(c.id); else n.add(c.id);
                          return n;
                        })}
                        className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          held ? 'border-red-400 bg-red-50 text-red-700' : 'border-slate-300 text-slate-500 hover:bg-slate-100'}`}>
                        {held ? 'Held: ' : ''}{c.name}
                      </button>
                    );
                  })}
                </div>
                {excludeCats.size > 0 && (
                  <p className="mt-2 text-[11px] text-red-600">
                    Held back this run: {catDates.filter((c) => excludeCats.has(c.id)).map((c) => c.name).join(', ')}
                  </p>
                )}
              </div>
            )}

            {catDates.length > 0 && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs font-semibold text-slate-600 mb-2">
                  Earliest date per category (optional) — e.g. schedule dance late so kids get more practice time
                </p>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                  {catDates.map((c) => (
                    <div key={c.id}>
                      <label className="block text-xs font-medium text-slate-600 mb-1">{c.name}</label>
                      <input
                        type="date"
                        value={c.not_before_date || ''}
                        onChange={(e) =>
                          setCatDates((prev) =>
                            prev.map((x) => (x.id === c.id ? { ...x, not_before_date: e.target.value || null } : x))
                          )
                        }
                        className={inputCls}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="text-xs text-amber-600">
              Generating replaces only plain DRAFT rows; 'Looks good', locked and confirmed rows are kept
              and the new events are placed around them (still no clashes, max 2/day per child).
              Events only go in venues that suit their category, have capacity, and are open that day.
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
                          <th className="px-3 py-2">Group</th>
                          <th className="px-3 py-2">Participants</th>
                          <th className="px-3 py-2">Time allowed</th>
                          <th className="px-3 py-2">Reporting</th>
                          <th className="px-3 py-2">Status</th>
                          <th className="px-3 py-2 text-right">Actions</th>
                        </tr>
                      </thead>
                                            <tbody className="divide-y divide-slate-100">
                        {list.map((r) => {
                          const grp = perGroupRows(r, Number(buffer) || 30);
                          const n = grp.length;
                          const cur = r.is_locked ? 'locked' : r.looks_good ? 'looks_good' : 'draft';
                          const meta = {
                            draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200' },
                            looks_good: { label: 'Looks good', cls: 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100' },
                            locked: { label: 'Locked', cls: 'bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200' },
                          }[cur];
                          const statusCell = (
                            <div className="flex flex-col items-start gap-1">
                              {canEdit ? (
                                <button onClick={() => cycleState(r)}
                                  title="Click to cycle: Draft → Looks good → Locked (locked rows survive regeneration)"
                                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors ${meta.cls}`}>
                                  {cur === 'locked' && <Lock size={10} />}{meta.label}
                                </button>
                              ) : (
                                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>
                                  {cur === 'locked' && <Lock size={10} />}{meta.label}
                                </span>
                              )}
                              {r.status !== 'draft' && <span className="text-[10px] text-slate-400">{r.status}</span>}
                            </div>
                          );
                          return grp.map((g, gi) => (
                            <tr key={`${r.id}-${g.code}-${gi}`} className={`hover:bg-slate-50 ${r.is_locked ? 'bg-amber-50/50' : ''}`}>
                              {gi === 0 && (
                                <>
                                  <td rowSpan={n} className="px-3 py-2 font-mono text-xs align-top whitespace-nowrap">
                                    {(r.start_time || '').slice(0, 5)}–{(r.end_time || '').slice(0, 5)}
                                  </td>
                                  <td rowSpan={n} className="px-3 py-2 text-slate-600 align-top">{r.venue || '—'}</td>
                                  <td rowSpan={n} className="px-3 py-2 align-top">
                                    <span className="font-mono text-xs text-navy-700 mr-1.5">{r.event_code}</span>
                                    <span className="font-medium text-slate-800">{r.event_name}</span>
                                  </td>
                                </>
                              )}
                              <td className="px-3 py-2 whitespace-nowrap">
                                <span className="rounded bg-gold-100 text-gold-700 px-1.5 py-0.5 text-[10px] font-semibold">{g.code}</span>
                                {canEdit && (
                                  <button onClick={() => removeGroup(r, g.code)} title={`Remove ${g.code} from this event`}
                                    className="ml-1 text-slate-300 hover:text-red-500 text-sm font-bold leading-none align-middle">×</button>
                                )}
                              </td>
                              <td className="px-3 py-2"><Badge tone="navy">{g.entries}</Badge></td>
                              <td className="px-3 py-2 text-xs text-slate-600">{g.perMin ? `${g.perMin} min` : '—'}</td>
                              <td className="px-3 py-2 font-mono text-xs text-slate-700">{g.reportMin != null ? fmtMin(g.reportMin) : '—'}</td>
                              {gi === 0 && (
                                <>
                                  <td rowSpan={n} className="px-3 py-2 align-top">{statusCell}</td>
                                  <td rowSpan={n} className="px-3 py-2 text-right align-top">
                                    {canEdit ? (
                                      <div className="flex items-center justify-end gap-2">
                                        <RowEditor row={r} token={token} onSaved={load} />
                                        <button onClick={() => drop(r)} title="Remove this event from the schedule"
                                          className="text-xs font-medium text-red-600 hover:text-red-700 inline-flex items-center gap-0.5">
                                          <Trash2 size={12} /> Remove
                                        </button>
                                      </div>
                                    ) : null}
                                  </td>
                                </>
                              )}
                            </tr>
                          ));
                        })}
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
