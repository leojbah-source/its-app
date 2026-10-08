// src/pages/TeamEventDay.jsx
// Team Event-Day — the team equivalent of the individual Event Day screen.
// Teams are NOT subdivided by age group: every team in the event appears in one
// list, alphabetical by name, with a single combined chest sequence. Teams are
// marked present/absent as a whole AND each member is marked individually, so
// the minimum squad is met, absentees are excluded from certificates/trophies,
// and a replacement can be recorded as an approved substitute. Judging is
// identical to individual events — the chest number represents the team.
import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { Users, ChevronDown, ChevronRight, RefreshCw, Hash, UserPlus, Sparkles } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { scheduleApi, chestApi } from '../api/client';

const MARK_ROLES = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
const MANUAL_ROLES = ['SuperAdmin', 'Chairman'];
const today = () => new Date().toISOString().slice(0, 10);

// Dramatized chest-number draw (projector-friendly) — mirrors the individual
// Event Day reveal.
function BigReveal({ item }) {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(false); const t = setTimeout(() => setOn(true), 30); return () => clearTimeout(t); }, [item.chest]);
  return (
    <div className={`flex flex-col items-center transition-all duration-500 ${on ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}>
      <div className="mb-2 text-sm uppercase tracking-[0.3em] text-gold-400">Chest Number</div>
      <div className="font-mono font-black leading-none text-white" style={{ fontSize: 'clamp(4rem, 16vw, 12rem)' }}>{item.chest}</div>
      <div className="mt-4 text-center text-2xl font-semibold text-white md:text-4xl">{item.name}</div>
    </div>
  );
}
function DrawOverlay({ items, onClose }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (i >= items.length) return;
    const t = setTimeout(() => setI(i + 1), 1200);
    return () => clearTimeout(t);
  }, [i, items.length]);
  const current = i > 0 ? items[i - 1] : null;
  const done = i >= items.length;
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-navy-900/95 p-6 backdrop-blur">
      <div className="flex items-center gap-2 text-gold-300"><Sparkles size={18} /><span className="text-sm uppercase tracking-[0.3em]">Team Chest Draw</span></div>
      <div className="flex w-full flex-1 items-center justify-center">
        {current ? <BigReveal item={current} /> : <div className="text-xl text-white/70">Drawing…</div>}
      </div>
      <div className="flex max-h-40 flex-wrap justify-center gap-2 overflow-y-auto">
        {items.slice(0, i).map((it) => (
          <span key={it.chest} className="rounded-full bg-white/10 px-3 py-1 text-sm text-white">
            <span className="font-mono font-bold text-gold-300">{it.chest}</span> · {it.name}
          </span>
        ))}
      </div>
      <button onClick={onClose} className="mt-6 rounded-md bg-white/15 px-5 py-2 text-sm font-medium text-white hover:bg-white/25">
        {done ? 'Done' : 'Skip'}
      </button>
    </div>
  );
}

export default function TeamEventDay() {
  const { token, user } = useAuth();
  const canMark = MARK_ROLES.includes(user?.role);
  const canManual = MANUAL_ROLES.includes(user?.role);

  const [schedule, setSchedule] = useState([]);
  const [date, setDate] = useState(today());
  const [eventId, setEventId] = useState('');
  const [teams, setTeams] = useState([]);
  const [sizeMin, setSizeMin] = useState(5);
  const [locked, setLocked] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState(null);
  const [draw, setDraw] = useState(null);

  useEffect(() => { scheduleApi.list(token).then(setSchedule).catch(() => {}); }, [token]);

  const scheduleDates = useMemo(
    () => [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(), [schedule]);
  useEffect(() => {
    if (scheduleDates.length && !scheduleDates.includes(date)) setDate(scheduleDates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDates]);

  const teamEventsOnDate = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (String(r.event_date).slice(0, 10) !== date) continue;
      if (r.event_kind !== 'team') continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);

  const loadTeams = useCallback(async () => {
    if (!eventId) { setTeams([]); return; }
    setLoading(true); setFlash('');
    try {
      const r = await chestApi.teamRoster(token, eventId);
      setTeams(r.teams || []); setSizeMin(r.size_min || 5); setLocked(!!r.locked);
    } catch (err) { setFlash(err.message || 'Could not load teams'); }
    finally { setLoading(false); }
  }, [token, eventId]);
  useEffect(() => { setEventId(''); setTeams([]); }, [date]);
  useEffect(() => { setOpen(new Set()); loadTeams(); }, [loadTeams]);

  const toggleOpen = (id) => setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const presentCount = (t) => (t.members || []).filter((m) => m.attendance_status === 'present').length;

  async function markTeam(t, present) {
    if (!canMark) return;
    const status = present ? 'attended' : 'absent';
    setTeams((ts) => ts.map((x) => (x.team_id === t.team_id ? { ...x, status } : x)));
    try { await chestApi.markAttendance(token, eventId, t.registration_id, present); }
    catch (err) { setFlash(err.message || 'Could not update attendance'); loadTeams(); }
  }
  async function markMember(t, m, present) {
    if (!canMark) return;
    const status = present ? 'present' : 'absent';
    setTeams((ts) => ts.map((x) => (x.team_id !== t.team_id ? x : {
      ...x, members: (x.members || []).map((mm) => (mm.participant_id === m.participant_id ? { ...mm, attendance_status: status } : mm)),
    })));
    try { await chestApi.memberAttendance(token, eventId, t.team_id, m.participant_id, present); }
    catch (err) { setFlash(err.message || 'Could not update member'); loadTeams(); }
  }
  async function assignChests() {
    if (!canMark) return;
    setBusy(true); setFlash('');
    try {
      const r = await chestApi.assignTeams(token, eventId);
      const list = Array.isArray(r) ? r : [];
      const nameByReg = new Map(teams.map((x) => [x.registration_id, x.team_name]));
      const byReg = new Map(list.map((a) => [a.registration_id, a.chest_number]));
      setTeams((ts) => ts.map((x) => (byReg.has(x.registration_id) ? { ...x, chest_number: byReg.get(x.registration_id) } : x)));
      const items = list.map((a) => ({ chest: a.chest_number, name: nameByReg.get(a.registration_id) || `#${a.registration_id}` }))
        .sort((a, b) => a.chest - b.chest);
      if (items.length) setDraw(items); else setFlash('No new chest numbers to assign.');
    } catch (err) { setFlash(err.message || 'Could not assign chest numbers'); }
    finally { setBusy(false); }
  }
  async function clearChests() {
    if (!canManual) return;
    const reason = window.prompt('Clear all team chest numbers for this event? Chairman action — enter a reason:', '');
    if (reason == null || !reason.trim()) return;
    setBusy(true); setFlash('');
    try { const r = await chestApi.clear(token, eventId, null, reason.trim()); setFlash(`Cleared ${r.removed} chest number(s).`); await loadTeams(); }
    catch (err) { setFlash(err.message || 'Could not clear'); }
    finally { setBusy(false); }
  }
  async function editChest(t) {
    if (!canManual) return;
    const val = window.prompt(`Set chest number for ${t.team_name}:`, t.chest_number || '');
    if (val == null || !String(val).trim()) return;
    const number = Number(val);
    if (!Number.isInteger(number) || number <= 0) { setFlash('Enter a whole number greater than 0.'); return; }
    const reason = window.prompt('Reason for setting/changing this chest number (required):', '');
    if (reason == null || !reason.trim()) { setFlash('A reason is required to change a chest number.'); return; }
    setBusy(true); setFlash('');
    try { await chestApi.manual(token, t.registration_id, Number(eventId), number, 'set', reason.trim()); await loadTeams(); }
    catch (err) { setFlash(err.message || 'Could not set chest number'); }
    finally { setBusy(false); }
  }
  async function submitSub(e) {
    e.preventDefault();
    if (!sub.full_name || !sub.cpr_number || !sub.dob || !sub.gender) { setFlash('Fill name, CPR, DOB and gender.'); return; }
    setBusy(true); setFlash('');
    try {
      await chestApi.substitute(token, eventId, sub.teamId, {
        absent_participant_id: sub.absentPid || null,
        full_name: sub.full_name, cpr_number: sub.cpr_number, dob: sub.dob, gender: sub.gender, reason: sub.reason || null,
      });
      setSub(null); await loadTeams(); setFlash('Replacement recorded.');
    } catch (err) { setFlash(err.message || 'Could not record replacement'); }
    finally { setBusy(false); }
  }

  const stats = useMemo(() => ({
    total: teams.length,
    attended: teams.filter((t) => t.status === 'attended').length,
    absent: teams.filter((t) => t.status === 'absent').length,
    withChest: teams.filter((t) => t.chest_number != null).length,
  }), [teams]);

  const allMarked = teams.length > 0 && teams.every((t) => t.status === 'attended' || t.status === 'absent');

  const inp = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  return (
    <AdminLayout title="Team Event Day" subtitle="All teams for the event in one list (alphabetical, combined chest numbering). Mark team and member attendance; record replacements. Judging is identical to individual events.">
      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Date</span>
            <select value={date} onChange={(e) => setDate(e.target.value)} className="rounded-md border border-slate-300 px-3 py-2 text-sm">
              {(scheduleDates.length ? scheduleDates : [date]).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Team event</span>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} className="min-w-[18rem] rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">Select a team event…</option>
              {teamEventsOnDate.map((e) => <option key={e.event_id} value={e.event_id}>{e.code} · {e.name}</option>)}
            </select>
          </label>
        </div>
      </Card>

      {teamEventsOnDate.length === 0 && <p className="text-sm text-slate-400">No team events scheduled on {date}.</p>}

      {eventId && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Badge tone="navy">{stats.total} teams</Badge>
            <Badge tone="success">{stats.attended} attended</Badge>
            <Badge tone="danger">{stats.absent} absent</Badge>
            <Badge tone="gold">{stats.withChest} with chest</Badge>
            <span className="text-xs text-slate-400">Min squad: {sizeMin}</span>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" icon={RefreshCw} onClick={loadTeams}>Refresh</Button>
              {canMark && !locked && <Button size="sm" icon={Hash} disabled={busy || !allMarked || stats.attended === 0} onClick={assignChests}>Assign chest numbers</Button>}
              {canManual && !locked && stats.withChest > 0 && <Button variant="outline" size="sm" onClick={clearChests} disabled={busy}>Clear</Button>}
            </div>
          </div>
          {locked && <p className="mb-3 text-xs text-amber-600">Chest numbers are locked — judging has started.</p>}
          {!locked && !allMarked && teams.length > 0 && <p className="mb-3 text-xs text-amber-600">Mark every team Present or Absent (and ideally check each team's members) before drawing chest numbers.</p>}

          {loading ? <PageLoader /> : teams.length === 0 ? (
            <p className="text-sm text-slate-400">No teams registered for this event.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Chest</th>
                    <th className="px-3 py-2 font-medium">Team</th>
                    <th className="px-3 py-2 font-medium">School</th>
                    <th className="px-3 py-2 font-medium">Present</th>
                    <th className="px-3 py-2 font-medium">Attendance</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {teams.map((t) => {
                    const isOpen = open.has(t.team_id);
                    const pc = presentCount(t);
                    const short = t.status === 'attended' && pc < sizeMin;
                    return (
                      <Fragment key={t.team_id}>
                        <tr className="hover:bg-slate-50">
                          <td className="px-3 py-2">
                            <button onClick={() => canManual && editChest(t)} title={canManual ? 'Set chest number' : ''}
                              className={`inline-flex min-w-[2.5rem] items-center justify-center rounded-md border px-2 py-1 font-mono text-base font-bold ${t.chest_number != null ? 'border-gold-300 bg-gold-50 text-gold-700' : 'border-slate-200 bg-slate-50 text-slate-300'} ${canManual ? 'cursor-pointer hover:border-navy-300' : ''}`}>
                              {t.chest_number != null ? t.chest_number : '—'}
                            </button>
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-800">{t.team_name}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{t.school_name || '—'}</td>
                          <td className="px-3 py-2">
                            <button onClick={() => toggleOpen(t.team_id)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-navy-700 hover:bg-navy-50">
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <Users size={13} /> {pc}/{(t.members || []).length}
                            </button>
                            {short && <span className="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">below {sizeMin}</span>}
                          </td>
                          <td className="px-3 py-2">
                            {t.status === 'attended' ? <Badge tone="success">Present</Badge> : t.status === 'absent' ? <Badge tone="danger">Absent</Badge> : <Badge tone="slate">Not marked</Badge>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {canMark && !locked && (
                              <div className="inline-flex gap-1">
                                <button onClick={() => markTeam(t, true)} disabled={busy} className="rounded-md border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">Present</button>
                                <button onClick={() => markTeam(t, false)} disabled={busy} className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">Absent</button>
                              </div>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr className="bg-slate-50/60">
                            <td />
                            <td colSpan={5} className="px-3 py-2">
                              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                                {(t.members || []).length === 0 && <li className="px-3 py-2 text-xs text-slate-400">No members recorded.</li>}
                                {(t.members || []).map((m) => (
                                  <li key={m.participant_id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                                    <span className="font-medium text-slate-800">{m.full_name}</span>
                                    {m.is_captain && <Badge tone="gold">Captain</Badge>}
                                    {m.is_substitute && <Badge tone="navy">Sub</Badge>}
                                    <span className="font-mono text-xs text-slate-400">{m.cpr_number}</span>
                                    {m.attendance_status === 'present' && <Badge tone="success">Present</Badge>}
                                    {m.attendance_status === 'absent' && <Badge tone="danger">Absent</Badge>}
                                    <div className="ml-auto flex items-center gap-1">
                                      {canMark && !locked && (
                                        <>
                                          <button onClick={() => markMember(t, m, true)} disabled={busy} className="rounded border border-green-300 px-1.5 py-0.5 text-[11px] text-green-700 hover:bg-green-50 disabled:opacity-50">P</button>
                                          <button onClick={() => markMember(t, m, false)} disabled={busy} className="rounded border border-red-300 px-1.5 py-0.5 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-50">A</button>
                                          {m.attendance_status === 'absent' && (
                                            <button onClick={() => setSub({ teamId: t.team_id, absentPid: m.participant_id, absentName: m.full_name, full_name: '', cpr_number: '', dob: '', gender: '', reason: '' })}
                                              className="ml-1 inline-flex items-center gap-1 rounded border border-navy-300 px-1.5 py-0.5 text-[11px] text-navy-700 hover:bg-navy-50">
                                              <UserPlus size={12} /> Replace
                                            </button>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  </li>
                                ))}
                              </ul>
                              {canMark && !locked && (
                                <button onClick={() => setSub({ teamId: t.team_id, absentPid: '', absentName: '', full_name: '', cpr_number: '', dob: '', gender: '', reason: '' })}
                                  className="mt-2 inline-flex items-center gap-1 text-xs text-navy-700 hover:underline">
                                  <UserPlus size={13} /> Add replacement member
                                </button>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {draw && <DrawOverlay items={draw} onClose={() => setDraw(null)} />}

      {sub && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setSub(null)}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={submitSub} className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-navy-900">Replacement member</h3>
            <p className="mt-1 text-xs text-slate-500">{sub.absentName ? `Replacing ${sub.absentName} (marked absent). ` : 'Add a replacement to this team. '}The new person is recorded as an approved substitute.</p>
            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Full name</label>
                <input className={inp} value={sub.full_name} onChange={(e) => setSub({ ...sub, full_name: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">CPR number</label>
                  <input className={inp} inputMode="numeric" value={sub.cpr_number} onChange={(e) => setSub({ ...sub, cpr_number: e.target.value })} />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Date of birth</label>
                  <input type="date" className={inp} value={sub.dob} onChange={(e) => setSub({ ...sub, dob: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Gender</label>
                  <select className={inp} value={sub.gender} onChange={(e) => setSub({ ...sub, gender: e.target.value })}>
                    <option value="">Select…</option>
                    <option value="M">Male</option>
                    <option value="F">Female</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Reason (optional)</label>
                  <input className={inp} value={sub.reason} onChange={(e) => setSub({ ...sub, reason: e.target.value })} />
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setSub(null)} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Cancel</button>
              <button type="submit" disabled={busy} className="rounded-md bg-navy-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-800 disabled:opacity-50">{busy ? 'Saving…' : 'Save replacement'}</button>
            </div>
          </form>
        </div>
      )}
    </AdminLayout>
  );
}
