// src/pages/judging/MediaResults.jsx
// Media / photographer view: pick a date, event and age group, then open the
// official result sheet or the winners poster. No judge-by-judge scoring is
// shown here. Read-only; published groups only.
import { useEffect, useMemo, useState, useCallback } from 'react';
import { FileText, Trophy, RefreshCw, Download, Package } from 'lucide-react';
import AdminLayout from '../../components/layout/AdminLayout';
import { Card, Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { useAuth } from '../../context/AuthContext';
import { scheduleApi, resultsApi, API_BASE } from '../../api/client';

const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

export default function MediaResults() {
  const { token } = useAuth();
  const [schedule, setSchedule] = useState([]);
  const [date, setDate] = useState('');
  const [eventId, setEventId] = useState('');
  const [groups, setGroups] = useState([]);
  const [packFrom, setPackFrom] = useState('');
  const [packTo, setPackTo] = useState('');
  const [packBusy, setPackBusy] = useState(false);
  const [flash, setFlash] = useState('');

  const loadSchedule = useCallback(() => {
    scheduleApi.list(token).then(setSchedule).catch((e) => setFlash(e.message));
  }, [token]);
  useEffect(() => { loadSchedule(); }, [loadSchedule]);

  const dates = useMemo(() => [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(), [schedule]);
  useEffect(() => { if (!date && dates.length) setDate(dates[0]); }, [dates, date]);
  useEffect(() => { if (date) { setPackFrom(date); setPackTo(date); } }, [date]);

  const events = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (date && String(r.event_date).slice(0, 10) !== date) continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);

  useEffect(() => { setGroups([]); if (!eventId) return; resultsApi.groups(token, eventId).then(setGroups).catch((e) => setFlash(e.message)); }, [token, eventId]);
  useEffect(() => { setEventId(''); setGroups([]); }, [date]);

  async function downloadPack() {
    setPackBusy(true); setFlash('');
    try {
      const qs = new URLSearchParams();
      if (packFrom) qs.set('from', packFrom);
      if (packTo) qs.set('to', packTo);
      const res = await fetch(`${API_BASE}/api/admin/results/winners-pack?${qs.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const t = await res.json().catch(() => ({}));
        setFlash(t.error || 'Could not build the pack.');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `winners-pack${packFrom ? '_' + packFrom : ''}${packTo && packTo !== packFrom ? '_to_' + packTo : ''}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setFlash(e.message || 'Download failed.'); }
    finally { setPackBusy(false); }
  }

  const evName = events.find((e) => String(e.event_id) === String(eventId));

  return (
    <AdminLayout>
      <div className="mb-5">
        <h1 className="text-xl font-bold text-navy-800">Results — media</h1>
        <p className="mt-1 text-sm text-slate-500">Pick a date, event and group, then open the result sheet or the winners poster to download/share.</p>
      </div>

      {flash && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{flash}</div>}

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <h2 className="text-sm font-semibold text-navy-800">Press / media winners pack</h2>
            <p className="mt-0.5 text-xs text-slate-500">A ZIP of all published winners for the dates below — each photo individually named, plus a details sheet. Add your posters to the folder before sharing.</p>
          </div>
          <div className="flex-1" />
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">From</label>
            <input type="date" className={`${sel} mt-1`} value={packFrom} onChange={(e) => setPackFrom(e.target.value)} />
          </div>
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">To</label>
            <input type="date" className={`${sel} mt-1`} value={packTo} onChange={(e) => setPackTo(e.target.value)} />
          </div>
          <Button variant="primary" icon={Package} loading={packBusy} onClick={downloadPack}>Download pack (ZIP)</Button>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Date</label>
            <select className={`${sel} mt-1`} value={date} onChange={(e) => setDate(e.target.value)}>
              {dates.length === 0 && <option value="">No scheduled dates</option>}
              {dates.map((d) => <option key={d} value={d}>{new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })}</option>)}
            </select>
          </div>
          <div className="min-w-[280px] flex-1">
            <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Event</label>
            <select className={`${sel} mt-1 w-full`} value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Select an event…</option>
              {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.code} · {e.name}</option>)}
            </select>
          </div>
          <Button variant="outline" size="sm" icon={RefreshCw} onClick={loadSchedule}>Refresh</Button>
        </div>
      </Card>

      {eventId && (
        <div className="mt-4">
          <Card title={evName ? `${evName.code} · ${evName.name}` : 'Groups'}>
            {groups.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-400">No groups found for this event.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {groups.map((g) => (
                  <li key={g.age_group_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <span className="text-sm font-semibold text-navy-800">{g.label || g.code}</span>
                      <span className="ml-2 text-xs text-slate-400">{g.participant_count} participant{g.participant_count === 1 ? '' : 's'}</span>
                      {g.published ? <Badge tone="success" className="ml-2">published</Badge>
                        : g.finalised ? <Badge tone="warning" className="ml-2">finalised</Badge>
                        : <Badge tone="neutral" className="ml-2">not ready</Badge>}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" icon={FileText} disabled={!g.published && !g.finalised}
                        onClick={() => window.open(`/admin/judging/results/print/${eventId}/${g.age_group_id}`, '_blank')}>Result sheet</Button>
                      <Button variant="gold" size="sm" icon={Trophy} disabled={!g.published && !g.finalised}
                        onClick={() => window.open(`/admin/judging/winners/${eventId}/${g.age_group_id}`, '_blank')}>Winners poster</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </AdminLayout>
  );
}
