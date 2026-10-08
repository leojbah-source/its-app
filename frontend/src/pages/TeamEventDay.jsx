// src/pages/TeamEventDay.jsx
// Team Event-Day — the team equivalent of the individual Event Day screen.
// One row per TEAM: mark attendance, assign a chest number to the TEAM, and see
// each team's members. The team's registration carries the chest/attendance, so
// judging is identical to individual events (judges score the team's chest).
import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { ClipboardCheck, Users, ChevronDown, ChevronRight, RefreshCw, Hash } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { scheduleApi, chestApi } from '../api/client';

const MARK_ROLES = ['SuperAdmin', 'Admin', 'Coordinator', 'Chairman'];
const MANUAL_ROLES = ['SuperAdmin', 'Chairman'];
const today = () => new Date().toISOString().slice(0, 10);

export default function TeamEventDay() {
  const { token, user } = useAuth();
  const canMark = MARK_ROLES.includes(user?.role);
  const canManual = MANUAL_ROLES.includes(user?.role);

  const [schedule, setSchedule] = useState([]);
  const [date, setDate] = useState(today());
  const [eventId, setEventId] = useState('');
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [teams, setTeams] = useState([]);
  const [open, setOpen] = useState(() => new Set());   // expanded team ids
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { scheduleApi.list(token).then(setSchedule).catch(() => {}); }, [token]);

  const scheduleDates = useMemo(
    () => [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(),
    [schedule]);
  useEffect(() => {
    if (scheduleDates.length && !scheduleDates.includes(date)) setDate(scheduleDates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDates]);

  // Team events scheduled on the selected date
  const teamEventsOnDate = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (String(r.event_date).slice(0, 10) !== date) continue;
      if (r.event_kind !== 'team') continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);

  const selectedEvent = teamEventsOnDate.find((e) => String(e.event_id) === String(eventId));
  const selectedGroup = groups.find((g) => String(g.age_group_id) === String(groupId));
  const locked = !!selectedGroup?.locked;

  useEffect(() => { setEventId(''); setGroups([]); setGroupId(''); setTeams([]); }, [date]);
  useEffect(() => {
    setGroupId(''); setTeams([]); setGroups([]);
    if (!eventId) return;
    chestApi.groups(token, eventId).then(setGroups).catch(() => {});
  }, [token, eventId]);

  const reloadGroups = useCallback(() => {
    if (eventId) chestApi.groups(token, eventId).then(setGroups).catch(() => {});
  }, [token, eventId]);

  const loadTeams = useCallback(async () => {
    if (!eventId || !groupId) { setTeams([]); return; }
    setLoading(true); setFlash('');
    try { setTeams(await chestApi.teamRoster(token, eventId, groupId)); }
    catch (err) { setFlash(err.message || 'Could not load teams'); }
    finally { setLoading(false); }
  }, [token, eventId, groupId]);
  useEffect(() => { loadTeams(); }, [loadTeams]);

  const toggleOpen = (id) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function mark(team, present) {
    if (!canMark) return;
    setBusy(true); setFlash('');
    try {
      await chestApi.markAttendance(token, eventId, team.registration_id, present);
      await loadTeams(); reloadGroups();
    } catch (err) { setFlash(err.message || 'Could not update attendance'); }
    finally { setBusy(false); }
  }

  async function assignChests() {
    if (!canMark) return;
    setBusy(true); setFlash('');
    try {
      const r = await chestApi.assignAuto(token, eventId, groupId);
      setFlash(`Assigned ${Array.isArray(r) ? r.length : 0} chest number(s) to teams.`);
      await loadTeams(); reloadGroups();
    } catch (err) { setFlash(err.message || 'Could not assign chest numbers'); }
    finally { setBusy(false); }
  }

  async function clearChests() {
    if (!canManual) return;
    const reason = window.prompt(`Clear chest numbers for ${selectedGroup?.code}? This is a Chairman action — enter a reason:`, '');
    if (reason == null || !reason.trim()) return;
    setBusy(true); setFlash('');
    try {
      const r = await chestApi.clear(token, eventId, groupId, reason.trim());
      setFlash(`Cleared ${r.removed} chest number(s).`);
      await loadTeams(); reloadGroups();
    } catch (err) { setFlash(err.message || 'Could not clear chest numbers'); }
    finally { setBusy(false); }
  }

  async function editChest(team) {
    if (!canManual) return;
    const val = window.prompt(`Set chest number for ${team.team_name}:`, team.chest_number || '');
    if (val == null || !String(val).trim()) return;
    const number = Number(val);
    if (!Number.isInteger(number) || number <= 0) { setFlash('Enter a whole number greater than 0.'); return; }
    setBusy(true); setFlash('');
    try {
      await chestApi.manual(token, team.registration_id, Number(eventId), number, 'manual');
      await loadTeams(); reloadGroups();
    } catch (err) { setFlash(err.message || 'Could not set the chest number'); }
    finally { setBusy(false); }
  }

  const stats = useMemo(() => ({
    total: teams.length,
    attended: teams.filter((t) => t.status === 'attended').length,
    absent: teams.filter((t) => t.status === 'absent').length,
    withChest: teams.filter((t) => t.chest_number != null).length,
  }), [teams]);

  return (
    <AdminLayout title="Team Event Day" subtitle="Mark team attendance and assign chest numbers to teams. Judging is the same as individual events — the chest number represents the team.">
      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {/* Date + event + group selectors */}
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4 p-4">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Date</span>
            <select value={date} onChange={(e) => setDate(e.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm">
              {(scheduleDates.length ? scheduleDates : [date]).map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-slate-500">Team event</span>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)}
              className="min-w-[16rem] rounded-md border border-slate-300 px-3 py-2 text-sm">
              <option value="">Select a team event…</option>
              {teamEventsOnDate.map((e) => <option key={e.event_id} value={e.event_id}>{e.code} · {e.name}</option>)}
            </select>
          </label>
          {eventId && (
            <div className="text-sm">
              <span className="mb-1 block text-xs font-medium text-slate-500">Age group</span>
              <div className="flex flex-wrap gap-1.5">
                {groups.length === 0 && <span className="text-xs text-slate-400">No groups with teams.</span>}
                {groups.map((g) => (
                  <button key={g.age_group_id} onClick={() => setGroupId(String(g.age_group_id))}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${String(groupId) === String(g.age_group_id)
                      ? 'bg-navy-700 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
                    {g.code} <span className="opacity-70">({g.attended}/{g.total})</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {teamEventsOnDate.length === 0 && (
        <p className="text-sm text-slate-400">No team events scheduled on {date}.</p>
      )}

      {eventId && groupId && (
        <>
          {/* Stats + actions */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <Badge tone="navy">{stats.total} teams</Badge>
            <Badge tone="success">{stats.attended} attended</Badge>
            <Badge tone="danger">{stats.absent} absent</Badge>
            <Badge tone="gold">{stats.withChest} with chest</Badge>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" icon={RefreshCw} onClick={loadTeams}>Refresh</Button>
              {canMark && !locked && (
                <Button size="sm" icon={Hash} disabled={busy || stats.attended === 0} onClick={assignChests}>
                  Assign chest numbers
                </Button>
              )}
              {canManual && !locked && stats.withChest > 0 && (
                <Button variant="outline" size="sm" onClick={clearChests} disabled={busy}>Clear</Button>
              )}
            </div>
          </div>
          {locked && <p className="mb-3 text-xs text-amber-600">Chest numbers are locked — judging has started for this group.</p>}

          {loading ? <PageLoader /> : teams.length === 0 ? (
            <p className="text-sm text-slate-400">No teams registered in this group.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-slate-200">
              <table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2 font-medium">Chest</th>
                    <th className="px-3 py-2 font-medium">Team</th>
                    <th className="px-3 py-2 font-medium">School</th>
                    <th className="px-3 py-2 font-medium">Members</th>
                    <th className="px-3 py-2 font-medium">Attendance</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {teams.map((t) => {
                    const isOpen = open.has(t.team_id);
                    return (
                      <Fragment key={t.team_id}>
                        <tr key={`t${t.team_id}`} className="hover:bg-slate-50">
                          <td className="px-3 py-2">
                            <button onClick={() => canManual && editChest(t)} title={canManual ? 'Set chest number' : ''}
                              className={`inline-flex min-w-[2.5rem] items-center justify-center rounded-md border px-2 py-1 font-mono text-base font-bold ${
                                t.chest_number != null ? 'border-gold-300 bg-gold-50 text-gold-700' : 'border-slate-200 bg-slate-50 text-slate-300'} ${canManual ? 'cursor-pointer hover:border-navy-300' : ''}`}>
                              {t.chest_number != null ? t.chest_number : '—'}
                            </button>
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-800">{t.team_name}</td>
                          <td className="px-3 py-2 text-xs text-slate-500">{t.school_name || '—'}</td>
                          <td className="px-3 py-2">
                            <button onClick={() => toggleOpen(t.team_id)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-navy-700 hover:bg-navy-50">
                              {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <Users size={13} /> {(t.members || []).length}
                            </button>
                          </td>
                          <td className="px-3 py-2">
                            {t.status === 'attended' ? <Badge tone="success">Present</Badge>
                              : t.status === 'absent' ? <Badge tone="danger">Absent</Badge>
                              : <Badge tone="slate">Not marked</Badge>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {canMark && !locked && (
                              <div className="inline-flex gap-1">
                                <button onClick={() => mark(t, true)} disabled={busy}
                                  className="rounded-md border border-green-300 px-2 py-1 text-xs text-green-700 hover:bg-green-50 disabled:opacity-50">Present</button>
                                <button onClick={() => mark(t, false)} disabled={busy}
                                  className="rounded-md border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50">Absent</button>
                              </div>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr key={`m${t.team_id}`} className="bg-slate-50/60">
                            <td />
                            <td colSpan={5} className="px-3 py-2">
                              <ul className="divide-y divide-slate-100 rounded-md border border-slate-200 bg-white">
                                {(t.members || []).length === 0 && <li className="px-3 py-2 text-xs text-slate-400">No members recorded.</li>}
                                {(t.members || []).map((m) => (
                                  <li key={m.participant_id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                                    <span className="font-medium text-slate-800">{m.full_name}</span>
                                    {m.is_captain && <Badge tone="gold">Captain</Badge>}
                                    {m.is_substitute && <Badge tone="slate">Sub</Badge>}
                                    <span className="ml-auto font-mono text-xs text-slate-400">{m.cpr_number}</span>
                                    <span className="text-xs text-slate-400">{m.gender || ''}</span>
                                  </li>
                                ))}
                              </ul>
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
    </AdminLayout>
  );
}
