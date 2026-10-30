// src/components/LiveBoardInner.jsx
// Public, chest-only LIVE PROGRESS board for parents & participants. For each
// published group on a date it shows where the group has reached — from the
// Timer — as pending → on stage → done. NO participant names are shown here
// (privacy); only chest numbers, so families can tell when their child's turn
// is near and when a group has finished. Auto-refreshes every 5s.
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { RefreshCw, Radio, CheckCircle2, Circle, ChevronDown } from 'lucide-react';
import { publicApi } from '../api/client';

const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';
const STATE = {
  finished: { label: 'Finished', cls: 'bg-emerald-100 text-emerald-700' },
  running: { label: 'On stage', cls: 'bg-amber-100 text-amber-700' },
  in_progress: { label: 'In progress', cls: 'bg-navy-100 text-navy-700' },
  not_started: { label: 'Not started', cls: 'bg-slate-100 text-slate-500' },
  empty: { label: 'No performers', cls: 'bg-slate-100 text-slate-500' },
};
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '');
const fmtClock = (secs) => { const x = Math.max(0, secs); const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), ss = x % 60; return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`; };
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function pickDefault(dates) {
  if (!dates || !dates.length) return '';
  const t = todayStr();
  if (dates.includes(t)) return t;
  const future = dates.filter((d) => d >= t);
  return future.length ? future[0] : dates[dates.length - 1];
}

export default function LiveBoardInner() {
  const [dates, setDates] = useState([]);
  const [date, setDate] = useState('');
  const [groups, setGroups] = useState([]);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const timer = useRef(null);
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  useEffect(() => { publicApi.liveDates().then(setDates).catch(() => {}); }, []);
  useEffect(() => { if (!date && dates.length) setDate(pickDefault(dates)); }, [dates, date]);

  const load = useCallback(async () => {
    if (!date) return;
    try { setGroups(await publicApi.liveDay(date)); setUpdatedAt(new Date()); setErr(''); }
    catch (e) { setErr(e.message); }
  }, [date]);

  useEffect(() => {
    load();
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(load, 5000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  const totals = useMemo(() => {
    const stage = groups.filter((g) => g.is_stage_event);
    return {
      groups: groups.length,
      finished: groups.filter((g) => g.state === 'finished').length,
      running: stage.filter((g) => g.state === 'running').length,
    };
  }, [groups]);

  const toggle = (k) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const pill = (p) => {
    if (p.status === 'done') return <span className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700"><CheckCircle2 size={11} /> done{p.over ? ' · over' : ''}</span>;
    if (p.status === 'running') return <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700"><Radio size={11} /> on stage</span>;
    return <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"><Circle size={10} /> waiting</span>;
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">Day</label>
          <select value={date} onChange={(e) => setDate(e.target.value)} className={sel}>
            {dates.length === 0 && <option value="">No published dates yet</option>}
            {dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
          </select>
        </div>
        <div className="flex-1" />
        <div className="text-right text-[11px] text-slate-400">
          <div>{totals.groups} group(s) · {totals.finished} finished · {totals.running} on stage now</div>
          {updatedAt && <div>Updated {updatedAt.toLocaleTimeString('en-GB')} · refreshes automatically</div>}
        </div>
      </div>

      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-12 text-center text-sm text-slate-400">
          Nothing scheduled to show for this day yet.
        </div>
      ) : (
        <div className="space-y-2.5">
          {groups.map((g) => {
            const published = !!g.published;
            const gt = g.group_timer;
            const gtRemaining = gt && gt.state === 'running'
              ? Math.max(0, Math.round((new Date(gt.ends_at).getTime() - Date.now()) / 1000)) : 0;
            const meta = published
              ? { label: 'Finished', cls: 'bg-emerald-100 text-emerald-700' }
              : gt
              ? (gt.state === 'running'
                  ? { label: gtRemaining <= 0 ? 'Time up' : 'In progress', cls: gtRemaining <= 0 ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700' }
                  : { label: 'Finished', cls: 'bg-emerald-100 text-emerald-700' })
              : (STATE[g.state] || STATE.not_started);
            const pct = published
              ? 100
              : gt
              ? (gt.state === 'running' ? Math.min(100, Math.max(0, 100 * (1 - gtRemaining / Math.max(1, gt.duration_seconds)))) : 100)
              : (g.total ? Math.round((g.done / g.total) * 100) : 0);
            const isOpen = open.has(g.key);
            const timed = g.is_stage_event;
            return (
              <section key={g.key} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                <button onClick={() => toggle(g.key)} className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-navy-800">
                      <span className="mr-1.5 font-mono text-xs text-navy-500">{g.event_code}</span>
                      {g.event_name}<span className="text-slate-400"> · {g.age_group_label || g.age_group_code}</span>
                    </div>
                    <div className="truncate text-[11px] text-slate-400">
                      {[g.venue, g.start_time && `starts ${g.start_time}`].filter(Boolean).join(' · ')}
                      {!timed && !gt && <span className="ml-1 text-slate-400">· not started</span>}
                      {gt && <span className="ml-1 text-slate-500">· {gt.state === 'running' ? `ends ${hhmm(gt.ends_at)}` : 'finished'}</span>}
                    </div>
                  </div>
                  {!gt && g.now && g.now.length > 0 && (
                    <span className="hidden xs:inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      <Radio size={12} /> #{g.now[0].chest_number}
                    </span>
                  )}
                  {gt && gt.state === 'running' && (
                    <span className={`shrink-0 font-mono text-sm font-bold tabular-nums ${gtRemaining <= 0 ? 'text-red-600' : 'text-amber-700'}`}>
                      {gtRemaining <= 0 ? 'TIME UP' : `${fmtClock(gtRemaining)}`}
                    </span>
                  )}
                  {!gt && <span className="shrink-0 text-xs font-medium text-slate-500">{g.done}/{g.total}</span>}
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${meta.cls}`}>{meta.label}</span>
                  <ChevronDown size={18} className={`shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                <div className="px-4 pb-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                {isOpen && gt && (
                  <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
                    {gt.state === 'running'
                      ? <>In progress — started {hhmm(gt.started_at)}, finishes about <b>{hhmm(gt.ends_at)}</b> ({fmtClock(gtRemaining)} left).</>
                      : <>Finished{gt.ended_at ? ` (ended early at ${hhmm(gt.ended_at)})` : ` at ${hhmm(gt.ends_at)}`}.</>}
                  </div>
                )}
                {isOpen && !gt && (
                  <ul className="flex flex-wrap gap-1.5 border-t border-slate-100 px-4 py-3">
                    {g.participants.length === 0 && <li className="text-xs text-slate-400">No chest numbers on stage yet for this group.</li>}
                    {g.participants.map((p) => (
                      <li key={p.chest_number}
                        className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-mono ${
                          p.status === 'done' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : p.status === 'running' ? 'border-amber-300 bg-amber-100 text-amber-800 font-semibold'
                          : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                        #{p.chest_number ?? '—'}
                        {p.status === 'done' && <CheckCircle2 size={11} />}
                        {p.status === 'running' && <Radio size={11} />}
                      </li>
                    ))}
                  </ul>
                )}
                {isOpen && !gt && (
                  <div className="flex flex-wrap gap-3 border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400">
                    <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-slate-200" /> waiting</span>
                    <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-amber-300" /> on stage</span>
                    <span className="inline-flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded bg-emerald-300" /> done</span>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
