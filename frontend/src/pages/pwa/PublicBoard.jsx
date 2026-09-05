// src/pages/pwa/PublicBoard.jsx
// Public, no-login board: published results (chest + name) and the confirmed
// schedule. Mobile-first. Links to the participant login for personal results.
// (Awards are intentionally NOT shown here — announced separately after contests.)
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, CalendarDays, UserRound, Megaphone } from 'lucide-react';
import { publicApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const fmtTime = (t) => (t ? String(t).slice(0, 5) : '');

export default function PublicBoard() {
  const [year, setYear] = useState(null);
  const [tab, setTab] = useState('results');
  const [results, setResults] = useState([]);
  const [schedule, setSchedule] = useState([]);
  const [notices, setNotices] = useState([]);
  const [err, setErr] = useState('');

  useEffect(() => { publicApi.year().then(setYear).catch(() => {}); }, []);
  useEffect(() => { publicApi.notices().then(setNotices).catch(() => {}); }, []);
  useEffect(() => {
    setErr('');
    if (tab === 'results') publicApi.results().then(setResults).catch((e) => setErr(e.message));
    if (tab === 'schedule') publicApi.schedule().then(setSchedule).catch((e) => setErr(e.message));
  }, [tab]);

  const resultGroups = useMemo(() => {
    const map = new Map();
    for (const r of results) {
      const key = `${r.event_name} · ${r.age_group || ''}`;
      if (!map.has(key)) map.set(key, { key, event_name: r.event_name, age_group: r.age_group, rows: [] });
      map.get(key).rows.push(r);
    }
    for (const g of map.values()) g.rows.sort((a, b) => (a.rank || 99) - (b.rank || 99) || (a.child_name || '').localeCompare(b.child_name || ''));
    return [...map.values()];
  }, [results]);

  const TabBtn = ({ id, icon: Icon, label }) => (
    <button onClick={() => setTab(id)}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${tab === id ? 'bg-navy-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}>
      <Icon size={16} /> {label}
    </button>
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            {asset(year?.kca_logo_url) && <img src={asset(year.kca_logo_url)} alt="KCA" className="h-10 w-auto object-contain" />}
            <div>
              <div className="text-base font-bold text-navy-800 leading-tight">{year?.event_year_label || 'KCA Indian Talent Scan'}</div>
              <div className="text-[11px] text-slate-500">Results & Schedule</div>
            </div>
          </div>
          <Link to="/pwa/login" className="inline-flex items-center gap-1 rounded-lg bg-gold-500 px-3 py-1.5 text-xs font-semibold text-white">
            <UserRound size={14} /> My results
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-4">
        {notices.length > 0 && (
          <div className="mb-4 space-y-2">
            {notices.map((n) => (
              <div key={n.id} className="flex gap-2 rounded-xl border border-gold-200 bg-gold-50 px-3 py-2">
                <Megaphone size={16} className="mt-0.5 shrink-0 text-gold-600" />
                <div>
                  <div className="text-sm font-semibold text-navy-800">{n.title}</div>
                  {n.body && <div className="text-xs text-slate-600 whitespace-pre-wrap">{n.body}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="mb-4 flex gap-2">
          <TabBtn id="results" icon={Trophy} label="Results" />
          <TabBtn id="schedule" icon={CalendarDays} label="Schedule" />
        </div>

        {err && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}

        {tab === 'results' && (
          resultGroups.length === 0 ? <Empty text="No results published yet." />
          : resultGroups.map((g) => (
            <section key={g.key} className="mb-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-navy-800">
                {g.event_name} {g.age_group && <span className="text-slate-400">· {g.age_group}</span>}
              </div>
              <ul className="divide-y divide-slate-100">
                {g.rows.map((r, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2">
                    <span className="w-6 text-center text-lg">{MEDAL[r.rank] || <span className="text-xs text-slate-300">{r.rank || '—'}</span>}</span>
                    <span className="w-12 shrink-0 font-mono text-xs text-slate-500">#{r.chest_number}</span>
                    <span className="flex-1 text-sm font-medium text-slate-800">{r.child_name}{r.school && <span className="block text-[11px] font-normal text-slate-400">{r.school}</span>}</span>
                    {r.grade && <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-navy-700">{r.grade}</span>}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}

        {tab === 'schedule' && (
          schedule.length === 0 ? <Empty text="No confirmed schedule yet." />
          : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <ul className="divide-y divide-slate-100">
                {schedule.map((s, i) => (
                  <li key={i} className="px-4 py-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-navy-800">{s.event_name}{s.is_team_event && <span className="ml-2 rounded bg-gold-100 px-1.5 py-0.5 text-[10px] font-medium text-gold-700">TEAM</span>}</span>
                      <span className="text-xs text-slate-500">{fmtDate(s.event_date)}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {[s.category, s.age_groups].filter(Boolean).join(' · ')}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-600">
                      {[s.venue, (s.start_time || s.end_time) ? `${fmtTime(s.start_time)}${s.end_time ? '–' + fmtTime(s.end_time) : ''}` : s.slot_label].filter(Boolean).join(' · ')}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )
        )}
      </main>
    </div>
  );
}

function Empty({ text }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-white py-12 text-center text-sm text-slate-400">{text}</div>;
}
