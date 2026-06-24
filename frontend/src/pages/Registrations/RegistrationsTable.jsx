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
  const [search,   setSearch]   = useState('');
  const [status,   setStatus]   = useState('');
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

    const sorted = [...rows].sort((a, b) => {
      const av = (a[sortKey] ?? '').toString().toLowerCase();
      const bv = (b[sortKey] ?? '').toString().toLowerCase();
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (sortDir === 'asc' ? 1 : -1);
    });
    return sorted;
  }, [registrations, search, status, sortKey, sortDir]);

  const totalPages  = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows    = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

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
          <option value="">All statuses</option>
          <option value="registered">Registered</option>
          <option value="attended">Attended</option>
          <option value="absent">Absent</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="swapped">Swapped</option>
        </select>
        <p className="ml-auto text-sm text-slate-500">
          {filtered.length} of {registrations.length} registrations
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No registrations match your filters"
          description="Try adjusting the search or status filter."
        />
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
