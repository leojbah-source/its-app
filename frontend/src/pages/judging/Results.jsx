// src/pages/judging/Results.jsx
// Judging → Results. Per event + age group: compute (rank-aggregation), review
// ranks/grades/points with tie & divergence flags, then finalise (Stage 1) and
// Chairman publish (Stage 2). Chairman/SuperAdmin only.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, Calculator, CheckCircle2, Send, AlertTriangle } from 'lucide-react';
import AdminLayout from '../../components/layout/AdminLayout';
import { Card, Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { PageLoader, ErrorBanner } from '../../components/ui/States';
import { useAuth } from '../../context/AuthContext';
import { scheduleApi, resultsApi } from '../../api/client';

export default function Results() {
  const { token } = useAuth();
  const [events, setEvents] = useState([]);
  const [eventId, setEventId] = useState('');
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    scheduleApi.list(token).then((rows) => {
      const map = new Map();
      for (const r of rows) if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name });
      setEvents([...map.values()].sort((a, b) => a.code.localeCompare(b.code)));
    }).catch(() => {});
  }, [token]);

  const loadGroups = useCallback(() => {
    if (!eventId) { setGroups([]); return; }
    resultsApi.groups(token, eventId).then(setGroups).catch((e) => setFlash(e.message));
  }, [token, eventId]);
  useEffect(() => { setGroupId(''); setData(null); loadGroups(); }, [loadGroups]);

  const loadResults = useCallback(async () => {
    if (!eventId || !groupId) { setData(null); return; }
    setLoading(true); setFlash('');
    try { setData(await resultsApi.get(token, eventId, groupId)); }
    catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token, eventId, groupId]);
  useEffect(() => { loadResults(); }, [loadResults]);

  async function act(kind) {
    setBusy(true); setFlash('');
    try {
      if (kind === 'compute') { await resultsApi.compute(token, eventId, groupId); setFlash('Results computed & saved.'); }
      if (kind === 'finalise') { await resultsApi.finalise(token, eventId, groupId); setFlash('Results finalised — ready to print for signatures.'); }
      if (kind === 'publish') { await resultsApi.publish(token, eventId, groupId); setFlash('Results published.'); }
      loadResults(); loadGroups();
    } catch (e) { setFlash(e.message); }
    finally { setBusy(false); }
  }

  const state = data?.state || {};
  const flagged = useMemo(() => (data?.results || []).filter((r) => r.tie_flag || r.divergence_flag).length, [data]);
  const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  return (
    <AdminLayout title="Results" subtitle="Compute placements (rank aggregation), review, finalise, then publish. Chairman/SuperAdmin only.">
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[16rem] flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1">Event</label>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} className={`${sel} w-full`}>
              <option value="">Select an event…</option>
              {events.map((e) => <option key={e.event_id} value={e.event_id}>{e.code} · {e.name}</option>)}
            </select>
          </div>
          {eventId && (
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Age group</label>
              <div className="flex flex-wrap gap-1.5">
                {groups.length === 0 && <span className="text-xs text-slate-400">No chest-assigned groups.</span>}
                {groups.map((g) => (
                  <button key={g.age_group_id} onClick={() => setGroupId(g.age_group_id)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium ${String(groupId) === String(g.age_group_id) ? 'border-navy-600 bg-navy-600 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>
                    {g.code} · {g.participant_count}{g.published ? ' · published' : g.finalised ? ' · finalised' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {loading ? <PageLoader label="Computing results…" />
        : !data ? <Card><p className="py-8 text-center text-sm text-slate-400">Select an event and group to view results.</p></Card>
        : (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <Badge tone="navy">{data.participant_count} participants</Badge>
              <Badge tone={data.complete ? 'success' : 'danger'}>{data.complete ? 'scoring complete' : 'scoring incomplete'}</Badge>
              {flagged > 0 && <Badge tone="gold"><span className="inline-flex items-center gap-1"><AlertTriangle size={11} /> {flagged} flagged</span></Badge>}
              {state.published ? <Badge tone="success">published</Badge> : state.finalised ? <Badge tone="gold">finalised</Badge> : null}
              <div className="flex-1" />
              <Button variant="outline" icon={RefreshCw} onClick={loadResults}>Refresh</Button>
              {!state.published && <Button variant="outline" icon={Calculator} loading={busy} onClick={() => act('compute')}>Compute &amp; save</Button>}
              {!state.finalised && <Button variant="primary" icon={CheckCircle2} loading={busy} disabled={!data.complete} onClick={() => act('finalise')}>Finalise</Button>}
              {state.finalised && !state.published && <Button variant="gold" icon={Send} loading={busy} onClick={() => act('publish')}>Publish</Button>}
            </div>

            {!data.complete && <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">Not all judges have scored every participant yet — you can compute a preview, but finalising is disabled until scoring is complete.</div>}

            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Place</th>
                      <th className="px-3 py-2 text-left">Chest</th>
                      {data.judges.map((j) => <th key={j} className="px-2 py-2 text-center" title={j}>{j.split(' ')[0]}<div className="text-[10px] font-normal normal-case text-slate-400">rank</div></th>)}
                      <th className="px-2 py-2 text-center">Rank sum</th>
                      <th className="px-2 py-2 text-center">Avg %</th>
                      <th className="px-2 py-2 text-center">Grade</th>
                      <th className="px-2 py-2 text-center">Points</th>
                      <th className="px-2 py-2 text-center">Flags</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.results.map((r) => (
                      <tr key={r.registration_id} className={r.place ? 'bg-gold-50/30' : ''}>
                        <td className="px-3 py-2">{r.place ? <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gold-500 text-xs font-bold text-white">{r.place}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2"><span className="font-mono font-semibold text-navy-800">{r.chest_number}</span></td>
                        {r.per_judge.map((pj, i) => <td key={i} className="px-2 py-2 text-center text-slate-600" title={`total ${pj.total}`}>{pj.rank}</td>)}
                        <td className="px-2 py-2 text-center font-semibold text-navy-800">{r.rank_sum}</td>
                        <td className="px-2 py-2 text-center text-slate-600">{r.avg_pct}</td>
                        <td className="px-2 py-2 text-center">{r.grade ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-navy-700">{r.grade}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-2 py-2 text-center text-slate-600">{r.total_points}</td>
                        <td className="px-2 py-2 text-center">
                          <div className="flex justify-center gap-1">
                            {r.tie_flag && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">tie</span>}
                            {r.divergence_flag && <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] text-red-700">diverge</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <p className="mt-2 text-xs text-slate-500">
              Placement = lowest sum of the {data.judges.length} judges' ranks (ties broken by C1 totals, then C2…). Grade from average %. Divergence threshold ±{data.absolute_threshold} ranks.
            </p>
          </>
        )}
    </AdminLayout>
  );
}
