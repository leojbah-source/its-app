// src/pages/registrations/RegistrationsTable.jsx
import { useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, ArrowUpDown, Search, Eye } from 'lucide-react';
import { Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/States';

// status → badge tone
const STATUS_TONE = {
  registered: 'navy',
  attended:   'success',
  absent:     'danger',
  withdrawn:  'slate',
  swapped:    'gold',
};

const COLUMNS = [
  { key: 'participant_name', label: 'Participant' },
  { key: 'age_group_code',   label: 'Group' },
  { key: 'school_name',      label: 'School' },
  { key: 'event_code',       label: 'Code' },
  { key: 'event_name',       label: 'Event' },
  { key: 'category_name',    label: 'Category' },
  { key: 'event_kind',       label: 'Type' },
  { key: 'status',           label: 'Status' },
];

const PAGE_SIZES = [25, 50, 100];

export default function RegistrationsTable({ registrations, onView }) {
  const [mode,     setMode]     = useState('participant'); // 'participant' | 'entries'
  const [search,   setSearch]   = useState('');
  const [status,   setStatus]   = useState('');   // '' = all, 'registered'
  const [payment,  setPayment]  = useState('');   // '' | cash | benefitpay | bank_transfer | none
  const [cprVerify, setCprVerify] = useState('');  // '' | ocr | manual (entry method)
  const [adminVerify, setAdminVerify] = useState(''); // '' | verified | pending | issue
  const [payStatus, setPayStatus] = useState('');  // '' | verified | pending | none
  const [member,   setMember]   = useState('');   // '' | yes | no
  const [ageGroup, setAgeGroup] = useState('');
  const [school,   setSchool]   = useState('');
  const [sortKey,  setSortKey]  = useState('participant_name');
  const [sortDir,  setSortDir]  = useState('asc');
  const [page,     setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = registrations;

    if (q) {
      rows = rows.filter((r) =>
        (r.participant_name || '').toLowerCase().includes(q) ||
        (r.cpr_number       || '').includes(q) ||
        (r.event_name       || '').toLowerCase().includes(q) ||
        (r.event_code       || '').toLowerCase().includes(q) ||
        (r.school_name      || '').toLowerCase().includes(q),
      );
    }
    if (status) rows = rows.filter((r) => r.status === status);
    if (payment) {
      rows = rows.filter((r) => {
        const methods = (r.payment_methods || '').split(',').filter(Boolean);
        return payment === 'none' ? methods.length === 0 : methods.includes(payment);
      });
    }
    if (cprVerify) rows = rows.filter((r) => (r.cpr_verified_method || 'manual') === cprVerify);
    if (adminVerify) rows = rows.filter((r) => (r.admin_verified_status || 'pending') === adminVerify);
    if (payStatus) rows = rows.filter((r) => (r.payment_status || 'none') === payStatus);
    if (member) rows = rows.filter((r) =>
      member === 'yes'
        ? r.parent_membership_status === 'active'
        : r.parent_membership_status !== 'active');
    if (ageGroup) rows = rows.filter((r) => r.age_group_code === ageGroup);
    if (school) rows = rows.filter((r) => (r.school_name || '') === school);

    const sorted = [...rows].sort((a, b) => {
      const av = (a[sortKey] ?? '').toString().toLowerCase();
      const bv = (b[sortKey] ?? '').toString().toLowerCase();
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (sortDir === 'asc' ? 1 : -1);
    });
    return sorted;
  }, [registrations, search, status, payment, cprVerify, adminVerify, payStatus, member, ageGroup, school, sortKey, sortDir]);

  const ageGroups = useMemo(
    () => [...new Set(registrations.map((r) => r.age_group_code).filter(Boolean))].sort(),
    [registrations]);
  const schools = useMemo(
    () => [...new Set(registrations.map((r) => r.school_name).filter(Boolean))].sort(),
    [registrations]);

  // One row per participant with their events aggregated
  const groupedRows = useMemo(() => {
    const map = new Map();
    for (const r of filtered) {
      const key = r.participant_id ?? `t${r.team_id}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          participant_name: r.participant_name || r.team_name || '—',
          is_team: !r.participant_id,
          team_member_count: r.team_member_count,
          admin_verified_status: r.admin_verified_status,
          payment_status: r.payment_status,
          cpr_number: r.cpr_number,
          age_group_code: r.age_group_code,
          school_name: r.school_name,
          events: [],
          first: r,
        });
      }
      map.get(key).events.push(r);
    }
    return [...map.values()].sort((a, b) =>
      a.participant_name.localeCompare(b.participant_name));
  }, [filtered]);

  const totalPages  = Math.max(1, Math.ceil(
    (mode === 'participant' ? groupedRows.length : filtered.length) / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows    = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pageGroups  = groupedRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search name, CPR, event…"
            className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-300"
          />
        </div>
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">All</option>
          <option value="registered">Registered</option>
        </select>
        <select
          value={payment}
          onChange={(e) => { setPayment(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">Payment: any</option>
          <option value="cash">KCA office (cash)</option>
          <option value="benefitpay">BenefitPay</option>
          <option value="bank_transfer">Bank transfer</option>
          <option value="none">No payment yet</option>
        </select>
        <select
          value={cprVerify}
          onChange={(e) => { setCprVerify(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">Entry: any</option>
          <option value="ocr">Entry: OCR scan</option>
          <option value="manual">Entry: manual</option>
        </select>
        <select
          value={adminVerify}
          onChange={(e) => { setAdminVerify(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">CPR check: any</option>
          <option value="verified">CPR verified</option>
          <option value="pending">Not verified yet</option>
          <option value="issue">Issue flagged</option>
        </select>
        <select
          value={payStatus}
          onChange={(e) => { setPayStatus(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">Payment: any status</option>
          <option value="verified">Payment verified</option>
          <option value="pending">Payment pending</option>
          <option value="none">No payment</option>
        </select>
        <select
          value={member}
          onChange={(e) => { setMember(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">KCA member: any</option>
          <option value="yes">KCA member</option>
          <option value="no">Non-member</option>
        </select>
        <select
          value={ageGroup}
          onChange={(e) => { setAgeGroup(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">Age group: all</option>
          {ageGroups.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
        <select
          value={school}
          onChange={(e) => { setSchool(e.target.value); setPage(1); }}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:outline-none"
        >
          <option value="">School: all</option>
          {schools.map((sc) => <option key={sc} value={sc}>{sc}</option>)}
        </select>
        <div className="flex rounded-md border border-slate-300 overflow-hidden text-xs font-medium">
          {[['participant', 'By participant'], ['entries', 'By event entry']].map(([m, label]) => (
            <button
              key={m}
              onClick={() => { setMode(m); setPage(1); }}
              className={`px-3 py-2 transition-colors ${
                mode === m ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="ml-auto text-sm text-slate-500">
          {mode === 'participant'
            ? `${groupedRows.length} participants · ${filtered.length} event entries`
            : `${filtered.length} of ${registrations.length} registrations`}
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No registrations match your filters"
          description="Try adjusting the search or status filter."
        />
      ) : mode === 'participant' ? (
        <div className="overflow-x-auto scroll-thin rounded-lg border border-slate-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Participant</th>
                <th className="px-4 py-3 font-medium">Group</th>
                <th className="px-4 py-3 font-medium">School</th>
                <th className="px-4 py-3 font-medium">Events</th>
                <th className="px-4 py-3 font-medium">Verification</th>
                <th className="px-4 py-3 font-medium">Registered events</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageGroups.map((g) => (
                <tr key={g.key} className="hover:bg-slate-50 align-top">
                  <td className="px-4 py-3">
                    <span className="font-medium text-slate-800">{g.participant_name}</span>
                    {g.is_team && (
                      <span className="ml-2 inline-block rounded bg-gold-100 text-gold-700 px-1.5 py-0.5 text-[10px] font-semibold">
                        TEAM · {g.team_member_count ?? 0} member{(g.team_member_count ?? 0) !== 1 ? 's' : ''}
                      </span>
                    )}
                    {g.cpr_number && (
                      <span className="block text-[11px] text-slate-400 font-mono">{g.cpr_number}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs font-mono">{g.age_group_code || '—'}</td>
                  <td className="px-4 py-3 text-slate-600 text-xs">{g.school_name || '—'}</td>
                  <td className="px-4 py-3">
                    <Badge tone="navy">{g.events.length}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <Badge tone={g.admin_verified_status === 'verified' ? 'success'
                        : g.admin_verified_status === 'issue' ? 'danger' : 'slate'}>
                        {g.admin_verified_status === 'verified' ? 'CPR ✓'
                          : g.admin_verified_status === 'issue' ? 'CPR issue' : 'CPR pending'}
                      </Badge>
                      <Badge tone={g.payment_status === 'verified' ? 'success'
                        : g.payment_status === 'pending' ? 'gold' : 'slate'}>
                        {g.payment_status === 'verified' ? 'Paid ✓'
                          : g.payment_status === 'pending' ? 'Pay pending' : 'No payment'}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5 max-w-md">
                      {g.events.map((ev) => (
                        <span
                          key={ev.id}
                          title={`${ev.event_name} — ${ev.status}`}
                          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono border ${
                            ev.status === 'withdrawn' || ev.status === 'swapped'
                              ? 'bg-slate-50 text-slate-400 border-slate-200 line-through'
                              : 'bg-navy-50 text-navy-700 border-navy-200'
                          }`}
                        >
                          {ev.event_code || ev.event_name}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" icon={Eye} onClick={() => onView(g.first)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="overflow-x-auto scroll-thin rounded-lg border border-slate-200">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="px-4 py-3 font-medium">
                    <button
                      onClick={() => toggleSort(col.key)}
                      className="flex items-center gap-1 hover:text-navy-700"
                    >
                      {col.label}
                      {sortKey === col.key
                        ? sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                        : <ArrowUpDown size={12} className="text-slate-300" />}
                    </button>
                  </th>
                ))}
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium text-slate-800">
                    {r.participant_name || '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs font-mono">
                    {r.age_group_code || '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {r.school_name || '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-navy-700">
                    {r.event_code || '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-800">
                    {r.event_name || '—'}
                  </td>
                  <td className="px-4 py-3 text-slate-600 text-xs">
                    {r.category_name || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={r.event_kind === 'team' ? 'gold' : 'navy'}>
                      {r.event_kind === 'team' ? 'Team' : 'Individual'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={STATUS_TONE[r.status] || 'slate'}>
                      {r.status ? r.status.charAt(0).toUpperCase() + r.status.slice(1) : '—'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="ghost" size="sm" icon={Eye} onClick={() => onView(r)}>
                      View
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
        <div className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={currentPage <= 1}
            onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span>Page {currentPage} of {totalPages}</span>
          <Button variant="outline" size="sm" disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      </div>
    </div>
  );
}
