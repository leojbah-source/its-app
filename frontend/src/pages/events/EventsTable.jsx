import { useMemo, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Pencil, Ban, Search } from 'lucide-react';
import { Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/States';
import { criteriaSum } from './constants';

const COLUMNS = [
  { key: 'event_code',    label: 'Code' },
  { key: 'event_name',   label: 'Event' },
  { key: 'category_name', label: 'Category' },
  { key: 'event_kind',   label: 'Type' },
  { key: 'age_groups',   label: 'Age Groups', sortable: false },
  { key: 'criteria',     label: 'Criteria',   sortable: false },
  { key: 'time_slot_mode', label: 'Time-slot' },
  { key: 'status',       label: 'Status' },
];

const PAGE_SIZES = [10, 25, 50];

export default function EventsTable({ events, onEdit, onCancel }) {
  const [search, setSearch]     = useState('');
  const [sortKey, setSortKey]   = useState('event_code');
  const [sortDir, setSortDir]   = useState('asc');
  const [page, setPage]         = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = events;
    if (q) {
      rows = rows.filter(
        (e) =>
          (e.event_name   || '').toLowerCase().includes(q) ||
          (e.event_code   || '').toLowerCase().includes(q) ||
          (e.category_name || '').toLowerCase().includes(q),
      );
    }
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (av === bv) return 0;
      const result = av > bv ? 1 : -1;
      return sortDir === 'asc' ? result : -result;
    });
    return sorted;
  }, [events, search, sortKey, sortDir]);

  const totalPages  = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageRows    = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const toggleSort = (key) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-xs">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search by name, code or category"
            className="w-full rounded-md border border-slate-300 py-2 pl-9 pr-3 text-sm shadow-sm focus:border-navy-500 focus:outline-none focus:ring-2 focus:ring-navy-300"
          />
        </div>
        <p className="text-sm text-slate-500">
          {filtered.length} of {events.length} events
        </p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title="No events match your search"
          description="Try a different name, code, or category."
        />
      ) : (
        <div className="overflow-x-auto scroll-thin rounded-lg border border-slate-200">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                {COLUMNS.map((col) => (
                  <th key={col.key} className="px-4 py-3 font-medium">
                    {col.sortable === false ? (
                      col.label
                    ) : (
                      <button
                        onClick={() => toggleSort(col.key)}
                        className="flex items-center gap-1 hover:text-navy-700"
                      >
                        {col.label}
                        {sortKey === col.key ? (
                          sortDir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />
                        ) : (
                          <ArrowUpDown size={12} className="text-slate-300" />
                        )}
                      </button>
                    )}
                  </th>
                ))}
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.map((event) => {
                const sum   = criteriaSum(event.criteria);
                const sumOk = sum === 100;
                const cancelled = event.is_cancelled;
                return (
                  <tr key={event.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-navy-700">
                      {event.event_code || '—'}
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-800">
                      {event.event_name || '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {event.category_name || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={event.event_kind === 'team' ? 'gold' : 'navy'}>
                        {event.event_kind === 'team' ? 'Team' : 'Individual'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {event.age_groups?.length ? event.age_groups.join(', ') : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={sumOk ? 'success' : 'danger'}>{sum} / 100</Badge>
                    </td>
                    <td className="px-4 py-3">
                      {event.time_slot_mode
                        ? <Badge tone="gold">Enabled</Badge>
                        : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={cancelled ? 'danger' : 'success'}>
                        {cancelled ? 'Cancelled' : 'Active'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-1.5">
                        <Button variant="ghost" size="sm" icon={Pencil} onClick={() => onEdit(event)}>
                          Edit
                        </Button>
                        {!cancelled && (
                          <Button variant="ghost" size="sm" icon={Ban} onClick={() => onCancel(event)}>
                            Cancel
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
        <div className="flex items-center gap-2">
          <span>Rows per page</span>
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
            className="rounded-md border border-slate-300 px-2 py-1"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>Page {currentPage} of {totalPages}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
