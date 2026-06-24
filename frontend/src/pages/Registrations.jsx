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
  const [activeTab, setActiveTab] = useState('registrations');

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
    setRegistrations((prev) =>
      prev.map((r) => (r.id === updated.id ? { ...r, ...updated } : r)),
    );
    setViewReg((prev) => (prev ? { ...prev, ...updated } : prev));
  }

  return (
    <AdminLayout>
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Registrations</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {registrations.length > 0
              ? `${registrations.filter((r) => r.status === 'registered').length} active registrations`
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
          <a
            href={`${API_BASE}/api/admin/registrations/export`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
          >
            <Download size={14} />
            Export CSV
          </a>
        </div>
      </div>

      {/* Stats row — quick counts from loaded registrations */}
      {!regsLoading && registrations.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {['registered', 'attended', 'absent', 'withdrawn', 'swapped'].map((s) => {
            const count = registrations.filter((r) => r.status === s).length;
            const tones = { registered: 'navy', attended: 'success', absent: 'danger', withdrawn: 'slate', swapped: 'gold' };
            return (
              <div key={s} className="rounded-lg border border-slate-200 bg-white p-4">
                <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold text-slate-900">{count}</span>
                  <Badge tone={tones[s]}>{s}</Badge>
                </div>
              </div>
            );
          })}
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
          <RegistrationsTable
            registrations={registrations}
            onView={setViewReg}
          />
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
        sumLoading ? (
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
        )
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
