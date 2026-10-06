// src/pages/Registrations.jsx
// Admin registration dashboard — three tabs:
//   1. Registrations  — full list with search/filter/edit
//   2. Participants   — one row per person with event count
//   3. Summary        — counts per event/age group for split-merge monitoring

import { useEffect, useState, useCallback } from 'react';
import { Download, RefreshCw, Users, ClipboardList, BarChart2 } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../context/AuthContext';
import { registrationsApi, participantsApi, API_BASE } from '../api/client';
import RegistrationsTable from './Registrations/RegistrationsTable';
import { useState as useTabState } from 'react';
import RegistrationDrawer from './Registrations/RegistrationDrawer';
import { EmptyState, ErrorBanner, PageLoader } from '../components/ui/States';
import { Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';

// ── Tab helpers ───────────────────────────────────────────────────────────────
const TABS = [
  { id: 'registrations', label: 'Registrations',  icon: ClipboardList },
  { id: 'participants',  label: 'Participants',    icon: Users },
  { id: 'summary',       label: 'Event Summary',  icon: BarChart2 },
];

// ── Main component ────────────────────────────────────────────────────────────
export default function Registrations() {
  const { token } = useAuth();
  const [regTab, setRegTab] = useTabState('individual');
  const [activeTab, setActiveTab] = useState('registrations');
  const [completion, setCompletion] = useState('completed'); // completed | incomplete | all
  const [reminderDue, setReminderDue] = useState(null); // server-side eligible count

  // ── Registrations tab state
  const [registrations, setRegistrations] = useState([]);
  const [regsLoading,   setRegsLoading]   = useState(true);
  const [regsError,     setRegsError]     = useState('');
  const [viewReg,       setViewReg]       = useState(null);

  // ── Participants tab state
  const [participants,  setParticipants]  = useState([]);
  const [partLoading,   setPartLoading]   = useState(false);
  const [partError,     setPartError]     = useState('');
  const [partFetched,   setPartFetched]   = useState(false);

  // ── Summary tab state
  const [summary,       setSummary]       = useState([]);
  const [sumLoading,    setSumLoading]    = useState(false);
  const [sumError,      setSumError]      = useState('');
  const [sumFetched,    setSumFetched]    = useState(false);

  // ── Fetch registrations ───────────────────────────────────────────────────
  const loadRegistrations = useCallback(async () => {
    setRegsLoading(true);
    setRegsError('');
    try {
      const data = await registrationsApi.list(token);
      setRegistrations(data);
    } catch (err) {
      setRegsError(err.message || 'Failed to load registrations');
    } finally {
      setRegsLoading(false);
    }
  }, [token]);

  useEffect(() => { loadRegistrations(); }, [loadRegistrations]);

  const loadReminderDue = useCallback(() => {
    registrationsApi.remindersEligible(token).then((r) => setReminderDue(r.eligible)).catch(() => {});
  }, [token]);
  useEffect(() => { loadReminderDue(); }, [loadReminderDue]);

  // ── Fetch participants (lazy — on tab switch) ─────────────────────────────
  useEffect(() => {
    if (activeTab !== 'participants' || partFetched) return;
    setPartLoading(true);
    setPartError('');
    participantsApi.list(token)
      .then((data) => { setParticipants(data); setPartFetched(true); })
      .catch((err) => setPartError(err.message || 'Failed to load participants'))
      .finally(() => setPartLoading(false));
  }, [activeTab, partFetched, token]);

  // ── Fetch summary (lazy) ──────────────────────────────────────────────────
  useEffect(() => {
    if (activeTab !== 'summary' || sumFetched) return;
    setSumLoading(true);
    setSumError('');
    registrationsApi.summary(token)
      .then((data) => { setSummary(data); setSumFetched(true); })
      .catch((err) => setSumError(err.message || 'Failed to load summary'))
      .finally(() => setSumLoading(false));
  }, [activeTab, sumFetched, token]);

  // ── After editing a registration, update it in local state ───────────────
  function handleRegUpdated(updated) {
    // Called with a registration row (legacy edit) OR with nothing after
    // drawer actions (verify/payment/events) — then just refresh the list.
    if (!updated || updated.id == null) {
      loadRegistrations();
      return;
    }
    setRegistrations((prev) =>
      prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)),
    );
    setViewReg((prev) => (prev ? { ...prev, ...updated } : prev));
  }

  // A registration is "completed" once the parent clicked Complete Registration
  // (participants.confirmed_at is set then). Team entries go through their own
  // deliberate create+pay flow, so they always count as completed here.
  const isCompleted = (r) => (r.team_id ? true : r.confirmed_at != null);
  // Toggle counts are by PARTICIPANT (distinct child/team), not by event row.
  const countParticipants = (rows) =>
    new Set(rows.map((r) => (r.participant_id ? `p${r.participant_id}` : `t${r.team_id}`))).size;
  const completedCount = countParticipants(registrations.filter(isCompleted));
  const incompleteCount = countParticipants(registrations.filter((r) => !isCompleted(r)));
  const allParticipantCount = countParticipants(registrations);
  // Distinct in-progress participants not reminded within the last 5 days.
  const eligibleReminderCount = new Set(
    registrations
      .filter((r) => !isCompleted(r) && r.participant_id &&
        (!r.last_reminder_at || (Date.now() - new Date(r.last_reminder_at).getTime()) >= 5 * 864e5))
      .map((r) => `p${r.participant_id}`),
  ).size;
  const dueCount = reminderDue != null ? reminderDue : eligibleReminderCount;
  async function sendReminders() {
    if (!window.confirm(`Send a WhatsApp reminder to ${dueCount} in-progress parent(s) not messaged in the last 5 days?`)) return;
    try {
      const r = await registrationsApi.sendReminders(token);
      window.alert(`Reminders queued for ${r.eligible} parent(s). They send in the background over WhatsApp.`);
      loadRegistrations(); loadReminderDue();
    } catch (e) { window.alert(e.message || 'Could not send reminders.'); }
  }
  const visibleRegs = completion === 'all'
    ? registrations
    : registrations.filter((r) => (completion === 'completed' ? isCompleted(r) : !isCompleted(r)));

  // ── Header/stat counts ─────────────────────────────────────────────────────
  // "Registrations" = distinct participants (and teams); "Event Registrations"
  // = active event rows (excludes withdrawn/swapped). Reflects the current view.
  const activeRegs = visibleRegs.filter((r) => r.status !== 'withdrawn' && r.status !== 'swapped');
  const participantCount = new Set(
    activeRegs.map((r) => (r.participant_id ? `p${r.participant_id}` : `t${r.team_id}`)),
  ).size;
  const eventRegCount = activeRegs.length;
  const attendedCount = visibleRegs.filter((r) => r.status === 'attended').length;
  const absentCount = visibleRegs.filter((r) => r.status === 'absent').length;
  const statCards = [
    { label: 'Registrations', value: participantCount, tone: 'navy', chip: 'participants' },
    { label: 'Event Registrations', value: eventRegCount, tone: 'navy', chip: 'events' },
    { label: 'Attended', value: attendedCount, tone: 'success', chip: 'attended' },
    { label: 'Absent', value: absentCount, tone: 'danger', chip: 'absent' },
  ];

  return (
    <AdminLayout>
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Registrations</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {registrations.length > 0
              ? `${participantCount} participant${participantCount === 1 ? '' : 's'} · ${eventRegCount} event registration${eventRegCount === 1 ? '' : 's'}`
              : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            icon={RefreshCw}
            onClick={() => {
              loadRegistrations();
              setPartFetched(false);
              setSumFetched(false);
            }}
          >
            Refresh
          </Button>
          <button
            onClick={async () => {
              try {
                const res = await fetch(`${API_BASE}/api/admin/registrations/export`, {
                  headers: { Authorization: `Bearer ${token}` },
                });
                if (!res.ok) throw new Error('Export failed');
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'its-registrations.csv';
                a.click();
                URL.revokeObjectURL(url);
              } catch (err) {
                alert(err.message || 'Export failed.');
              }
            }}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            <Download size={14} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Completion filter — default to finished registrations only */}
      {!regsLoading && registrations.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium text-slate-600">Show</span>
          <div className="flex rounded-lg border border-slate-300 overflow-hidden text-sm font-medium">
            {[
              ['completed', `Completed (${completedCount})`],
              ['incomplete', `In progress (${incompleteCount})`],
              ['all', `All (${allParticipantCount})`],
            ].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCompletion(k)}
                className={`px-3 py-1.5 transition-colors ${
                  completion === k ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {completion === 'incomplete' && (
            <>
              <span className="text-xs text-slate-400">
                These parents started but haven't completed payment &amp; the final step — useful for follow-up.
              </span>
              <button
                onClick={sendReminders}
                disabled={dueCount === 0}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800 disabled:opacity-40"
              >
                Send WhatsApp reminders ({dueCount} due)
              </button>
            </>
          )}
        </div>
      )}

      {/* Stats row — participants vs event registrations, plus attendance */}
      {!regsLoading && registrations.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {statCards.map((c) => (
            <div key={c.label} className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{c.label}</p>
              <div className="flex items-center gap-2">
                <span className="text-2xl font-bold text-slate-900">{c.value}</span>
                <Badge tone={c.tone}>{c.chip}</Badge>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-200">
        <nav className="flex gap-1 -mb-px">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === id
                  ? 'border-navy-600 text-navy-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Tab: Registrations ─────────────────────────────────────────── */}
      {activeTab === 'registrations' && (
        regsLoading ? (
          <PageLoader message="Loading registrations…" />
        ) : regsError ? (
          <ErrorBanner message={regsError} onRetry={loadRegistrations} />
        ) : registrations.length === 0 ? (
          <EmptyState
            title="No registrations yet"
            description="Registrations will appear here once participants start signing up."
          />
        ) : (
          <>
          <div className="mb-4 flex rounded-lg border border-slate-300 overflow-hidden w-fit text-sm font-medium">
            {[['individual', 'Individual events'], ['team', 'Team events']].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setRegTab(k)}
                className={`px-4 py-2 transition-colors ${
                  regTab === k ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {label} ({k === 'individual'
                  ? visibleRegs.filter((r) => r.participant_id).length
                  : visibleRegs.filter((r) => r.team_id).length})
              </button>
            ))}
          </div>
          <RegistrationsTable
            key={regTab + completion}
            registrations={regTab === 'individual'
              ? visibleRegs.filter((r) => r.participant_id)
              : visibleRegs.filter((r) => r.team_id)}
            onView={setViewReg}
          />
          </>
        )
      )}

      {/* ── Tab: Participants ──────────────────────────────────────────── */}
      {activeTab === 'participants' && (
        partLoading ? (
          <PageLoader message="Loading participants…" />
        ) : partError ? (
          <ErrorBanner message={partError} onRetry={() => { setPartFetched(false); }} />
        ) : participants.length === 0 ? (
          <EmptyState
            title="No participants found"
            description="Participants will appear here once they are registered."
          />
        ) : (
          <ParticipantsTable participants={participants} />
        )
      )}

      {/* ── Tab: Event Summary ─────────────────────────────────────────── */}
      {activeTab === 'summary' && (
        <div className="flex flex-col gap-4">
          <SourceSummaryCard token={token} />
          {sumLoading ? (
            <PageLoader message="Loading summary…" />
          ) : sumError ? (
            <ErrorBanner message={sumError} onRetry={() => { setSumFetched(false); }} />
          ) : summary.length === 0 ? (
            <EmptyState
              title="No data yet"
              description="Event registration counts will appear here once participants register."
            />
          ) : (
            <SummaryTable summary={summary} />
          )}
        </div>
      )}

      {/* Drawer */}
      {viewReg && (
        <RegistrationDrawer
          registration={viewReg}
          token={token}
          onClose={() => setViewReg(null)}
          onUpdated={handleRegUpdated}
        />
      )}
    </div>
    </AdminLayout>
  );
}

