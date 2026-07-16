// src/pages/judge/JudgeApp.jsx
// Judge scoring: assigned events → pick age group → agree criteria weightages
// (sum 100; highest weightage = C1) → score each participant by CHEST NUMBER.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { Gavel, LogOut, ChevronLeft, Check, Save, Sliders } from 'lucide-react';
import { useJudgeAuth } from '../../context/JudgeAuthContext';
import { judgeApi } from '../../api/client';

export default function JudgeApp() {
  const { token, judge, logout } = useJudgeAuth();
  const [events, setEvents] = useState([]);
  const [current, setCurrent] = useState(null); // assignment/event
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState(null);
  const [sheet, setSheet] = useState(null);
  const [flash, setFlash] = useState('');
  const [loading, setLoading] = useState(false);

  const loadEvents = useCallback(async () => {
    try { setEvents(await judgeApi.events(token)); } catch (e) { setFlash(e.message); }
  }, [token]);
  useEffect(() => { loadEvents(); }, [loadEvents]);

  async function openEvent(ev) {
    setCurrent(ev); setGroups([]); setGroupId(null); setSheet(null); setFlash('');
    try { setGroups(await judgeApi.groups(token, ev.assignment_id)); } catch (e) { setFlash(e.message); }
  }
  const loadSheet = useCallback(async () => {
    if (!current || !groupId) { setSheet(null); return; }
    setLoading(true);
    try { setSheet(await judgeApi.sheet(token, current.assignment_id, groupId)); }
    catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token, current, groupId]);
  useEffect(() => { loadSheet(); }, [loadSheet]);

  function backToEvents() { setCurrent(null); setGroups([]); setGroupId(null); setSheet(null); }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-10 flex items-center justify-between bg-navy-800 px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Gavel size={20} className="text-gold-400" />
          <span className="font-semibold">Judge Scoring</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-navy-200">{judge?.name}</span>
          <button onClick={logout} className="inline-flex items-center gap-1 text-navy-100 hover:text-white"><LogOut size={16} /> Sign out</button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl p-4">
        {flash && <div className="mb-3 rounded-md border border-navy-200 bg-white px-3 py-2 text-sm text-navy-700">{flash}</div>}

        {!current ? (
          <EventsList events={events} onOpen={openEvent} />
        ) : (
          <EventDetail
            current={current} groups={groups} groupId={groupId} setGroupId={setGroupId}
            sheet={sheet} loading={loading} token={token} onBack={backToEvents}
            reloadSheet={loadSheet} reloadGroups={() => openEvent(current)} setFlash={setFlash}
          />
        )}
      </main>
    </div>
  );
}

function EventsList({ events, onOpen }) {
  if (!events.length) return <p className="py-10 text-center text-sm text-slate-500">No events assigned to you yet.</p>;
  return (
    <div className="space-y-2">
      <h1 className="mb-2 text-lg font-semibold text-navy-900">Your events</h1>
      {events.map((e) => (
        <button key={e.assignment_id} onClick={() => onOpen(e)}
          className="flex w-full items-center justify-between rounded-xl bg-white p-4 text-left shadow-sm hover:bg-slate-50">
          <div>
            <div className="font-medium text-navy-800"><span className="font-mono text-xs text-navy-500 mr-1.5">{e.event_code}</span>{e.event_name}</div>
            <div className="text-xs text-slate-500">{e.category_name} · {e.criteria_count} criteria (total {e.criteria_total})</div>
          </div>
          <ChevronLeft className="rotate-180 text-slate-400" size={18} />
        </button>
      ))}
    </div>
  );
}

