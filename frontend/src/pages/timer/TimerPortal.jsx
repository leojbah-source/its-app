// src/pages/timer/TimerPortal.jsx
// Timer portal (staff Timer role). Chest numbers ONLY. Pick event → pick age
// GROUP (chest numbers restart per group) → time each chest. Yellow at
// (allotted − yellow), red at allotted, grace after. On stop the time is written
// against the chest. Only a Chairman (email+password) can correct a time.
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Timer as TimerIcon, LogOut, ChevronLeft, Play, Square, Pencil } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { timerApi } from '../../api/client';

const clock = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, '0')}`);

export default function TimerPortal() {
  const { token, user, logout } = useAuth();
  const [events, setEvents] = useState([]);
  const [current, setCurrent] = useState(null);  // event obj
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState(null);
  const [data, setData] = useState(null);         // { timing, participants }
  const [flash, setFlash] = useState('');
  const [now, setNow] = useState(Date.now());
  const [edit, setEdit] = useState(null);
  const timer = useRef(null);

  useEffect(() => {
    timerApi.myEvents(token).then((evs) => { setEvents(evs); if (evs.length === 1) openEvent(evs[0]); }).catch((e) => setFlash(e.message));
  }, [token]);

  async function openEvent(ev) {
    setCurrent(ev); setGroupId(null); setData(null); setFlash('');
    try { setGroups(await timerApi.groups(token, ev.event_id)); } catch (e) { setFlash(e.message); }
  }

  const load = useCallback(async () => {
    if (!current || !groupId) { setData(null); return; }
    try { setData(await timerApi.participants(token, current.event_id, groupId)); } catch (e) { setFlash(e.message); }
  }, [token, current, groupId]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    timer.current = setInterval(() => setNow(Date.now()), 250);
    const poll = setInterval(() => { if (current && groupId) load(); }, 3000);
    return () => { clearInterval(timer.current); clearInterval(poll); };
  }, [load, current, groupId]);

  const running = useMemo(() => (data?.participants || []).find((p) => p.start_time && !p.end_time), [data]);

  function pickGroup(g) {
    if (running && String(g.age_group_id) !== String(groupId)) {
      if (!window.confirm(`A timing is still running for chest ${running.chest_number} in the current group. Switch group anyway? (the running timer keeps going)`)) return;
    }
    setGroupId(g.age_group_id);
  }
  function backToGroups() {
    if (running && !window.confirm(`A timing is still running for chest ${running.chest_number}. Leave this group? (the timer keeps going)`)) return;
    setGroupId(null); setData(null);
  }

  const th = data?.timing || {};
  const elapsed = running ? (now - new Date(running.start_time).getTime()) / 1000 : 0;
  function lightState(sec) {
    const allotted = Number(th.allotted_time_seconds) || 0, yellow = Number(th.yellow_alert_seconds) || 0, grace = Number(th.grace_period_seconds) || 0;
    if (sec >= allotted + grace) return { c: 'bg-red-600', label: 'OVER (grace exceeded)' };
    if (sec >= allotted) return { c: 'bg-red-500', label: 'RED — time up' };
    if (allotted && sec >= allotted - yellow) return { c: 'bg-amber-400', label: 'YELLOW' };
    return { c: 'bg-green-500', label: 'running' };
  }
  async function start(p) { try { await timerApi.start(token, current.event_id, { registration_id: p.registration_id, chest_number: p.chest_number }); setNow(Date.now()); load(); } catch (e) { setFlash(e.message); } }
  async function stop(p) { try { await timerApi.stop(token, current.event_id, p.registration_id); load(); } catch (e) { setFlash(e.message); } }

  const groupCode = groups.find((g) => String(g.age_group_id) === String(groupId))?.code;

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-navy-800 px-4 py-3 text-white">
        <div className="flex items-center gap-2"><TimerIcon size={20} className="text-gold-400" /><span className="font-semibold">Timer</span></div>
        <div className="flex items-center gap-3 text-sm"><span className="text-navy-200">{user?.full_name || user?.name}</span>
          <button onClick={logout} className="inline-flex items-center gap-1 text-navy-100 hover:text-white"><LogOut size={16} /> Sign out</button></div>
      </header>

      <main className="mx-auto max-w-2xl p-4">
        {flash && <div className="mb-3 rounded-md border border-navy-200 bg-white px-3 py-2 text-sm text-navy-700">{flash}</div>}

        {!current ? (
          <div className="space-y-2">
            <h1 className="mb-2 text-lg font-semibold text-navy-900">Your events</h1>
            {events.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No event assigned to you yet.</p>}
            {events.map((e) => (
              <button key={e.event_id} onClick={() => openEvent(e)} className="flex w-full items-center justify-between rounded-xl bg-white p-4 text-left shadow-sm hover:bg-slate-50">
                <div><div className="font-medium text-navy-800"><span className="font-mono text-xs text-navy-500 mr-1.5">{e.event_code}</span>{e.event_name}</div>
                <div className="text-xs text-slate-500">Time allowed {clock(e.allotted_time_seconds)}</div></div>
                <ChevronLeft className="rotate-180 text-slate-400" size={18} />
              </button>
            ))}
          </div>
        ) : !groupId ? (
          <div>
            {events.length > 1 && <button onClick={() => setCurrent(null)} className="mb-3 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> Events</button>}
            <h1 className="text-lg font-semibold text-navy-900"><span className="font-mono text-sm text-navy-500 mr-1.5">{current.event_code}</span>{current.event_name}</h1>
            <p className="mb-3 mt-1 text-sm text-slate-500">Select the age group you are timing now.</p>
            {groups.length === 0 ? <p className="rounded-lg bg-white p-4 text-sm text-slate-500 shadow-sm">No chest numbers assigned yet.</p>
              : <div className="grid gap-2 sm:grid-cols-2">{groups.map((g) => (
                <button key={g.age_group_id} onClick={() => pickGroup(g)} className="rounded-xl bg-white p-4 text-left shadow-sm hover:bg-slate-50">
                  <div className="text-base font-semibold text-navy-800">Group {g.code}</div>
                  <div className="text-xs text-slate-500">{g.participant_count} participants</div></button>))}</div>}
          </div>
        ) : !data ? <p className="py-8 text-center text-sm text-slate-500">Loading…</p> : (
          <div>
            <button onClick={backToGroups} className="mb-2 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> Groups</button>
            <div className="mb-3 rounded-xl bg-navy-700 p-3 text-white">
              <div className="text-xs uppercase tracking-wide text-navy-200">Timing</div>
              <div className="font-semibold">{current.event_code} · {current.event_name}</div>
              <div className="mt-0.5 inline-block rounded-full bg-gold-500 px-3 py-0.5 text-sm font-semibold">Group {groupCode}</div>
            </div>

            {running && (() => { const ls = lightState(elapsed); return (
              <div className="mb-4 rounded-2xl bg-navy-800 p-6 text-center text-white">
                <div className="text-xs uppercase tracking-widest text-navy-300">Now timing — Chest</div>
                <div className="my-1 font-mono text-5xl font-black">{running.chest_number}</div>
                <div className="my-2 font-mono font-black tabular-nums" style={{ fontSize: 'clamp(3rem,18vw,7rem)' }}>{clock(elapsed)}</div>
                <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-sm"><span className={`h-3 w-3 rounded-full ${ls.c}`} /> {ls.label} · allowed {clock(th.allotted_time_seconds)}</div>
                <div><button onClick={() => stop(running)} className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-8 py-3 text-lg font-bold text-white hover:bg-red-700"><Square size={20} /> STOP</button></div>
              </div>
            ); })()}

            <div className="rounded-xl bg-white p-2 shadow-sm">
              <ul className="divide-y divide-slate-100">
                {data.participants.map((p) => {
                  const isRunning = p.start_time && !p.end_time; const done = !!p.end_time;
                  return (
                    <li key={p.registration_id} className="flex items-center justify-between px-3 py-2.5">
                      <span className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-100 font-mono text-lg font-bold text-navy-800">{p.chest_number}</span>
                        {done ? <span className={`text-sm font-medium ${p.flag_for_dq ? 'text-red-600' : 'text-green-600'}`}>{clock(p.time_taken_seconds)}{p.flag_for_dq ? ' · over' : ''}</span>
                          : isRunning ? <span className="text-sm text-amber-600">running…</span> : <span className="text-sm text-slate-400">waiting</span>}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {!done && !isRunning && <button onClick={() => start(p)} disabled={!!running} className="inline-flex items-center gap-1 rounded-md bg-green-600 px-3 py-1.5 text-sm font-medium text-white disabled:bg-slate-300"><Play size={14} /> Start</button>}
                        {isRunning && <button onClick={() => stop(p)} className="inline-flex items-center gap-1 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white"><Square size={14} /> Stop</button>}
                        <button onClick={() => setEdit({ registration_id: p.registration_id, chest_number: p.chest_number })} className="rounded-md p-1.5 text-slate-400 hover:text-navy-600" title="Chairman correction"><Pencil size={15} /></button>
                      </span>
                    </li>
                  );
                })}
                {data.participants.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">No chest numbers for this group.</li>}
              </ul>
            </div>
            <p className="mt-2 text-xs text-slate-500">Yellow {clock(th.yellow_alert_seconds)} before end · red at time-up · grace {clock(th.grace_period_seconds)}. Corrections need a Chairman.</p>
          </div>
        )}

        {edit && <OverrideModal edit={edit} token={token} eventId={current?.event_id} onClose={() => setEdit(null)} onDone={() => { setEdit(null); load(); }} />}
      </main>
    </div>
  );
}

function OverrideModal({ edit, token, eventId, onClose, onDone }) {
  const [seconds, setSeconds] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit() {
    if (seconds === '' || !email || !password) { setErr('All fields are required.'); return; }
    setBusy(true); setErr('');
    try { await timerApi.override(token, eventId, { registration_id: edit.registration_id, seconds: Number(seconds), email, password }); onDone(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  const inp = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-navy-900">Correct time — Chest {edit.chest_number}</h3>
        <p className="mt-1 text-xs text-slate-500">A Chairman must authorise this correction.</p>
        <div className="mt-3 space-y-2">
          <input value={seconds} onChange={(e) => setSeconds(e.target.value)} placeholder="Time in seconds" inputMode="numeric" className={inp} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Chairman email" className={inp} />
          <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Chairman password" type="password" className={inp} />
          {err && <p className="text-xs text-red-600">{err}</p>}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="rounded-md bg-navy-600 px-4 py-1.5 text-sm text-white disabled:bg-navy-300">Save correction</button>
        </div>
      </div>
    </div>
  );
}
