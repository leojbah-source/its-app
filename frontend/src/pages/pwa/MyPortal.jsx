// src/pages/pwa/MyPortal.jsx
// Participant's personal view (rule #23): per-event grade/rank pts/grade pts +
// running totals, plus their personal schedule. NO chest numbers (rule #22).
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { LogOut, Trophy, CalendarDays, Radio } from 'lucide-react';
import { usePwaAuth } from '../../context/PwaAuthContext';
import { pwaApi } from '../../api/client';
import BrandMark from '../../components/ui/BrandMark';

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const EXTRA = { additional_3rd: 'Additional 3rd', consolation: 'Consolation' };
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');

export default function MyPortal() {
  const { token, participant, logout } = usePwaAuth();
  const [results, setResults] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    pwaApi.myResults(token).then(setResults).catch((e) => setErr(e.message));
    pwaApi.mySchedule(token).then(setSchedule).catch(() => {});
  }, [token]);

  const t = results?.totals;
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <BrandMark className="h-9 w-9 rounded-lg shrink-0" fallback={Trophy} fallbackSize={18} />
            <div>
              <div className="text-base font-bold text-navy-800 leading-tight">{participant?.name || 'My Results'}</div>
              {participant?.ageGroup && <div className="text-[11px] text-slate-500">{participant.ageGroup}</div>}
            </div>
          </div>
          <button onClick={logout} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600">
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-4">
        {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        {t && (
          <div className="mb-4 grid grid-cols-3 gap-2">
            {[['Rank', t.rank_points], ['Grade', t.grade_points], ['Total', t.total_points]].map(([label, val]) => (
              <div key={label} className="rounded-xl border border-slate-200 bg-white px-2 py-3 text-center">
                <div className="text-lg font-bold text-navy-800">{Number(val || 0).toFixed(1)}</div>
                <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
              </div>
            ))}
          </div>
        )}

        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-navy-800"><Trophy size={15} /> My results</h2>
        {results && results.results.length === 0 && <p className="mb-4 rounded-xl border border-dashed border-slate-300 bg-white py-8 text-center text-sm text-slate-400">No published results yet.</p>}
        {results && results.results.length > 0 && (
          <div className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <ul className="divide-y divide-slate-100">
              {results.results.map((r, i) => (
                <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="w-6 text-center text-lg">{MEDAL[r.prize_place] || ''}</span>
                  <span className="flex-1">
                    <span className="text-sm font-medium text-slate-800">{r.event_name}</span>
                    <span className="block text-[11px] text-slate-400">{[r.category, r.age_group].filter(Boolean).join(' · ')}{r.extra_prize_type ? ` · ${EXTRA[r.extra_prize_type]}` : ''}</span>
                  </span>
                  {r.grade && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-navy-700">{r.grade}</span>}
                  <span className="w-10 text-right text-sm font-semibold text-navy-800">{Number(r.total_points || 0).toFixed(1)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <h2 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-navy-800"><CalendarDays size={15} /> My schedule</h2>
        {schedule.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 bg-white py-8 text-center text-sm text-slate-400">No scheduled events yet.</p>
          : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <ul className="divide-y divide-slate-100">
                {schedule.map((s, i) => (
                  <li key={i} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-sm font-semibold text-navy-800">{s.event_name}{s.is_team_event && <span className="ml-2 rounded bg-gold-100 px-1.5 py-0.5 text-[10px] font-medium text-gold-700">TEAM</span>}</span>
                      {s.scheduled && <span className="shrink-0 text-xs text-slate-500">{fmtDate(s.event_date)}</span>}
                    </div>
                    {s.scheduled ? (
                      <div className="mt-1 flex items-center justify-between gap-2">
                        <span className="text-xs text-slate-500">{s.venue || ''}</span>
                        <span className="text-xs text-slate-700">report by <b className="font-mono text-navy-800">{s.report || '—'}</b></span>
                      </div>
                    ) : (
                      <div className="mt-1 text-xs text-slate-400">Schedule to be announced</div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

        <Link to="/live" className="mt-5 flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 hover:bg-amber-100">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white"><Radio size={16} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-navy-800">Live event progress</span>
            <span className="block text-[11px] text-slate-500">Where each group has reached on stage, by chest number</span>
          </span>
        </Link>

        <div className="mt-5 text-center">
          <Link to="/pwa" className="text-sm text-slate-500 hover:text-navy-700">Public results board →</Link>
        </div>
      </main>
    </div>
  );
}
