// src/pages/LiveProgress.jsx
// Day-wide LIVE PROGRESS — where every group has reached, from the Timer.
// Read-only, auto-refreshing. No MC/Timer login needed.
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { RefreshCw, Radio, CheckCircle2, Circle, ChevronDown } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { useAuth } from '../context/AuthContext';
import { liveApi } from '../api/client';
import { pickDefaultDate } from '../utils/dates';

const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';
const fmtClock = (secs) => { const s = Math.max(0, secs); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(ss).padStart(2, '0')}`; };
const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const STATE = {
  finished: { label: 'Finished', tone: 'success' },
  running: { label: 'On stage', tone: 'warning' },
  in_progress: { label: 'In progress', tone: 'navy' },
  not_started: { label: 'Not started', tone: 'neutral' },
  empty: { label: 'No performers', tone: 'neutral' },
};

export default function LiveProgress() {
  const { token } = useAuth();
  const [dates, setDates] = useState([]);
  const [date, setDate] = useState('');
  const [groups, setGroups] = useState([]);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const timer = useRef(null);
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, []);

  useEffect(() => { liveApi.dates(token).then(setDates).catch(() => {}); }, [token]);
  useEffect(() => { if (!date && dates.length) setDate(pickDefaultDate(dates)); }, [dates, date]);

  const load = useCallback(async () => {
    if (!date) return;
    try { setGroups(await liveApi.day(token, date)); setUpdatedAt(new Date()); setErr(''); }
    catch (e) { setErr(e.message); }
  }, [token, date]);

  // Load on date change + auto-refresh every 5s.
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
    <AdminLayout title="Live progress"
      subtitle="Where every group has reached, live from the Timer. Auto-refreshes."
      actions={<Button variant="outline" icon={RefreshCw} onClick={load}>Refresh now</Button>}>
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Date</label>
            <select value={date} onChange={(e) => setDate(e.target.value)} className={sel}>
              {dates.length === 0 && <option value="">No scheduled dates</option>}
              {dates.map((d) => <option key={d} value={d}>{new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</option>)}
            </select>
          </div>
          <div className="flex-1" />
          <div className="text-right text-xs text-slate-400">
            <div>{totals.groups} group(s) · {totals.finished} finished · {totals.running} on stage now</div>
            {updatedAt && <div>Updated {updatedAt.toLocaleTimeString('en-GB')}</div>}
          </div>
        </div>
      </Card>

      {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

      {groups.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white py-12 text-center text-sm text-slate-400">No scheduled groups for this date.</div>
      ) : (
        <div className="space-y-2.5">
          {groups.map((g) => {
            const published = !!g.published;
            const gt = g.group_timer;
            const gtRemaining = gt && gt.state === 'running'
              ? Math.max(0, Math.round((new Date(gt.ends_at).getTime() - Date.now()) / 1000)) : 0;
            const meta = published
              ? { label: 'Finished', tone: 'success' }      // published → show as finished with a full bar
              : gt
              ? (gt.state === 'running'
                  ? { label: gtRemaining <= 0 ? 'Time up' : 'In progress', tone: gtRemaining <= 0 ? 'danger' : 'warning' }
                  : { label: 'Finished', tone: 'success' })
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
                <button onClick={() => toggle(g.key)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-navy-800">
                      <span className="mr-1.5 font-mono text-xs text-navy-500">{g.event_code}</span>
                      {g.event_name}<span className="text-slate-400"> · {g.age_group_label || g.age_group_code}</span>
                    </div>
                    <div className="truncate text-[11px] text-slate-400">
                      {[g.venue, g.start_time && `starts ${g.start_time}`].filter(Boolean).join(' · ')}
                      {!timed && !gt && <span className="ml-1 text-slate-400">· timer not started</span>}
                      {gt && <span className="ml-1 text-slate-500">· {gt.state === 'running' ? `ends ${hhmm(gt.ends_at)}` : 'finished'}</span>}
                    </div>
                  </div>
                  {!gt && g.now && g.now.length > 0 && (
                    <span className="hidden sm:inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                      <Radio size={12} /> #{g.now[0].chest_number} {g.now[0].name?.split(' ')[0]}
                    </span>
                  )}
                  {gt && gt.state === 'running' && (
                    <span className={`shrink-0 font-mono text-sm font-bold tabular-nums ${gtRemaining <= 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                      {gtRemaining <= 0 ? 'TIME UP' : fmtClock(gtRemaining)}
                    </span>
                  )}
                  {!gt && <span className="shrink-0 text-xs font-medium text-slate-500">{g.done}/{g.total}</span>}
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <ChevronDown size={18} className={`shrink-0 text-slate-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                <div className="px-4 pb-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </div>
                {isOpen && gt && (
                  <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
                    Started {hhmm(gt.started_at)}
                    {' · '}
                    {gt.state === 'running'
                      ? `ends ${hhmm(gt.ends_at)} (${fmtClock(gtRemaining)} left)`
                      : (gt.ended_at ? `stopped early ${hhmm(gt.ended_at)}` : `ended ${hhmm(gt.ends_at)}`)}
                    {g.participants.length > 0 && <span className="ml-1 text-slate-400">· {g.participants.length} chest(s) in</span>}
                  </div>
                )}
                {isOpen && !gt && (
                  <ul className="divide-y divide-slate-100 border-t border-slate-100">
                    {g.participants.length === 0 && <li className="px-4 py-3 text-xs text-slate-400">No attended performers / chest numbers yet.</li>}
                    {g.participants.map((p) => (
                      <li key={p.registration_id} className={`flex items-center gap-3 px-4 py-2 ${p.status === 'running' ? 'bg-amber-50/60' : ''}`}>
                        <span className="w-10 shrink-0 font-mono text-xs text-slate-500">#{p.chest_number ?? '—'}</span>
                        <span className="flex-1 text-sm text-slate-800">{p.name}</span>
                        {pill(p)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </AdminLayout>
  );
}