function EventDetail({ current, groups, groupId, setGroupId, sheet, loading, token, onBack, reloadSheet, reloadGroups, setFlash }) {
  return (
    <div>
      <button onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> All events</button>
      <h1 className="text-lg font-semibold text-navy-900"><span className="font-mono text-sm text-navy-500 mr-1.5">{current.event_code}</span>{current.event_name}</h1>

      <div className="my-3 flex flex-wrap gap-1.5">
        {groups.length === 0 && <span className="text-xs text-slate-500">No groups with chest numbers yet — the organiser assigns them on the day.</span>}
        {groups.map((g) => (
          <button key={g.age_group_id} onClick={() => setGroupId(g.age_group_id)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${String(groupId) === String(g.age_group_id) ? 'border-navy-600 bg-navy-600 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>
            {g.code} · {g.participant_count} · scored {g.scored_count}/{g.participant_count}
          </button>
        ))}
      </div>

      {loading ? <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
        : !groupId ? <p className="py-8 text-center text-sm text-slate-500">Select an age group to score.</p>
        : sheet ? <GroupSheet sheet={sheet} token={token} assignmentId={current.assignment_id} reloadSheet={reloadSheet} reloadGroups={reloadGroups} setFlash={setFlash} />
        : null}
    </div>
  );
}

function GroupSheet({ sheet, token, assignmentId, reloadSheet, reloadGroups, setFlash }) {
  const { criteria, participants, scores, weightages_locked } = sheet;
  const [editW, setEditW] = useState(false);
  const [wDraft, setWDraft] = useState(() => criteria.map((c) => ({ id: c.id, label: c.label, max_score: Number(c.max_score) })));
  const [openReg, setOpenReg] = useState(null);
  const [sDraft, setSDraft] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => { setWDraft(criteria.map((c) => ({ id: c.id, label: c.label, max_score: Number(c.max_score) }))); }, [criteria]);

  const wTotal = wDraft.reduce((t, c) => t + (Number(c.max_score) || 0), 0);
  const scoreMap = useMemo(() => {
    const m = {};
    for (const s of scores) { (m[s.registration_id] ??= {})[s.criterion_id] = Number(s.score_value); }
    return m;
  }, [scores]);
  const isScored = (reg) => criteria.length > 0 && criteria.every((c) => scoreMap[reg]?.[c.id] != null);

  async function saveWeights() {
    if (Math.round(wTotal) !== 100) { setFlash(`Weightages must total 100 (now ${wTotal}).`); return; }
    setBusy(true);
    try {
      // highest weightage = C1: order by max_score desc
      const ordered = [...wDraft].sort((a, b) => b.max_score - a.max_score)
        .map((c, i) => ({ id: c.id, max_score: c.max_score, sequence_order: i + 1 }));
      await judgeApi.setCriteria(token, assignmentId, ordered);
      setEditW(false); setFlash('Weightages saved.'); reloadSheet();
    } catch (e) { setFlash(e.message); }
    finally { setBusy(false); }
  }

  function openParticipant(reg) {
    setOpenReg(reg);
    const init = {};
    for (const c of criteria) init[c.id] = scoreMap[reg]?.[c.id] ?? '';
    setSDraft(init);
  }
  async function saveParticipant() {
    const payload = criteria
      .filter((c) => sDraft[c.id] !== '' && sDraft[c.id] != null)
      .map((c) => ({ registration_id: openReg, criterion_id: c.id, score_value: Number(sDraft[c.id]) }));
    if (!payload.length) { setFlash('Enter at least one score.'); return; }
    setBusy(true);
    try { await judgeApi.saveScores(token, assignmentId, payload); setOpenReg(null); setFlash('Saved.'); reloadSheet(); reloadGroups(); }
    catch (e) { setFlash(e.message); }
    finally { setBusy(false); }
  }

  const cSorted = [...criteria].sort((a, b) => a.sequence_order - b.sequence_order);

  return (
    <div className="space-y-4">
      {/* Criteria & weightages */}
      <div className="rounded-xl bg-white p-4 shadow-sm">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-navy-900">Criteria &amp; weightages (total 100)</h2>
          {!weightages_locked && !editW && (
            <button onClick={() => setEditW(true)} className="inline-flex items-center gap-1 text-xs font-medium text-navy-600 hover:underline"><Sliders size={13} /> Agree / adjust</button>
          )}
          {weightages_locked && <span className="text-xs text-slate-400">locked (scoring started)</span>}
        </div>
        {!editW ? (
          <div className="flex flex-wrap gap-1.5">
            {cSorted.map((c, i) => (
              <span key={c.id} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">
                <span className="font-semibold text-navy-700">C{i + 1}</span> {c.label} · <span className="font-mono">{c.max_score}</span>
              </span>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {wDraft.map((c, idx) => (
              <div key={c.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-slate-700">{c.label}</span>
                <input type="number" min={0} value={c.max_score}
                  onChange={(e) => setWDraft((prev) => prev.map((x, i) => (i === idx ? { ...x, max_score: e.target.value === '' ? '' : Number(e.target.value) } : x)))}
                  className="w-20 rounded-md border border-slate-300 px-2 py-1 text-sm" />
              </div>
            ))}
            <div className="flex items-center justify-between pt-1">
              <span className={`text-xs ${Math.round(wTotal) === 100 ? 'text-green-600' : 'text-red-600'}`}>Total {wTotal} / 100 · highest = C1</span>
              <div className="flex gap-2">
                <button onClick={() => setEditW(false)} className="rounded-md border border-slate-300 px-3 py-1 text-sm">Cancel</button>
                <button onClick={saveWeights} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-3 py-1 text-sm text-white disabled:bg-navy-300"><Save size={14} /> Save</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Participants (chest numbers only) */}
      <div className="rounded-xl bg-white p-2 shadow-sm">
        {participants.length === 0 ? <p className="py-6 text-center text-sm text-slate-500">No chest numbers assigned yet.</p> : (
          <ul className="divide-y divide-slate-100">
            {participants.map((p) => {
              const scored = isScored(p.registration_id);
              const open = openReg === p.registration_id;
              return (
                <li key={p.registration_id}>
                  <button onClick={() => (open ? setOpenReg(null) : openParticipant(p.registration_id))}
                    className="flex w-full items-center justify-between px-3 py-3 text-left hover:bg-slate-50">
                    <span className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-100 font-mono text-lg font-bold text-navy-800">{p.chest_number}</span>
                      <span className="text-sm text-slate-600">Chest {p.chest_number}</span>
                    </span>
                    {scored ? <span className="inline-flex items-center gap-1 text-xs font-medium text-green-600"><Check size={14} /> scored</span>
                      : <span className="text-xs text-slate-400">tap to score</span>}
                  </button>
                  {open && (
                    <div className="border-t border-slate-100 bg-slate-50 px-3 py-3">
                      <div className="space-y-2">
                        {cSorted.map((c, i) => (
                          <div key={c.id} className="flex items-center gap-2">
                            <span className="flex-1 text-sm text-slate-700"><span className="font-semibold text-navy-700">C{i + 1}</span> {c.label} <span className="text-slate-400">(max {c.max_score})</span></span>
                            <input type="number" min={0} max={c.max_score} value={sDraft[c.id] ?? ''}
                              onChange={(e) => setSDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                              className="w-20 rounded-md border border-slate-300 px-2 py-1.5 text-base" inputMode="numeric" />
                          </div>
                        ))}
                        <div className="flex justify-end gap-2 pt-1">
                          <button onClick={() => setOpenReg(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">Close</button>
                          <button onClick={saveParticipant} disabled={busy} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white disabled:bg-navy-300"><Save size={15} /> Save chest {p.chest_number}</button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