// ── Participants sub-table ─────────────────────────────────────────────────
function ParticipantsTable({ participants }) {
  const [search, setSearch] = useState('');
  const filtered = participants.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (p.full_name || '').toLowerCase().includes(q) ||
      (p.cpr_number || '').includes(q) ||
      (p.school_name || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-xs">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or CPR…"
            className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none"
          />
        </div>
        <p className="ml-auto text-sm text-slate-500">{filtered.length} participants</p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[700px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">CPR</th>
              <th className="px-4 py-3 font-medium">Group</th>
              <th className="px-4 py-3 font-medium">School</th>
              <th className="px-4 py-3 font-medium">Gender</th>
              <th className="px-4 py-3 font-medium">Membership</th>
              <th className="px-4 py-3 text-right font-medium">Events</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">{p.full_name}</td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{p.cpr_number}</td>
                <td className="px-4 py-3 text-xs font-mono">
                  {p.age_group_code || '—'}
                </td>
                <td className="px-4 py-3 text-slate-600 text-xs">{p.school_name || '—'}</td>
                <td className="px-4 py-3 text-slate-600">{p.gender || '—'}</td>
                <td className="px-4 py-3">
                  {p.membership_status ? (
                    <Badge tone={p.membership_status === 'active' ? 'success' : 'slate'}>
                      {p.membership_status}
                    </Badge>
                  ) : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="font-semibold text-navy-700">{p.event_count ?? 0}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Event summary sub-table ────────────────────────────────────────────────
function SummaryTable({ summary }) {
  // Group by event for easier reading
  const grouped = summary.reduce((acc, row) => {
    const key = row.event_id;
    if (!acc[key]) acc[key] = { event_name: row.event_name, event_code: row.event_code, event_kind: row.event_kind, groups: [] };
    acc[key].groups.push(row);
    return acc;
  }, {});

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-4 py-3 font-medium">Event</th>
            <th className="px-4 py-3 font-medium">Age Group</th>
            <th className="px-4 py-3 text-right font-medium">Registered</th>
            <th className="px-4 py-3 text-right font-medium">Attended</th>
            <th className="px-4 py-3 text-right font-medium">Absent</th>
            <th className="px-4 py-3 text-right font-medium">Withdrawn</th>
            <th className="px-4 py-3 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {Object.values(grouped).map((ev) =>
            ev.groups.map((row, i) => (
              <tr key={`${ev.event_code}-${row.age_group_code}`} className="hover:bg-slate-50">
                {i === 0 ? (
                  <td
                    className="px-4 py-3 font-medium text-slate-800"
                    rowSpan={ev.groups.length}
                  >
                    <span className="font-mono text-xs text-navy-700 mr-2">{ev.event_code}</span>
                    {ev.event_name}
                    {ev.event_kind === 'team' && (
                      <Badge tone="gold" className="ml-2">Team</Badge>
                    )}
                  </td>
                ) : null}
                <td className="px-4 py-3 text-xs font-mono text-slate-600">
                  {row.age_group_code || '—'}
                </td>
                <td className="px-4 py-3 text-right font-semibold text-navy-700">{row.registered}</td>
                <td className="px-4 py-3 text-right text-green-700">{row.attended}</td>
                <td className="px-4 py-3 text-right text-red-600">{row.absent}</td>
                <td className="px-4 py-3 text-right text-slate-500">{row.withdrawn}</td>
                <td className="px-4 py-3 text-right font-bold text-slate-900">{row.total}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}


// ── How parents heard about ITS (sign-up attribution) ──────────────────────
function SourceSummaryCard({ token }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    registrationsApi.sourceSummary(token).then(setData).catch((e) => setErr(e.message || 'Could not load'));
  }, [token]);
  if (err) return null;
  if (!data) return null;
  const max = Math.max(1, ...data.counts.map((c) => c.count));
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-navy-800">How parents heard about ITS this year</h3>
        <span className="text-xs text-slate-400">{data.answered} parent{data.answered === 1 ? '' : 's'} answered</span>
      </div>
      {data.counts.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No responses yet — captured from new sign-ups.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {data.counts.map((c) => (
            <div key={c.source} className="flex items-center gap-3">
              <div className="w-40 shrink-0 text-sm text-slate-600">{c.source}</div>
              <div className="h-4 flex-1 rounded bg-slate-100">
                <div className="h-4 rounded bg-navy-500" style={{ width: `${(c.count / max) * 100}%` }} />
              </div>
              <div className="w-8 shrink-0 text-right text-sm font-semibold text-navy-800">{c.count}</div>
            </div>
          ))}
        </div>
      )}
      {data.others?.length > 0 && (
        <div className="mt-3 border-t border-slate-100 pt-2">
          <p className="mb-1 text-xs font-medium text-slate-500">“Other” notes</p>
          <p className="text-xs text-slate-500">{data.others.join(' · ')}</p>
        </div>
      )}
      <p className="mt-2 text-xs text-slate-400">Parents may select more than one source, so totals can exceed the number who answered.</p>
    </div>
  );
}
