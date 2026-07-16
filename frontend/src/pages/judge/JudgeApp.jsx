// src/pages/judge/JudgeApp.jsx
// Judge portal. After login the BRIEFING sheet shows first (criteria + agree the
// weightages, per the 2024 briefing sheet), then Continue → pick one group →
// scoresheet grid (chest rows × criteria cols + live Total + Rank). Scores can't
// exceed a criterion's weightage; all judges must agree before scoring opens.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gavel, LogOut, ChevronLeft, Sliders, Save, Check, Lock, ArrowRight } from 'lucide-react';
import { useJudgeAuth } from '../../context/JudgeAuthContext';
import { judgeApi } from '../../api/client';

const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`);

export default function JudgeApp() {
  const { token, judge, logout } = useJudgeAuth();
  const [events, setEvents] = useState([]);
  const [current, setCurrent] = useState(null);
  const [phase, setPhase] = useState('briefing'); // 'briefing' | 'score'
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState(null);
  const [flash, setFlash] = useState('');

  async function openEvent(ev) {
    setCurrent(ev); setPhase('briefing'); setGroups([]); setGroupId(null); setFlash('');
    try { setGroups(await judgeApi.groups(token, ev.assignment_id)); } catch (e) { setFlash(e.message); }
  }
  const loadEvents = useCallback(async () => {
    try { const evs = await judgeApi.events(token); setEvents(evs); if (evs.length === 1) openEvent(evs[0]); }
    catch (e) { setFlash(e.message); }
  }, [token]);
  useEffect(() => { loadEvents(); /* eslint-disable-next-line */ }, []);
  const reloadGroups = useCallback(() => { if (current) judgeApi.groups(token, current.assignment_id).then(setGroups).catch(() => {}); }, [token, current]);

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-navy-800 px-4 py-3 text-white">
        <div className="flex items-center gap-2"><Gavel size={20} className="text-gold-400" /><span className="font-semibold">Judge Scoring</span></div>
        <div className="flex items-center gap-3 text-sm"><span className="text-navy-200">{judge?.name}</span>
          <button onClick={logout} className="inline-flex items-center gap-1 text-navy-100 hover:text-white"><LogOut size={16} /> Sign out</button></div>
      </header>
      <main className="mx-auto max-w-4xl p-4">
        {flash && <div className="mb-3 rounded-md border border-navy-200 bg-white px-3 py-2 text-sm text-navy-700">{flash}</div>}
        {!current ? <EventsList events={events} onOpen={openEvent} />
          : phase === 'briefing' ? <Briefing token={token} current={current} setFlash={setFlash}
              onBack={events.length > 1 ? () => setCurrent(null) : null} onContinue={() => setPhase('score')} />
          : !groupId ? <GroupPicker current={current} groups={groups} onBack={() => setPhase('briefing')} onPick={setGroupId} />
          : <ScoreGrid token={token} current={current} groupId={groupId} onBack={() => setGroupId(null)} setFlash={setFlash} reloadGroups={reloadGroups} />}
      </main>
    </div>
  );
}

function EventsList({ events, onOpen }) {
  if (!events.length) return <p className="py-10 text-center text-sm text-slate-500">No event is open for you right now. The organiser sends an OTP when your event is ready.</p>;
  return (
    <div className="space-y-2"><h1 className="mb-2 text-lg font-semibold text-navy-900">Your event</h1>
      {events.map((e) => (
        <button key={e.assignment_id} onClick={() => onOpen(e)} className="flex w-full items-center justify-between rounded-xl bg-white p-4 text-left shadow-sm hover:bg-slate-50">
          <div><div className="font-medium text-navy-800"><span className="font-mono text-xs text-navy-500 mr-1.5">{e.event_code}</span>{e.event_name}</div>
          <div className="text-xs text-slate-500">{e.category_name}</div></div><ChevronLeft className="rotate-180 text-slate-400" size={18} /></button>))}
    </div>
  );
}

function Briefing({ token, current, onBack, onContinue, setFlash }) {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editW, setEditW] = useState(false);
  const [wDraft, setWDraft] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { const b = await judgeApi.briefing(token, current.assignment_id); setBrief(b); setWDraft(b.criteria.map((c) => ({ id: c.id, label: c.label, max_score: Number(c.max_score) }))); }
    catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token, current]);
  useEffect(() => { load(); }, [load]);

  const wTotal = wDraft.reduce((t, c) => t + (Number(c.max_score) || 0), 0);
  async function saveWeights() {
    if (Math.round(wTotal) !== 100) { setFlash(`Weightages must total 100 (now ${wTotal}).`); return; }
    setBusy(true);
    try { const ordered = [...wDraft].sort((a, b) => b.max_score - a.max_score).map((c, i) => ({ id: c.id, max_score: c.max_score, sequence_order: i + 1 }));
      await judgeApi.setCriteria(token, current.assignment_id, ordered); setEditW(false); setFlash('Weightages saved — other judges must agree.'); load();
    } catch (e) { setFlash(e.message); } finally { setBusy(false); }
  }
  async function agree() {
    setBusy(true);
    try { await judgeApi.agreeCriteria(token, current.assignment_id); setFlash('You agreed the weightages.'); load(); }
    catch (e) { setFlash(e.message); } finally { setBusy(false); }
  }

  if (loading || !brief) return <p className="py-10 text-center text-sm text-slate-500">Loading briefing…</p>;
  const ev = brief.event || {};
  const ag = brief.agreement || {};
  const criteria = [...brief.criteria].sort((a, b) => a.sequence_order - b.sequence_order);

  return (
    <div>
      {onBack && <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> Events</button>}
      <div className="mb-3 rounded-xl bg-navy-700 p-4 text-white">
        <div className="text-xs uppercase tracking-wide text-navy-200">Judges' briefing</div>
        <div className="text-lg font-semibold">{ev.event_code} · {ev.event_name}</div>
        <div className="text-sm text-navy-200">{ev.category_name}</div>
      </div>

      <div className="mb-3 rounded-xl bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-600">Thank you for judging today. Please agree the weightage for each criterion so they total <b>100</b>. The highest weightage becomes <b>C1</b> (used to break ties, then C2, C3…).</p>
        <div className="mt-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-navy-900">Criteria &amp; weightages</h2>
          {!brief.weightages_locked && !editW && <button onClick={() => setEditW(true)} className="inline-flex items-center gap-1 text-xs font-medium text-navy-600 hover:underline"><Sliders size={13} /> Adjust</button>}
          {brief.weightages_locked && <span className="inline-flex items-center gap-1 text-xs text-slate-400"><Lock size={12} /> locked</span>}
        </div>
        {!editW ? (
          <div className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
            {criteria.map((c, i) => (
              <div key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-slate-700"><b className="text-navy-700">C{i + 1}</b> {c.label}</span>
                <span className="font-mono font-semibold text-navy-800">{c.max_score}</span>
              </div>
            ))}
            <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-sm font-semibold"><span>Total</span><span className="font-mono">{criteria.reduce((t, c) => t + Number(c.max_score), 0)}</span></div>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            {wDraft.map((c, idx) => (
              <div key={c.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-slate-700">{c.label}</span>
                <input type="number" min={0} value={c.max_score}
                  onChange={(e) => setWDraft((p) => p.map((x, i) => (i === idx ? { ...x, max_score: e.target.value === '' ? '' : Number(e.target.value) } : x)))}
                  className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm" />
              </div>
            ))}
            <div className="flex items-center justify-between">
              <span className={`text-xs ${Math.round(wTotal) === 100 ? 'text-green-600' : 'text-red-600'}`}>Total {wTotal}/100 · highest = C1</span>
              <div className="flex gap-2">
                <button onClick={() => setEditW(false)} className="rounded-md border border-slate-300 px-3 py-1 text-sm">Cancel</button>
                <button onClick={saveWeights} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-3 py-1 text-sm text-white disabled:bg-navy-300"><Save size={14} /> Save</button>
              </div>
            </div>
          </div>
        )}

        {ev.is_stage_event && (
          <p className="mt-3 text-xs text-slate-500">Time allowed: <b>{mmss(ev.allotted_time_seconds)}</b> · yellow {mmss(ev.yellow_alert_seconds)} before end · grace {mmss(ev.grace_period_seconds)}.</p>
        )}

        {!brief.weightages_locked && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
            <span className={`text-sm ${ag.all_agreed ? 'text-green-600' : 'text-amber-600'}`}>{ag.all_agreed ? '✓ All judges agreed.' : `Agreed by ${ag.agreed}/${ag.total} judges.`}</span>
            {ag.i_agreed ? <span className="inline-flex items-center gap-1 text-sm font-medium text-green-600"><Check size={15} /> You agreed</span>
              : <button onClick={agree} disabled={busy} className="rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white disabled:bg-navy-300">I agree to these weightages</button>}
          </div>
        )}
      </div>

      <button onClick={onContinue} className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gold-500 px-4 py-3 text-base font-semibold text-white hover:bg-gold-600">
        Continue to scoring <ArrowRight size={18} />
      </button>
    </div>
  );
}

function GroupPicker({ current, groups, onBack, onPick }) {
  return (
    <div>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> Briefing</button>
      <h1 className="text-lg font-semibold text-navy-900"><span className="font-mono text-sm text-navy-500 mr-1.5">{current.event_code}</span>{current.event_name}</h1>
      <p className="mb-3 mt-1 text-sm text-slate-500">Select the age group you are judging now.</p>
      {groups.length === 0 ? <p className="rounded-lg bg-white p-4 text-sm text-slate-500 shadow-sm">No chest numbers assigned yet.</p>
        : <div className="grid gap-2 sm:grid-cols-2">{groups.map((g) => (
          <button key={g.age_group_id} onClick={() => onPick(g.age_group_id)} className="rounded-xl bg-white p-4 text-left shadow-sm hover:bg-slate-50">
            <div className="text-base font-semibold text-navy-800">Group {g.code}</div>
            <div className="text-xs text-slate-500">{g.participant_count} participants · scored {g.scored_count}/{g.participant_count}</div></button>))}</div>}
    </div>
  );
}

function ScoreGrid({ token, current, groupId, onBack, setFlash, reloadGroups }) {
  const [sheet, setSheet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [vals, setVals] = useState({});
  const [saved, setSaved] = useState({});
  const [savingCell, setSavingCell] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const sh = await judgeApi.sheet(token, current.assignment_id, groupId); setSheet(sh);
      const m = {}; for (const s of sh.scores) m[`${s.registration_id}:${s.criterion_id}`] = String(s.score_value);
      setVals(m); setSaved(m);
    } catch (e) { setFlash(e.message); } finally { setLoading(false); }
  }, [token, current, groupId]);
  useEffect(() => { load(); }, [load]);

  const criteria = useMemo(() => (sheet ? [...sheet.criteria].sort((a, b) => a.sequence_order - b.sequence_order) : []), [sheet]);
  const maxByCrit = useMemo(() => Object.fromEntries(criteria.map((c) => [c.id, Number(c.max_score)])), [criteria]);
  const canScore = sheet?.agreement?.all_agreed;
  const totalFor = useCallback((reg) => criteria.reduce((t, c) => { const v = Number(saved[`${reg}:${c.id}`]); return t + (Number.isFinite(v) ? v : 0); }, 0), [criteria, saved]);
  const rankMap = useMemo(() => {
    if (!sheet) return {};
    const rows = sheet.participants.map((p) => ({ reg: p.registration_id, total: totalFor(p.registration_id) })).filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
    const map = {}; let rank = 0, prev = null; rows.forEach((r, i) => { if (r.total !== prev) { rank = i + 1; prev = r.total; } map[r.reg] = rank; }); return map;
  }, [sheet, totalFor]);

  function revert(key) { setVals((m) => ({ ...m, [key]: saved[key] ?? '' })); }
  async function saveCell(reg, crit) {
    const key = `${reg}:${crit}`; const raw = vals[key];
    if (raw === '' || raw == null) { if (saved[key] != null) revert(key); return; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0 || v > maxByCrit[crit]) { setFlash(`Score cannot exceed the criterion weightage (max ${maxByCrit[crit]}).`); revert(key); return; }
    setSavingCell(key);
    try { await judgeApi.saveScores(token, current.assignment_id, [{ registration_id: reg, criterion_id: crit, score_value: v }]); setSaved((m) => ({ ...m, [key]: String(v) })); reloadGroups(); }
    catch (e) { setFlash(e.message); revert(key); } finally { setSavingCell(null); }
  }

  if (loading || !sheet) return <p className="py-10 text-center text-sm text-slate-500">Loading scoresheet…</p>;
  const gcode = sheet.event?.age_group_code; const ag = sheet.agreement || {};

  return (
    <div>
      <button onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> Groups</button>
      <div className="mb-3 rounded-xl bg-navy-700 p-4 text-white">
        <div className="text-xs uppercase tracking-wide text-navy-200">Now scoring</div>
        <div className="text-lg font-semibold">{current.event_code} · {current.event_name}</div>
        <div className="mt-0.5 inline-block rounded-full bg-gold-500 px-3 py-0.5 text-sm font-semibold">Group {gcode}</div>
      </div>
      {!canScore && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">Scoring opens once all judges agree the weightages on the briefing screen ({ag.agreed}/{ag.total} agreed).</div>}
      {sheet.participants.length === 0 ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500 shadow-sm">No chest numbers assigned for this group yet.</p> : (
        <div className="overflow-x-auto rounded-xl bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 text-left">Chest</th>
                {criteria.map((c, i) => <th key={c.id} className="px-2 py-2 text-center font-medium" title={c.label}><div>C{i + 1}</div><div className="text-[10px] font-normal normal-case text-slate-400">max {c.max_score}</div></th>)}
                <th className="px-2 py-2 text-center">Total</th><th className="px-2 py-2 text-center">Rank</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sheet.participants.map((p) => { const reg = p.registration_id; const total = totalFor(reg); return (
                <tr key={reg}>
                  <td className="sticky left-0 z-10 bg-white px-3 py-2"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-100 font-mono text-base font-bold text-navy-800">{p.chest_number}</span></td>
                  {criteria.map((c) => { const key = `${reg}:${c.id}`; return (
                    <td key={c.id} className="px-1 py-1 text-center">
                      <input type="number" min={0} max={c.max_score} inputMode="numeric" disabled={!canScore} value={vals[key] ?? ''}
                        onChange={(e) => setVals((m) => ({ ...m, [key]: e.target.value }))} onBlur={() => saveCell(reg, c.id)}
                        className={`w-14 rounded-md border px-1 py-2 text-center text-base disabled:bg-slate-100 disabled:text-slate-400 ${savingCell === key ? 'border-gold-400' : 'border-slate-300'}`} />
                    </td>); })}
                  <td className="px-2 py-2 text-center font-semibold text-navy-800">{total || ''}</td>
                  <td className="px-2 py-2 text-center">{rankMap[reg] ? <span className="inline-block rounded-full bg-gold-100 px-2 py-0.5 text-xs font-bold text-gold-700">{rankMap[reg]}</span> : <span className="text-slate-300">—</span>}</td>
                </tr>); })}
            </tbody>
          </table>
        </div>)}
      <p className="mt-2 text-xs text-slate-500">Scores can't exceed a criterion's weightage. They save as you leave each box; Total &amp; Rank (only you see it) update live.</p>
    </div>
  );
}
