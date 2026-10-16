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
// Expand a schedule row into one entry per age group (participants + per-head
// time allowed). Reporting time is per EVENT, computed separately.
function perGroupRows(r) {
  const groups = (r.groups && r.groups.length)
    ? r.groups
    : [{ code: r.age_groups || '—', entries: r.entries }];
  const perMin = r.allotted_time_seconds ? Math.round((r.allotted_time_seconds / 60) * 10) / 10 : null;
  return groups.map((g) => ({ ...g, perMin }));
}

// Reporting time per event: the FIRST event in a venue each day reports 15 min
// before it starts; every following event reports 30 min before the previous
// event's scheduled end. Returns { [scheduleRowId]: reportingMinutes }.
function computeReporting(rows) {
  const byVenueDay = {};
  rows.forEach((r) => {
    const k = `${String(r.event_date).slice(0, 10)}|${r.venue || ''}`;
    (byVenueDay[k] ??= []).push(r);
  });
  const map = {};
  // Reporting = 15 minutes before each event's OWN start time, so changing an
  // event's time immediately moves its reporting time.
  Object.values(byVenueDay).forEach((list) => {
    list.forEach((r) => {
      const start = r.start_time ? toMin(r.start_time) : null;
      map[r.id] = start == null ? null : start - 15;
    });
  });
  return map;
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
    if (!f.start_time || !f.end_time) { alert('Enter both a start time and an end time.'); return; }
    if (f.end_time <= f.start_time) { alert('The end time must be AFTER the start time. (For 2:00 pm to 3:30 pm use 14:00 and 15:30.)'); return; }
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
  const isSuper = user?.role === 'SuperAdmin';
  const canChange = (r) => canEdit && (!(r.status === 'confirmed' || r.status === 'completed') || isSuper);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [unplaced, setUnplaced] = useState([]);

  // Draft-generation inputs (venues + availability come from the facility
  // setup in Year Setup; here we only pick the window + buffer)
  const [showGen, setShowGen] = useState(false);
  const [showPub, setShowPub] = useState(false);
  const [pubDate, setPubDate] = useState('');
  const [venues, setVenues] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [buffer, setBuffer] = useState(30);
  const [gap, setGap] = useState(15);
  const [q, setQ] = useState('');  // schedule search/lookup
  const [maxGroups, setMaxGroups] = useState(3);
  const [catDates, setCatDates] = useState([]);  // [{id,code,name,not_before_date}]
  const [generating, setGenerating] = useState(false);
  const [excludeCats, setExcludeCats] = useState(() => new Set());
  const [reflowOnly, setReflowOnly] = useState(false);
  const [moveDates, setMoveDates] = useState({});  // date -> new date value
  const [addable, setAddable] = useState([]);       // unscheduled event cells
  const [addForms, setAddForms] = useState({});     // key -> { date, venue, start }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rowsData, venueData, catData, addableData] = await Promise.all([
        scheduleApi.list(token),
        venuesApi.list(token).catch(() => []),
        scheduleApi.categoryDates(token).catch(() => []),
        scheduleApi.addable(token).catch(() => []),
      ]);
      setRows(rowsData);
      setVenues(venueData);
      setCatDates(catData);
      setAddable(addableData || []);
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
        reflow_only: reflowOnly,
      });
      setFlash(`Draft generated: ${r.scheduled} events placed${r.unplaced.length ? `, ${r.unplaced.length} could not be placed` : ''}.`);
      setUnplaced(r.unplaced || []);
      setShowGen(false);
      load();
    } catch (err) { setFlash(err.message); }
    finally { setGenerating(false); }
  }

  const pubCount = rows.filter((r) => r.is_locked && r.status === 'draft'
    && (!pubDate || String(r.event_date).slice(0, 10) <= pubDate)).length;
  async function publish() {
    if (pubCount === 0) { setFlash('No Locked rows to publish for that cut-off. Lock the day(s) you want to publish first.'); return; }
    if (!window.confirm(`Publish ${pubCount} locked event row(s)${pubDate ? ` up to and including ${pubDate}` : ''}? They appear on the participants’ page and can then be changed only by the SuperAdmin.`)) return;
    try {
      const r = await scheduleApi.publish(token, pubDate || undefined);
      setFlash(`Published ${r.confirmed} event(s)${r.cutoff_date ? ` up to ${r.cutoff_date}` : ''}.`);
      setShowPub(false);
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

  async function moveDay(date) {
    const to = moveDates[date];
    if (!to) return;
    let warn = [];
    try { const c = await scheduleApi.moveDateCheck(token, date, to); warn = c.warnings || []; } catch { /* check is best-effort */ }
    const base = `Move ALL events on ${date} to ${to}? Each event keeps its venue and times.`;
    const shown = warn.slice(0, 12).join('\n• ');
    const msg = warn.length
      ? `${base}\n\n⚠ ${warn.length} possible clash(es) on ${to}:\n• ${shown}${warn.length > 12 ? `\n…and ${warn.length - 12} more` : ''}\n\nProceed anyway?`
      : base;
    if (!window.confirm(msg)) return;
    setFlash('');
    try {
      const r = await scheduleApi.moveDate(token, date, to);
      setFlash(`Moved ${r.moved} event row(s) from ${date} to ${to}.`);
      setMoveDates((m) => { const n = { ...m }; delete n[date]; return n; });
      load();
    } catch (e) { setFlash(e.message); }
  }

  function stateFlags(state) {
    if (state === 'locked') return { is_locked: true, looks_good: true };
    if (state === 'looks_good') return { is_locked: false, looks_good: true };
    return { is_locked: false, looks_good: false };
  }
  async function setDayState(date, state) {
    const flags = stateFlags(state);
    setRows((rs) => rs.map((x) => (String(x.event_date).slice(0, 10) === date ? { ...x, ...flags } : x)));
    try { await scheduleApi.dateState(token, date, state); }
    catch (e) { setFlash(e.message); load(); }
  }
  async function addRow(cell) {
    const key = `${cell.event_id}:${cell.ag_code}`;
    const form = addForms[key] || {};
    if (!form.date || !form.venue || !form.start) { setFlash('Pick a date, venue and start time to add the event.'); return; }
    setFlash('');
    try {
      const r = await scheduleApi.addRow(token, { event_id: cell.event_id, age_group_code: cell.ag_code,
        event_date: form.date, venue: form.venue, start_time: form.start });
      setFlash(`Added ${cell.event_code} [${cell.ag_code}] on ${form.date} (${r.start_time}–${r.end_time}). Use Adjust to fine-tune.`);
      setAddForms((m) => { const n = { ...m }; delete n[key]; return n; });
      load();
    } catch (e) { setFlash(e.message); }
  }

  async function combineRows(row) {
    if (!window.confirm(`Combine all rows of ${row.event_code} ${row.event_name} on this date into ONE event (all age groups together) at ${row.venue || 'this venue'} ${(row.start_time || '').slice(0, 5)}–${(row.end_time || '').slice(0, 5)}?`)) return;
    setFlash('');
    try { const r = await scheduleApi.combine(token, row.id); setFlash(`Combined into one event — groups ${r.age_groups}.`); load(); }
    catch (e) { setFlash(e.message); }
  }

  async function unpublishRow(row) {
    if (!window.confirm(`Unpublish ${row.event_code} ${row.event_name}? It goes back to Locked (draft) so you can edit it, and disappears from the participants’ page until you publish again.`)) return;
    setFlash('');
    try { await scheduleApi.unpublish(token, row.id); setFlash(`${row.event_code} unpublished — it is back to Locked (not visible to participants).`); load(); }
    catch (e) { setFlash(e.message); }
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
    const flags = stateFlags(next);
    setRows((rs) => rs.map((x) => (x.id === row.id ? { ...x, ...flags } : x)));
    try { await scheduleApi.rowState(token, row.id, next); }
    catch (err) { setFlash(err.message); load(); }
  }

  async function removeGroup(row, code) {
    if (!window.confirm(`Remove age group ${code} from ${row.event_code} ${row.event_name}?`)) return;
    try {
      await scheduleApi.removeGroup(token, row.id, code);
      setFlash(`Removed ${code} from ${row.event_code}.`);
      load();
    } catch (err) { setFlash(err.message); }
  }

  const reportingById = computeReporting(rows);
  const eventDateCounts = rows.reduce((acc, r) => { const k = `${String(r.event_date).slice(0, 10)}|${r.event_id}`; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  // group rows by date (filtered by the search box)
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? rows.filter((r) => `${r.event_code} ${r.event_name} ${r.venue} ${r.age_groups}`.toLowerCase().includes(ql))
    : rows;
  const addableMatches = ql
    ? addable.filter((a) => `${a.event_code} ${a.event_name} ${a.ag_code}`.toLowerCase().includes(ql))
    : [];
  const byDate = filtered.reduce((acc, r) => {
    const d = String(r.event_date).slice(0, 10);
    (acc[d] ??= []).push(r);
    return acc;
  }, {});
  const lockedDraftCount = rows.filter((r) => r.status === 'draft' && r.is_locked).length;
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
              <Button variant="gold" icon={CheckCircle2} onClick={() => setShowPub((v) => !v)} disabled={lockedDraftCount === 0}>
                Publish locked… ({lockedDraftCount})
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

            <label className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700">
              <input type="checkbox" checked={reflowOnly} onChange={(e) => setReflowOnly(e.target.checked)} className="mt-0.5" />
              <span><b>Re-flow current draft rows only</b> — don’t add any new events. Use this after fixing a few items: the scheduler re-places what is already in Draft and will not pull in events you removed or newly-eligible ones.</span>
            </label>
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

      {canEdit && showPub && (
        <Card>
          <div className="space-y-2">
            <div className="text-sm font-semibold text-navy-800">Publish locked schedule</div>
            <p className="text-xs text-slate-500">
              Only <b>Locked</b> rows are published. Pick a cut-off date to publish locked rows up to &amp; including that day (leave blank for all locked rows).
              Published events appear on the participants’ page and can then be changed only by the <b>SuperAdmin</b>.
            </p>
            <label className="block text-xs text-slate-600">
              Publish locked rows up to &amp; including:
              <input type="date" value={pubDate} min="2024-01-01" max="2100-12-31"
                onChange={(e) => setPubDate(e.target.value)} className={`${inputCls} mt-1`} />
            </label>
            <div className="text-xs font-medium text-navy-700">{pubCount} locked row(s) will be published{pubDate ? ` (on/before ${pubDate})` : ''}.</div>
            <div className="flex gap-2 pt-1">
              <Button variant="gold" icon={CheckCircle2} onClick={publish} disabled={pubCount === 0}>Publish {pubCount} now</Button>
              <Button variant="outline" onClick={() => setShowPub(false)}>Cancel</Button>
            </div>
          </div>
        </Card>
      )}
      {rows.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Find an event (code, name, venue, group)…"
            className={`${inputCls} w-full max-w-md`} />
          {q && <button onClick={() => setQ('')} className="text-xs text-slate-500 underline">clear</button>}
          {q && <span className="text-xs text-slate-500">{filtered.length} of {rows.length} rows</span>}
        </div>
      )}
      {canEdit && ql && addableMatches.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
          <div className="mb-2 text-xs font-semibold text-amber-800">
            Not yet scheduled — matching &ldquo;{q}&rdquo; ({addableMatches.length}). Includes events that were removed or could not be placed. Pick a date, venue &amp; start to add.
          </div>
          <div className="space-y-2">
            {addableMatches.map((cell) => {
              const key = `${cell.event_id}:${cell.ag_code}`;
              const form = addForms[key] || {};
              return (
                <div key={key} className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="min-w-[230px]">
                    <span className="font-mono text-navy-500">{cell.event_code}</span> {cell.event_name}
                    <span className="ml-1 rounded bg-navy-50 px-1.5 py-0.5 text-[10px] font-semibold text-navy-700">{cell.ag_code}</span>
                    <span className="ml-1 text-slate-400">· {cell.entries} entries</span>
                  </span>
                  <input type="date" value={form.date || ''} min="2024-01-01" max="2100-12-31"
                    onChange={(e) => setAddForms((m) => ({ ...m, [key]: { ...form, date: e.target.value } }))}
                    className="rounded border border-slate-300 px-1.5 py-0.5" />
                  <select value={form.venue || ''}
                    onChange={(e) => setAddForms((m) => ({ ...m, [key]: { ...form, venue: e.target.value } }))}
                    className="rounded border border-slate-300 px-1.5 py-0.5">
                    <option value="">Venue…</option>
                    {venues.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
                  </select>
                  <input type="time" value={form.start || ''}
                    onChange={(e) => setAddForms((m) => ({ ...m, [key]: { ...form, start: e.target.value } }))}
                    className="rounded border border-slate-300 px-1.5 py-0.5" />
                  <button onClick={() => addRow(cell)}
                    className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 hover:bg-emerald-100">Add</button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Card>
        {loading ? <PageLoader label="Loading schedule…" />
          : error ? <ErrorBanner message={error} onRetry={load} />
          : rows.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">
              No schedule yet — use "Generate draft…" once registrations are closed.
            </p>
          ) : Object.keys(byDate).length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">No events match "{q}".</p>
          ) : (
            <div className="space-y-6">
              {Object.entries(byDate).map(([date, list]) => (
                <div key={date}>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-navy-800">
                      {new Date(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                    </h3>
                    {canEdit && (
                      <div className="flex items-center gap-1.5 text-[11px]">
                        <span className="text-slate-400">Mark whole day:</span>
                        <button onClick={() => setDayState(date, 'looks_good')} className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 hover:bg-emerald-100">Looks good</button>
                        <button onClick={() => setDayState(date, 'locked')} className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 font-medium text-amber-700 hover:bg-amber-100">Lock</button>
                        <button onClick={() => setDayState(date, 'draft')} className="rounded border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-500 hover:bg-slate-50">Reset to draft</button>
                        <span className="ml-2 flex items-center gap-1">
                          <span className="text-slate-400">Move day to:</span>
                          <input type="date" value={moveDates[date] || ''} min="2024-01-01" max="2100-12-31"
                            onChange={(e) => setMoveDates((m) => ({ ...m, [date]: e.target.value }))}
                            className="rounded border border-slate-300 px-1.5 py-0.5 text-[11px]" />
                          <button onClick={() => moveDay(date)} disabled={!moveDates[date]}
                            className="rounded border border-navy-300 bg-navy-50 px-2 py-0.5 font-medium text-navy-700 hover:bg-navy-100 disabled:opacity-40">Move</button>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="overflow-x-auto rounded-lg border border-slate-200">
                    <table className="w-full min-w-[760px] text-sm">
                      <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <tr>
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
                          const grp = perGroupRows(r);
                          const n = grp.length;
                          const cur = r.is_locked ? 'locked' : r.looks_good ? 'looks_good' : 'draft';
                          const meta = {
                            draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200' },
                            looks_good: { label: 'Looks good', cls: 'bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100' },
                            locked: { label: 'Locked', cls: 'bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200' },
                          }[cur];
                          const published = r.status === 'confirmed' || r.status === 'completed';
                          const statusCell = (
                            <div className="flex flex-col items-start gap-1">
                              {published ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-blue-300 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700">
                                  <Lock size={10} /> Published
                                </span>
                              ) : canEdit ? (
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
                              {published && isSuper && <span className="text-[10px] text-slate-400">SuperAdmin can still edit</span>}
                            </div>
                          );
                          return grp.map((g, gi) => (
                            <tr key={`${r.id}-${g.code}-${gi}`} className={`hover:bg-slate-50 ${r.is_locked ? 'bg-amber-50/50' : ''}`}>
                              {gi === 0 && (
                                <>
                                  <td rowSpan={n} className="px-3 py-2 text-slate-600 align-top">{r.venue || '—'}</td>
                                  <td rowSpan={n} className="px-3 py-2 align-top">
                                    <span className="font-mono text-xs text-navy-700 mr-1.5">{r.event_code}</span>
                                    <span className="font-medium text-slate-800">{r.event_name}</span>
                                  </td>
                                </>
                              )}
                              <td className="px-3 py-2 whitespace-nowrap">
                                <span className="rounded bg-gold-100 text-gold-700 px-1.5 py-0.5 text-[10px] font-semibold">{g.code}</span>
                                {canChange(r) && (
                                  <button onClick={() => removeGroup(r, g.code)} title={`Remove ${g.code} from this event`}
                                    className="ml-1 text-slate-300 hover:text-red-500 text-sm font-bold leading-none align-middle">×</button>
                                )}
                              </td>
                              <td className="px-3 py-2"><Badge tone="navy">{g.entries}</Badge></td>
                              <td className="px-3 py-2 text-xs text-slate-600">{g.perMin ? `${g.perMin} min` : '—'}</td>
                              {gi === 0 && (
                                <>
                                  <td rowSpan={n} className="px-3 py-2 font-mono text-xs align-top">
                                    {reportingById[r.id] != null ? fmtMin(reportingById[r.id]) : '—'}
                                    {(r.start_time || r.end_time) && (
                                      <div className="text-[10px] font-normal text-slate-400">runs {(r.start_time || '').slice(0, 5)}–{(r.end_time || '').slice(0, 5)}</div>
                                    )}
                                  </td>
                                  <td rowSpan={n} className="px-3 py-2 align-top">{statusCell}</td>
                                  <td rowSpan={n} className="px-3 py-2 text-right align-top">
                                    {canChange(r) ? (
                                      <div className="flex items-center justify-end gap-2">
                                        {eventDateCounts[`${String(r.event_date).slice(0, 10)}|${r.event_id}`] > 1 && (
                                          <button onClick={() => combineRows(r)} title="Combine the other row(s) of this event on this date into one"
                                            className="text-xs font-medium text-navy-600 hover:text-navy-700 underline">Combine</button>
                                        )}
                                        <RowEditor row={r} token={token} onSaved={load} />
                                        <button onClick={() => drop(r)} title="Remove this event from the schedule"
                                          className="text-xs font-medium text-red-600 hover:text-red-700 inline-flex items-center gap-0.5">
                                          <Trash2 size={12} /> Remove
                                        </button>
                                      </div>
                                    ) : published && isSuper ? (
                                      <button onClick={() => unpublishRow(r)} title="Pull this published row back to draft (SuperAdmin)"
                                        className="text-xs font-medium text-blue-600 hover:text-blue-700 inline-flex items-center gap-0.5">
                                        <Unlock size={12} /> Unpublish
                                      </button>
                                    ) : published ? (
                                      <span className="text-[10px] text-slate-400">published</span>
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
