// src/pages/JudgePerformance.jsx
// Chairman's judge performance review (confidential). Shows how each judge marked
// contestants this year — panel alignment, harsh/lenient tendency, and
// discrimination (score spread) — plus a suggested /10 and an editable rating + notes.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Save } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { judgesApi } from '../api/client';

const gapLabel = (g) => (g == null ? '—' : g <= 5 ? 'Very aligned' : g <= 10 ? 'Aligned' : g <= 18 ? 'Somewhat off' : 'Often diverges');
const tendLabel = (t) => (t == null ? '—' : Math.abs(t) <= 3 ? 'Balanced' : t > 0 ? `Lenient +${t}` : `Harsh ${t}`);
const spreadLabel = (s) => (s == null ? '—' : s >= 12 ? 'Differentiates well' : s >= 6 ? 'Moderate spread' : 'Bunches scores');

export default function JudgePerformance() {
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [flash, setFlash] = useState('');
  const [edit, setEdit] = useState({});
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await judgesApi.performance(token);
      setData(d);
      const e = {};
      for (const j of d.judges) e[j.judge_id] = { rating: j.rating ?? '', notes: j.notes || '' };
      setEdit(e);
    } catch (err) { setFlash(err.message); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const setField = (jid, k, v) => setEdit((m) => ({ ...m, [jid]: { ...m[jid], [k]: v } }));

  async function save(j) {
    const row = edit[j.judge_id] || {};
    setBusy(j.judge_id); setFlash('');
    try {
      await judgesApi.rate(token, j.judge_id, { rating: row.rating === '' ? null : row.rating, notes: row.notes });
      setFlash(`Saved rating for ${j.full_name}.`);
      load();
    } catch (err) { setFlash(err.message); }
    finally { setBusy(null); }
  }

  return (
    <AdminLayout title="Judge performance" subtitle="How each judge marked this year — confidential (Chairman/SuperAdmin).">
      <div className="mb-4 flex items-center gap-2">
        <Badge tone="navy">Computed from judges' own marks</Badge>
        <div className="flex-1" />
        <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
      </div>
      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-xs leading-relaxed text-slate-600">
        <b>Panel alignment</b> — average gap between this judge's marks and the other judges on the same contestant (smaller = more in line).{' '}
        <b>Tendency</b> — whether they marked higher (lenient) or lower (harsh) than the panel.{' '}
        <b>Spread</b> — how much they differentiated between contestants; bunching everyone together is weak discrimination.{' '}
        Figures are in percentage points (pp). The <b>suggested /10</b> is a guide from these numbers — set your own rating as you see fit.
      </div>

      {!data ? <Card className="p-6"><PageLoader label="Crunching the marks…" /></Card>
        : data.judges.length === 0 ? <Card className="p-8 text-center text-sm text-slate-400">No judges yet.</Card>
        : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[940px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Judge</th>
                    <th className="px-3 py-2 text-center">Contestants</th>
                    <th className="px-3 py-2 text-center">Panel alignment</th>
                    <th className="px-3 py-2 text-center">Tendency</th>
                    <th className="px-3 py-2 text-center">Spread</th>
                    <th className="px-3 py-2 text-center">Suggested</th>
                    <th className="px-3 py-2 text-center">Your /10</th>
                    <th className="px-3 py-2">Notes</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.judges.map((j) => {
                    const row = edit[j.judge_id] || {};
                    return (
                      <tr key={j.judge_id} className="align-top hover:bg-slate-50">
                        <td className="px-3 py-2 font-medium text-slate-800">
                          {j.full_name}
                          {j.is_blacklisted && <span className="ml-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-600">blacklisted</span>}
                        </td>
                        <td className="px-3 py-2 text-center text-slate-600">
                          {j.contestants}
                          {j.compared < 3 && <span className="block text-[10px] text-amber-600">too few to rate</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className="block font-medium text-slate-700">{j.align_gap != null ? `±${j.align_gap} pp` : '—'}</span>
                          <span className="text-[10px] text-slate-400">{gapLabel(j.align_gap)}</span>
                        </td>
                        <td className="px-3 py-2 text-center"><span className="text-[11px] text-slate-500">{tendLabel(j.tendency)}</span></td>
                        <td className="px-3 py-2 text-center">
                          <span className="block font-medium text-slate-700">{j.spread != null ? `${j.spread} pp` : '—'}</span>
                          <span className="text-[10px] text-slate-400">{spreadLabel(j.spread)}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          {j.suggested != null ? <span className="rounded bg-navy-50 px-2 py-0.5 font-semibold text-navy-700">{j.suggested}</span> : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input type="number" min="0" max="10" step="0.5" value={row.rating ?? ''}
                            onChange={(e) => setField(j.judge_id, 'rating', e.target.value)}
                            placeholder={j.suggested != null ? String(j.suggested) : ''}
                            className="w-16 rounded border border-slate-300 px-2 py-1 text-center text-sm" />
                        </td>
                        <td className="px-3 py-2">
                          <input value={row.notes ?? ''} onChange={(e) => setField(j.judge_id, 'notes', e.target.value)}
                            placeholder="optional notes"
                            className="w-full min-w-[160px] rounded border border-slate-300 px-2 py-1 text-sm" />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Button size="sm" variant="primary" icon={Save} loading={busy === j.judge_id} onClick={() => save(j)}>Save</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
    </AdminLayout>
  );
}
