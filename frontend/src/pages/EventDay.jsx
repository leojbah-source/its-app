// src/pages/EventDay.jsx
// Day-of, PER GROUP (an event is group-level: "Clay Modelling G4" and
// "Clay Modelling G2" are separate contests). Day → Event → Group; mark
// attendance; assign chest numbers (restart at 1 per group) with a dramatized
// on-screen draw. Chest numbers LOCK once judging starts (a score exists).
import { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, Hash, Trash2, Check, X, Lock, Sparkles, Video } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { scheduleApi, chestApi, videoApi } from '../api/client';

const MARK_ROLES = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
const MANUAL_ROLES = ['SuperAdmin', 'Chairman'];
const today = () => new Date().toLocaleDateString('en-CA');
const fmtDay = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : d);

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
  const isChairSuper = ['SuperAdmin', 'Chairman'].includes(user?.role);

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
  const [manualEdit, setManualEdit] = useState(null);

  useEffect(() => { scheduleApi.list(token).then(setSchedule).catch(() => {}); }, [token]);

  const scheduleDates = useMemo(() =>
    [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(), [schedule]);

  // Default to the first scheduled date (today usually has no events).
  useEffect(() => {
    if (scheduleDates.length && !scheduleDates.includes(date)) setDate(scheduleDates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDates]);

  const eventsOnDate = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (String(r.event_date).slice(0, 10) !== date) continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name, event_kind: r.event_kind, category_name: r.category_name, category_code: r.category_code, sessions: [] });
      map.get(r.event_id).sessions.push({ venue: r.venue, start: (r.start_time || '').slice(0, 5), end: (r.end_time || '').slice(0, 5), age_groups: r.age_groups });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);

  const selectedEvent = eventsOnDate.find((e) => String(e.event_id) === String(eventId));
  const selectedGroup = groups.find((g) => String(g.age_group_id) === String(groupId));
  // Video recording is offered only for dance events (category NATYA) and all team events.
  const videoEligible = !!selectedEvent && (
    selectedEvent.event_kind === 'team'
    || /natya/i.test(selectedEvent.category_code || '')
    || /dance/i.test(selectedEvent.category_name || '')
  );
  const selectedGroupCode = selectedGroup?.code;
  const locked = !!selectedGroup?.locked;
  const groupSession = useMemo(() => {
    if (!selectedEvent || !selectedGroupCode) return null;
    return selectedEvent.sessions.find((s) => (s.age_groups || '').split(', ').includes(selectedGroupCode)) || selectedEvent.sessions[0] || null;
  }, [selectedEvent, selectedGroupCode]);

  // Only the age groups scheduled for THIS event on THIS date (from the schedule's
  // per-session age_groups) — not every group that merely has entries for the event.
  const scheduledCodes = useMemo(() => {
    const set = new Set();
    if (selectedEvent) for (const s of selectedEvent.sessions)
      for (const c of (s.age_groups || '').split(',').map((x) => x.trim()).filter(Boolean)) set.add(c);
    return set;
  }, [selectedEvent]);
  const visibleGroups = useMemo(
    () => (scheduledCodes.size ? groups.filter((g) => scheduledCodes.has(g.code)) : groups),
    [groups, scheduledCodes]);

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

  // ── Video recording opt-in (per registration) ─────────────────────────────
  async function setVideo(reg, method) {
    setRoster((prev) => prev.map((x) => (x.registration_id === reg.registration_id
      ? { ...x, video_wants: true, video_method: method } : x)));
    try {
      const r = await videoApi.setRequest(token, eventId, reg.registration_id, method);
      setRoster((prev) => prev.map((x) => (x.registration_id === reg.registration_id
        ? { ...x, video_wants: true, video_method: r.payment_method, video_amount: r.amount } : x)));
    } catch (err) { setFlash(err.message); loadRoster(); }
  }
  async function removeVideo(reg) {
    setRoster((prev) => prev.map((x) => (x.registration_id === reg.registration_id
      ? { ...x, video_wants: false, video_method: null, video_recorded: false } : x)));
    try { await videoApi.remove(token, reg.registration_id); }
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
    try { const r = await chestApi.clear(token, eventId, groupId, reason.trim()); setFlash(`Cleared ${r.removed} chest number(s)${r.video_cleared ? ` and ${r.video_cleared} video request(s)` : ''}.`); loadRoster(); reloadGroups(); }
    catch (err) { setFlash(err.message); }
  }
  function setManual(reg) { setManualEdit(reg); }
  async function submitManual(number, mode) {
    try {
      await chestApi.manual(token, manualEdit.registration_id, Number(eventId), number, mode);
      loadRoster(); reloadGroups();
      return null;
    } catch (err) { return err.message || 'Could not update the chest number.'; }
  }

  const counts = useMemo(() => ({
    total: roster.length,
    attended: roster.filter((r) => r.status === 'attended').length,
    absent: roster.filter((r) => r.status === 'absent').length,
    withChest: roster.filter((r) => r.chest_number != null).length,
    awaiting: roster.filter((r) => r.status === 'attended' && r.chest_number == null).length,
    unmarked: roster.filter((r) => r.status === 'registered').length,
    video: roster.filter((r) => r.video_wants).length,
  }), [roster]);

  const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  return (
    <AdminLayout title="Event day" subtitle="Mark attendance, then assign chest numbers per age group. Numbers restart at 1 for each group and lock once judging starts.">
      {draw && <DrawOverlay items={draw} onClose={() => setDraw(null)} />}
      {manualEdit && (
        <ManualChestModal
          reg={manualEdit}
          roster={roster}
          groupCode={selectedGroupCode}
          onClose={() => setManualEdit(null)}
          onSubmit={submitManual}
        />
      )}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Day</label>
            <select value={date} onChange={(e) => setDate(e.target.value)} className={sel}>
              {scheduleDates.length === 0 && <option value="">No scheduled dates yet</option>}
              {scheduleDates.map((d) => <option key={d} value={d}>{fmtDay(d)}</option>)}
            </select>
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
              {visibleGroups.length === 0 && <span className="text-xs text-slate-400">No groups scheduled on this day.</span>}
              {visibleGroups.map((g) => (
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
            {videoEligible && counts.video > 0 && <Badge tone="navy">{counts.video} video</Badge>}
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
          {!locked && canMark && !isChairSuper && counts.withChest > 0 && (
            <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Chest numbers are assigned for this group — attendance can now be changed only by a Chairman or SuperAdmin.
            </div>
          )}

          <Card className="p-0 overflow-hidden">
            {loading ? <div className="p-6"><PageLoader label="Loading roster…" /></div>
              : roster.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">No entries for this group.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[860px] text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 w-20">Chest</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">Status</th>
                        {videoEligible && <th className="px-3 py-2">Video</th>}
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
                            {videoEligible && (
                              <td className="px-3 py-2">
                                {absent ? (
                                  r.video_wants
                                    ? <Badge tone="slate">{r.video_method === 'benefitpay' ? 'BenefitPay' : 'Cash'}</Badge>
                                    : <span className="text-xs text-slate-300">—</span>
                                ) : r.video_wants ? (
                                  <div className="flex items-center gap-1.5">
                                    {canMark && !locked ? (
                                      <select value={r.video_method || 'cash'} onChange={(e) => setVideo(r, e.target.value)}
                                        className="rounded border border-slate-300 px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-navy-300">
                                        <option value="cash">Cash</option>
                                        <option value="benefitpay">BenefitPay</option>
                                      </select>
                                    ) : <Badge tone="navy">{r.video_method === 'benefitpay' ? 'BenefitPay' : 'Cash'}</Badge>}
                                    {r.video_recorded && <Badge tone="success">recorded</Badge>}
                                    {canMark && !locked && (
                                      <button onClick={() => removeVideo(r)} className="text-slate-400 hover:text-red-500" title="Remove video request"><X size={14} /></button>
                                    )}
                                  </div>
                                ) : (
                                  canMark && !locked
                                    ? <Button size="sm" variant="outline" icon={Video} onClick={() => setVideo(r, 'cash')}>Video</Button>
                                    : <span className="text-xs text-slate-300">—</span>
                                )}
                              </td>
                            )}
                            <td className="px-3 py-2">
                              {canMark && !locked && (isChairSuper || counts.withChest === 0) ? (
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

// Manual chest edit — enter a number; if it's already taken, choose whether to
// SWAP with the current holder or INSERT (shift the others).
function ManualChestModal({ reg, roster, groupCode, onClose, onSubmit }) {
  const [val, setVal] = useState(reg.chest_number ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const target = Number(val);
  const valid = Number.isInteger(target) && target >= 1;
  const occupant = roster.find((r) => r.chest_number === target && r.registration_id !== reg.registration_id);
  const same = valid && target === reg.chest_number;
  const canSwap = reg.chest_number != null;

  async function go(mode) {
    if (!valid) { setErr('Enter a valid chest number.'); return; }
    setBusy(true); setErr('');
    const e = await onSubmit(target, mode);
    setBusy(false);
    if (e) setErr(e); else onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold text-navy-900">Chest number — {reg.name}</h2>
        <p className="mb-3 text-xs text-slate-500">Group {groupCode || ''} · current: {reg.chest_number ?? '—'}</p>
        <input type="number" min="1" value={val} autoFocus
          onChange={(e) => { setVal(e.target.value); setErr(''); }}
          className="mb-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300" />
        {err && <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{err}</div>}
        {!valid || same ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled>{same ? 'No change' : 'Save'}</Button>
          </div>
        ) : occupant ? (
          <div className="flex flex-col gap-2">
            <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800">
              Chest {target} currently belongs to <b>{occupant.name}</b>. How should this apply?
            </div>
            {canSwap && (
              <Button variant="primary" loading={busy} onClick={() => go('swap')}>
                Swap — {occupant.name} takes {reg.chest_number}
              </Button>
            )}
            <Button variant={canSwap ? 'outline' : 'primary'} loading={busy} onClick={() => go('reorder')}>
              Insert at {target} — shift the others
            </Button>
            <button className="mt-0.5 text-xs text-slate-500 hover:underline" onClick={onClose}>Cancel</button>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => go('set')}>Save</Button>
          </div>
        )}
      </div>
    </div>
  );
}
