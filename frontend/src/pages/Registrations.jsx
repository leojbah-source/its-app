// src/pages/Registrations.jsx
// Admin registration dashboard — three tabs:
//   1. Registrations  — full list with search/filter/edit
//   2. Participants   — one row per person with event count
//   3. Summary        — counts per event/age group for split-merge monitoring

import { useEffect, useState, useCallback } from 'react';
import { Download, RefreshCw, Users, ClipboardList, BarChart2, FileUp, Mail } from 'lucide-react';
import { Link } from 'react-router-dom';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../context/AuthContext';
import { registrationsApi, participantsApi, API_BASE } from '../api/client';
import RegistrationsTable from './Registrations/RegistrationsTable';
import { useState as useTabState } from 'react';
import RegistrationDrawer from './Registrations/RegistrationDrawer';
import CompleteModal from './Registrations/CompleteModal';
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
  const { token, user } = useAuth();
  const [regTab, setRegTab] = useTabState('individual');
  const [activeTab, setActiveTab] = useState('registrations');
  const [completeReg, setCompleteReg] = useState(null);
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
  const [partScope,     setPartScope]     = useState('completed'); // completed | all

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
      const [data, partial] = await Promise.all([
        registrationsApi.list(token),
        registrationsApi.partial(token).catch(() => []),
      ]);
      setRegistrations([...data, ...partial]);
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
    participantsApi.list(token, partScope === 'all' ? { include: 'all' } : {})
      .then((data) => { setParticipants(data); setPartFetched(true); })
      .catch((err) => setPartError(err.message || 'Failed to load participants'))
      .finally(() => setPartLoading(false));
  }, [activeTab, partFetched, token, partScope]);

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
  const canEmailSchedule = ['SuperAdmin', 'Admin', 'Chairman'].includes(user?.role);
  const [emailOpen, setEmailOpen] = useState(false);
  const [emailInfo, setEmailInfo] = useState(null);
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailResult, setEmailResult] = useState(null);
  const [emailSample, setEmailSample] = useState(null);     // spot-check rows
  const DEFAULT_SCHED_NOTE = 'Please note the reporting time for each event and reach the venue a little early. Some events are still being scheduled — those show "To be announced" below; please keep checking the app for the latest timings.';
  const [emailNote, setEmailNote] = useState(DEFAULT_SCHED_NOTE);
  const [sendMode, setSendMode] = useState('only_unsent');
  const [testTo, setTestTo] = useState(user?.email || '');
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);    // must tick before the real send
  async function openEmailSchedule() {
    setEmailResult(null); setEmailInfo(null); setEmailSample(null); setTestMsg(''); setConfirmSend(false);
    setTestTo(user?.email || ''); setEmailNote(DEFAULT_SCHED_NOTE); setSendMode('only_unsent'); setEmailOpen(true);
    try { setEmailInfo(await registrationsApi.scheduleEmailRecipients(token)); }
    catch (e) { setEmailInfo({ error: e.message }); }
    try { setEmailSample(await registrationsApi.scheduleEmailSample(token, 10)); }
    catch { setEmailSample([]); }
  }
  async function sendTestEmail() {
    if (!testTo.trim()) { setTestMsg('Enter an email address for the test.'); return; }
    setTestBusy(true); setTestMsg('');
    try { const r = await registrationsApi.scheduleEmailTest(token, testTo.trim(), null, emailNote); setTestMsg(`✓ Test sent to ${r.to} (using ${r.sample_of}'s schedule). Open it and check it's correct.`); }
    catch (e) { setTestMsg(e.message || 'Could not send the test.'); }
    finally { setTestBusy(false); }
  }
  async function openPreview(participantId) {
    try {
      const r = await registrationsApi.scheduleEmailPreview(token, participantId, emailNote);
      const w = window.open('', '_blank');
      if (w) { w.document.open(); w.document.write(r.html); w.document.close(); }
    } catch (e) { setTestMsg(e.message || 'Could not open preview.'); }
  }
  async function sendScheduleEmails() {
    setEmailBusy(true);
    try { setEmailResult(await registrationsApi.scheduleEmailSend(token, emailNote, sendMode)); }
    catch (e) { setEmailResult({ error: e.message }); }
    finally { setEmailBusy(false); }
  }
  async function downloadSendLog() {
    try {
      const blob = await registrationsApi.scheduleEmailLogExport(token);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'schedule-email-log.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setTestMsg(e.message || 'Could not download the log.'); }
  }

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
  // Counts split by kind: individual participants vs teams.
  const individualCount = new Set(
    activeRegs.filter((r) => r.participant_id).map((r) => `p${r.participant_id}`),
  ).size;
  const teamCount = new Set(
    activeRegs.filter((r) => r.team_id).map((r) => `t${r.team_id}`),
  ).size;
  const participantCount = individualCount + teamCount;
  const indivEventRegCount = activeRegs.filter((r) => r.participant_id && !r.no_events).length;
  const teamEventRegCount = activeRegs.filter((r) => r.team_id && !r.no_events).length;
  const eventRegCount = indivEventRegCount + teamEventRegCount;
  const attendedCount = visibleRegs.filter((r) => r.status === 'attended').length;
  const absentCount = visibleRegs.filter((r) => r.status === 'absent').length;
  const statCards = [
    { label: 'Registrations', value: participantCount, tone: 'navy', chip: 'participants',
      sub: `${individualCount} individual · ${teamCount} team` },
    { label: 'Event Registrations', value: eventRegCount, tone: 'navy', chip: 'events',
      sub: `${indivEventRegCount} individual · ${teamEventRegCount} team` },
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
              ? `${individualCount} individual · ${teamCount} team${teamCount === 1 ? '' : 's'} · ${eventRegCount} event registration${eventRegCount === 1 ? '' : 's'}`
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
          <Link
            to="/admin/import"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            <FileUp size={14} />
            Import walk-ins
          </Link>
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
                a.download = 'its-registrations.xlsx';
                a.click();
                URL.revokeObjectURL(url);
              } catch (err) {
                alert(err.message || 'Export failed.');
              }
            }}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            <Download size={14} />
            Export Excel
          </button>
          {canEmailSchedule && (
            <button
              onClick={openEmailSchedule}
              className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
            >
              <Mail size={14} />
              Email schedule
            </button>
          )}
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
              {c.sub && <p className="mt-1 text-[11px] text-slate-400">{c.sub}</p>}
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
          {/* Team entries are always complete, so the In-progress view is
              individual-only. Elsewhere, switch between individual and team. */}
          {(() => {
            const tabs = completion === 'incomplete'
              ? [['individual', 'Individual events']]
              : [['individual', 'Individual events'], ['team', 'Team events']];
            const effTab = completion === 'incomplete' ? 'individual' : regTab;
            return (
              <>
              {tabs.length > 1 && (
                <div className="mb-4 flex rounded-lg border border-slate-300 overflow-hidden w-fit text-sm font-medium">
                  {tabs.map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setRegTab(k)}
                      className={`px-4 py-2 transition-colors ${
                        effTab === k ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {label} ({k === 'individual'
                        ? visibleRegs.filter((r) => r.participant_id).length
                        : visibleRegs.filter((r) => r.team_id).length})
                    </button>
                  ))}
                </div>
              )}
              <RegistrationsTable
                key={effTab + completion}
                registrations={effTab === 'individual'
                  ? visibleRegs.filter((r) => r.participant_id)
                  : visibleRegs.filter((r) => r.team_id)}
                onView={setViewReg}
                onComplete={setCompleteReg}
              />
              </>
            );
          })()}
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
          <ParticipantsTable
            participants={participants}
            scope={partScope}
            onScopeChange={(sc) => { setPartScope(sc); setPartFetched(false); }}
            onView={(p) => setViewReg({ participant_id: p.id, participant_name: p.full_name, team_id: null, confirmed_at: p.confirmed ? 'x' : null })}
          />
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
          onClose={() => { setViewReg(null); setPartFetched(false); }}
          onUpdated={handleRegUpdated}
        />
      )}

      {completeReg && (
        <CompleteModal
          token={token}
          registration={completeReg}
          onClose={() => setCompleteReg(null)}
          onCompleted={() => { setCompleteReg(null); loadRegistrations(); }}
        />
      )}

      {emailOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !emailBusy && setEmailOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-navy-900">Email the schedule to parents</h3>
            {!emailResult ? (
              <>
                <p className="mt-2 text-sm text-slate-600">
                  Each parent gets an email with <b>only their own child's</b> events &amp; reporting times
                  (the published schedule), the app (PWA) links, and the WhatsApp group invite. Please verify
                  the sample below and send yourself a test before sending to everyone.
                </p>
                {emailInfo?.error ? (
                  <p className="mt-3 text-sm text-red-600">{emailInfo.error}</p>
                ) : !emailInfo ? (
                  <p className="mt-3 text-sm text-slate-400">Checking recipients…</p>
                ) : (
                  <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <div><b>{emailInfo.with_email}</b> parent email(s) in scope{emailInfo.confirmed > emailInfo.with_email ? ` (of ${emailInfo.confirmed} confirmed; ${emailInfo.confirmed - emailInfo.with_email} have no email on file)` : ''}.</div>
                    {emailInfo.already_sent > 0 && (
                      <div className="mt-1">Already sent: <b>{emailInfo.already_sent}</b> · Not yet sent: <b>{emailInfo.unsent}</b></div>
                    )}
                    {emailInfo.already_sent > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        <label className="flex items-center gap-2"><input type="radio" name="sendmode" checked={sendMode === 'only_unsent'} onChange={() => setSendMode('only_unsent')} /> Send only to the <b>{emailInfo.unsent}</b> not yet sent (recommended)</label>
                        <label className="flex items-center gap-2"><input type="radio" name="sendmode" checked={sendMode === 'all'} onChange={() => setSendMode('all')} /> Send to everyone ({emailInfo.with_email}) — re-sends to those already emailed</label>
                      </div>
                    )}
                    {!emailInfo.wa_group_link_set && <div className="mt-2 text-amber-700">No WhatsApp group link is set in Year Setup — the email will go out without the group invite. Add it in Year Setup → Identity &amp; branding to include it.</div>}
                  </div>
                )}

                {/* Editable message shown in every email */}
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Message to parents (editable)</p>
                  <textarea value={emailNote} onChange={(e) => setEmailNote(e.target.value)} rows={3}
                    placeholder="Optional note shown in the email, e.g. not all schedules are out yet."
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
                  <p className="mt-1 text-[11px] text-slate-400">Shown as a highlighted note under the greeting. Each event still shows its own date/time, or “To be announced” if not scheduled yet. Preview/Test reflect this text.</p>
                </div>

                {/* Spot-check: a sample of recipients with their OWN events */}
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Spot-check — sample recipients (each shows only their own events)</p>
                  {!emailSample ? <p className="text-sm text-slate-400">Loading sample…</p>
                    : emailSample.length === 0 ? <p className="text-sm text-slate-400">No recipients to sample.</p> : (
                    <div className="overflow-x-auto rounded-lg border border-slate-200">
                      <table className="min-w-full text-xs">
                        <thead className="bg-slate-50 text-slate-500">
                          <tr><th className="px-2 py-1.5 text-left">Participant</th><th className="px-2 py-1.5 text-left">Grp</th><th className="px-2 py-1.5 text-left">Their events</th><th className="px-2 py-1.5 text-left">Parent email</th><th className="px-2 py-1.5"></th></tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {emailSample.map((r) => (
                            <tr key={r.participant_id} className="align-top">
                              <td className="px-2 py-1.5 whitespace-nowrap font-medium text-slate-800">{r.participant_name}<div className="text-[10px] font-normal text-slate-400">CPR …{r.cpr_last4}</div></td>
                              <td className="px-2 py-1.5 text-slate-600">{r.age_group || '—'}</td>
                              <td className="px-2 py-1.5 text-slate-600">
                                {r.events.map((e, i) => (
                                  <div key={i}><span className="font-mono text-navy-700">{e.event_code}</span> {e.event_name} — <span className="text-slate-500">{e.when}{e.venue ? ` · ${e.venue}` : ''}</span></div>
                                ))}
                              </td>
                              <td className="px-2 py-1.5 whitespace-nowrap text-slate-600">{r.parent_email}</td>
                              <td className="px-2 py-1.5"><button onClick={() => openPreview(r.participant_id)} className="text-navy-600 hover:underline whitespace-nowrap">Preview</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="mt-1 text-[11px] text-slate-400">Preview opens the exact email that parent would receive, in a new tab.</p>
                </div>

                {/* Test send */}
                <div className="mt-4 rounded-lg border border-slate-200 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Send a test to yourself first</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" type="email"
                      className="flex-1 min-w-[200px] rounded-md border border-slate-300 px-3 py-1.5 text-sm" />
                    <button onClick={sendTestEmail} disabled={testBusy}
                      className="rounded-md border border-navy-300 bg-white px-3 py-1.5 text-sm font-medium text-navy-700 hover:bg-navy-50 disabled:opacity-50">
                      {testBusy ? 'Sending…' : 'Send test'}
                    </button>
                  </div>
                  {testMsg && <p className="mt-2 text-xs text-slate-600">{testMsg}</p>}
                </div>

                <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={confirmSend} onChange={(e) => setConfirmSend(e.target.checked)} className="mt-0.5 h-4 w-4" />
                  <span>I've checked the sample (and/or a test email) and the schedules shown are correct for each participant.</span>
                </label>

                <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setEmailOpen(false)} disabled={emailBusy} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Cancel</button>
                  <button onClick={sendScheduleEmails} disabled={emailBusy || !emailInfo || !!emailInfo.error || !emailInfo.with_email || !confirmSend}
                    className="rounded-md bg-navy-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-navy-700 disabled:bg-navy-300">
                    {emailBusy ? 'Sending…' : `Send to ${(emailInfo && emailInfo.already_sent > 0 && sendMode === 'only_unsent') ? emailInfo.unsent : (emailInfo?.with_email ?? '')} parent(s)`}
                  </button>
                </div>
                {emailBusy && <p className="mt-2 text-xs text-slate-400">This can take a minute for many recipients — please keep this window open.</p>}
              </>
            ) : (
              <>
                {emailResult.error ? (
                  <p className="mt-3 text-sm text-red-600">{emailResult.error}</p>
                ) : (
                  <div className="mt-3 text-sm text-slate-700">
                    <p><b>{emailResult.sent}</b> sent{emailResult.failed ? `, ${emailResult.failed} failed` : ''} (of {emailResult.recipients}).</p>
                    {emailResult.email_configured === false && <p className="mt-2 text-amber-700">Email isn't configured on the server (SMTP), so nothing was sent. Set up SMTP and try again.</p>}
                    {emailResult.failed > 0 && <p className="mt-2 text-slate-600">Download the log to see exactly who failed and why, then re-open this dialog and choose “only those not yet sent” to retry the rest.</p>}
                  </div>
                )}
                <div className="mt-4 flex items-center justify-between">
                  <button onClick={downloadSendLog} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-navy-700 hover:bg-slate-50"><Download size={14} /> Download send log</button>
                  <button onClick={() => { setEmailOpen(false); setEmailResult(null); }} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
    </AdminLayout>
  );
}

// ── Participants sub-table ─────────────────────────────────────────────────
function ParticipantsTable({ participants, scope = 'completed', onScopeChange, onView }) {
  const [search, setSearch] = useState('');
  const filtered = participants.filter((p) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      (p.full_name || '').toLowerCase().includes(q) ||
      (p.cpr_number || '').includes(q) ||
      (p.school_name || '').toLowerCase().includes(q) ||
      (p.parent_name || '').toLowerCase().includes(q) ||
      (p.parent_email || '').toLowerCase().includes(q) ||
      (p.parent_phone || '').toLowerCase().includes(q) ||
      (p.guardian_name || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search participant, parent, CPR, email, phone…"
            className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:outline-none"
          />
        </div>
        <div className="flex rounded-md border border-slate-300 overflow-hidden text-xs font-medium">
          {[['completed', 'Completed'], ['all', 'All (incl. team members)']].map(([k, label]) => (
            <button key={k} onClick={() => onScopeChange && onScopeChange(k)}
              className={`px-3 py-2 transition-colors ${scope === k ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {label}
            </button>
          ))}
        </div>
        <p className="ml-auto text-sm text-slate-500">{filtered.length} participants</p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[820px] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">CPR</th>
              <th className="px-4 py-3 font-medium">Group</th>
              <th className="px-4 py-3 font-medium">School</th>
              <th className="px-4 py-3 font-medium">Parent</th>
              <th className="px-4 py-3 font-medium">Gender</th>
              <th className="px-4 py-3 font-medium">Membership</th>
              <th className="px-4 py-3 text-right font-medium">Events</th>
              <th className="px-4 py-3 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {p.full_name}
                  {p.on_team && Number(p.event_count || 0) === 0 && (
                    <span className="ml-2 inline-block rounded bg-gold-100 px-1.5 py-0.5 text-[10px] font-semibold text-gold-700">TEAM ONLY</span>
                  )}
                  {p.confirmed === false && (
                    <span className="ml-1 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">In progress</span>
                  )}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-slate-500">{p.cpr_number}</td>
                <td className="px-4 py-3 text-xs font-mono">
                  {p.age_group_code || '—'}
                </td>
                <td className="px-4 py-3 text-slate-600 text-xs">{p.school_name || '—'}</td>
                <td className="px-4 py-3 text-xs">
                  {(p.parent_name || p.guardian_name) ? (
                    <div className="flex flex-col">
                      <span className="text-slate-700">{p.parent_name || p.guardian_name}</span>
                      {p.parent_email && <span className="text-slate-400">{p.parent_email}</span>}
                      {p.parent_phone && <span className="text-slate-400 font-mono">{p.parent_phone}</span>}
                    </div>
                  ) : <span className="text-slate-400">—</span>}
                </td>
                <td className={`px-4 py-3 ${p.gender ? 'text-slate-600' : 'text-red-500 font-medium'}`}>{p.gender || 'missing'}</td>
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
                <td className="px-4 py-3 text-right">
                  {onView && (
                    <button onClick={() => onView(p)} className="text-xs font-medium text-navy-600 hover:underline">Open</button>
                  )}
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
