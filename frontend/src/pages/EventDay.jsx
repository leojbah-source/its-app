// src/pages/EventDay.jsx
// Day-of, PER GROUP (an event is group-level: "Clay Modelling G4" and
// "Clay Modelling G2" are separate contests). Day → Event → Group; mark
// attendance; assign chest numbers (restart at 1 per group) with a dramatized
// on-screen draw. Chest numbers LOCK once judging starts (a score exists).
import { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, Hash, Trash2, Check, X, Lock, Sparkles } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { scheduleApi, chestApi } from '../api/client';

const MARK_ROLES = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
const MANUAL_ROLES = ['SuperAdmin', 'Chairman'];
const today = () => new Date().toLocaleDateString('en-CA');

// ── Dramatized chest-number draw (projector-friendly) ────────────────────────
function BigReveal({ item }) {
  const [on, setOn] = useState(false);
  useEffect(() => { setOn(false); const t = setTimeout(() => setOn(true), 30); return () => clearTimeout(t); }, [item.chest]);
  return (
    <div className={`flex flex-col items-center transition-all duration-500 ${on ? 'scale-100 opacity-100' : 'scale-50 opacity-0'}`}>
      <div className="text-gold-400 text-sm uppercase tracking-[0.3em] mb-2">Chest Number</div>
      <div className="font-mono font-black leading-none text-white" style={{ fontSize: 'clamp(4rem, 16vw, 12rem)' }}>{item.chest}</div>
      <div className="mt-4 text-2xl md:text-4xl font-semibold text-white text-center">{item.name}</div>
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
      <div className="flex items-center gap-2 text-gold-300"><Sparkles size={18} /><span className="text-sm uppercase tracking-[0.3em]">Chest Number Draw</span></div>
      <div className="flex-1 flex items-center justify-center w-full">
        {current ? <BigReveal item={current} /> : <div className="text-white/70 text-xl">Drawing…</div>}
      </div>
      <div className="flex flex-wrap justify-center gap-2 max-h-40 overflow-y-auto">
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

export default function EventDay() {
  const { token, user } = useAuth();
  const canMark = MARK_ROLES.includes(user?.role);
  const canManual = MANUAL_ROLES.includes(user?.role);

  const [schedule, setSchedule] = useState([]);
  const [date, setDate] = useState(today());
  const [eventId, setEventId] = useState('');
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [roster, setRoster] = useState([]);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [draw, setDraw] = useState(null);

  useEffect(() => { scheduleApi.list(token).then(setSchedule).catch(() => {}); }, [token]);

  const scheduleDates = useMemo(() =>
    [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(), [schedule]);

  const eventsOnDate = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (String(r.event_date).slice(0, 10) !== date) continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name, sessions: [] });
      map.get(r.event_id).sessions.push({ venue: r.venue, start: (r.start_time || '').slice(0, 5), end: (r.end_time || '').slice(0, 5), age_groups: r.age_groups });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);

  const selectedEvent = eventsOnDate.find((e) => String(e.event_id) === String(eventId));
  const selectedGroup = groups.find((g) => String(g.age_group_id) === String(groupId));
  const selectedGroupCode = selectedGroup?.code;
  const locked = !!selectedGroup?.locked;
  const groupSession = useMemo(() => {
    if (!selectedEvent || !selectedGroupCode) return null;
    return selectedEvent.sessions.find((s) => (s.age_groups || '').split(', ').includes(selectedGroupCode)) || selectedEvent.sessions[0] || null;
  }, [selectedEvent, selectedGroupCode]);

  useEffect(() => { setEventId(''); setGroups([]); setGroupId(''); setRoster([]); }, [date]);
  useEffect(() => {
    setGroupId(''); setRoster([]); setGroups([]);
    if (!eventId) return;
    chestApi.groups(token, eventId).then(setGroups).catch(() => {});
  }, [token, eventId]);

  const reloadGroups = useCallback(() => {
    if (eventId) chestApi.groups(token, eventId).then(setGroups).catch(() => {});
  }, [token, eventId]);

  const loadRoster = useCallback(async () => {
    if (!eventId || !groupId) { setRoster([]); return; }
    setRoster([]);            // clear immediately so the previous group never lingers
    setLoading(true); setFlash('');
    try { setRoster(await chestApi.roster(token, eventId, groupId)); }
    catch (err) { setFlash(err.message); }
    finally { setLoading(false); }
  }, [token, eventId, groupId]);
  useEffect(() => { loadRoster(); }, [loadRoster]);

  async function mark(reg, present) {
    setRoster((prev) => prev.map((x) => (x.registration_id === reg.registration_id ? { ...x, status: present ? 'attended' : 'absent' } : x)));
    try { await chestApi.markAttendance(token, eventId, reg.registration_id, present); }
    catch (err) { setFlash(err.message); loadRoster(); }
  }
  async function assign(mode) {
    setBusy(true); setFlash('');
    try {
      const r = mode === 'timeslot' ? await chestApi.assignTimeslot(token, eventId, groupId) : await chestApi.assignAuto(token, eventId, groupId);
      // Build the dramatized reveal from the just-assigned chests + names.
      const byReg = new Map(roster.map((x) => [x.registration_id, x.name]));
      const items = r.map((a) => ({ chest: a.chest_number, name: byReg.get(a.registration_id) || `#${a.registration_id}` }))
        .sort((a, b) => a.chest - b.chest);
      if (items.length) setDraw(items);
      loadRoster(); reloadGroups();
    } catch (err) { setFlash(err.message); }
    finally { setBusy(false); }
  }
  async function clearChests() {
    const reason = window.prompt(`Clear chest numbers for ${selectedGroupCode}? This is a Chairman action — enter a reason:`, '');
    if (reason == null || !reason.trim()) return;
    try { const r = await chestApi.clear(token, eventId, groupId, reason.trim()); setFlash(`Cleared ${r.removed} chest number(s).`); loadRoster(); reloadGroups(); }
    catch (err) { setFlash(err.message); }
  }
  async function setManual(reg) {
    const v = window.prompt(`Chest number for ${reg.name} (${selectedGroupCode}):`, reg.chest_number || '');
    if (v == null || v === '') return;
    try { await chestApi.manual(token, reg.registration_id, Number(eventId), Number(v)); loadRoster(); }
    catch (err) { setFlash(err.message); }
  }

  const counts = useMemo(() => ({
    total: roster.length,
    attended: roster.filter((r) => r.status === 'attended').length,
    absent: roster.filter((r) => r.status === 'absent').length,
    withChest: roster.filter((r) => r.chest_number != null).length,
    awaiting: roster.filter((r) => r.status === 'attended' && r.chest_number == null).length,
    unmarked: roster.filter((r) => r.status === 'registered').length,
  }), [roster]);

  const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  return (
    <AdminLayout title="Event day" subtitle="Mark attendance, then assign chest numbers per age group. Numbers restart at 1 for each group and lock once judging starts.">
      {draw && <DrawOverlay items={draw} onClose={() => setDraw(null)} />}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Day</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={sel} list="sched-dates" />
            <datalist id="sched-dates">{scheduleDates.map((d) => <option key={d} value={d} />)}</datalist>
          </div>
          <div className="min-w-[18rem] flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1">Event {eventsOnDate.length ? `(${eventsOnDate.length})` : ''}</label>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} className={`${sel} w-full`}>
              <option value="">{eventsOnDate.length ? 'Select an event…' : 'No events scheduled on this day'}</option>
              {eventsOnDate.map((e) => <option key={e.event_id} value={e.event_id}>{e.code} · {e.name}</option>)}
            </select>
          </div>
        </div>

        {selectedEvent && (
          <div className="mt-3">
            <label className="block text-xs font-medium text-slate-600 mb-1.5">Age group (each is a separate contest)</label>
            <div className="flex flex-wrap gap-1.5">
              {groups.length === 0 && <span className="text-xs text-slate-400">No groups with entries.</span>}
              {groups.map((g) => (
                <button key={g.age_group_id} type="button" onClick={() => setGroupId(g.age_group_id)}
                  className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    String(groupId) === String(g.age_group_id) ? 'border-navy-600 bg-navy-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}>
                  {g.locked && <Lock size={11} />}
                  {g.code} · {g.total} entr{g.total === 1 ? 'y' : 'ies'}{g.with_chest > 0 ? ` · ${g.with_chest} chests` : ''}
                </button>
              ))}
            </div>
            {groupSession && (
              <p className="mt-2 text-xs text-slate-500">
                {selectedGroupCode}: {groupSession.venue || 'venue TBD'}{groupSession.start ? ` · ${groupSession.start}–${groupSession.end}` : ''}
              </p>
            )}
          </div>
        )}
      </Card>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {eventId && groupId && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone="navy">{counts.total} entries</Badge>
            <Badge tone="success">{counts.attended} present</Badge>
            <Badge tone="danger">{counts.absent} absent</Badge>
            <Badge tone="gold">{counts.withChest} chests</Badge>
            {locked && <Badge tone="danger"><span className="inline-flex items-center gap-1"><Lock size={11} /> Locked — judging started</span></Badge>}
            <div className="flex-1" />
            {canMark && !locked && (
              <>
                <Button variant="primary" icon={Hash} loading={busy} disabled={counts.unmarked > 0 || counts.awaiting === 0}
                  onClick={() => assign('auto')}
                  title={counts.unmarked > 0 ? 'Mark all participants present/absent first' : 'Random chest numbers for attendees in this group'}>
                  Assign chests ({counts.awaiting})
                </Button>
                <Button variant="outline" icon={Hash} loading={busy} disabled={counts.unmarked > 0 || counts.awaiting === 0}
                  onClick={() => assign('timeslot')}
                  title={counts.unmarked > 0 ? 'Mark all participants present/absent first' : 'Lot draw per time-slot, within this group'}>
                  By time-slot
                </Button>
              </>
            )}
            {canManual && !locked && counts.withChest > 0 && <Button variant="ghost" icon={Trash2} onClick={clearChests}>Clear chests</Button>}
            <Button variant="outline" icon={RefreshCw} onClick={loadRoster}>Refresh</Button>
          </div>

          {!locked && counts.unmarked > 0 && (
            <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {counts.unmarked} participant(s) not yet marked — mark everyone present or absent to enable chest assignment.
            </div>
          )}

          <Card className="p-0 overflow-hidden">
            {loading ? <div className="p-6"><PageLoader label="Loading roster…" /></div>
              : roster.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No entries for this group.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 w-20">Chest</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2 text-right">Attendance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {roster.map((r) => {
                        const absent = r.status === 'absent';
                        return (
                          <tr key={r.registration_id} className={absent ? 'bg-red-50/40' : 'hover:bg-slate-50'}>
                            <td className="px-3 py-2">
                              {r.chest_number != null ? <span className="font-mono font-semibold text-navy-800">{r.chest_number}</span> : <span className="text-slate-300">—</span>}
                              {canManual && !locked && <button onClick={() => setManual(r)} className="ml-1.5 text-[10px] text-navy-500 underline" title="Manual chest (rule #4)">edit</button>}
                            </td>
                            <td className={`px-3 py-2 font-medium ${absent ? 'text-red-600 line-through' : 'text-slate-800'}`}>{r.name}</td>
                            <td className="px-3 py-2"><Badge tone={r.status === 'attended' ? 'success' : absent ? 'danger' : 'slate'}>{r.status}</Badge></td>
                            <td className="px-3 py-2">
                              {canMark && !locked ? (
                                <div className="flex items-center justify-end gap-1.5">
                                  <Button size="sm" variant={r.status === 'attended' ? 'primary' : 'outline'} icon={Check} onClick={() => mark(r, true)}>Present</Button>
                                  <Button size="sm" variant={absent ? 'danger' : 'outline'} icon={X} onClick={() => mark(r, false)}>Absent</Button>
                                </div>
                              ) : <span className="text-xs text-slate-400">{locked ? 'locked' : 'view only'}</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
          </Card>
          <p className="mt-2 text-xs text-slate-500">
            Chest numbers restart at 1 for each group and can't be changed once judging has started for that group.
          </p>
        </>
      )}
    </AdminLayout>
  );
}
