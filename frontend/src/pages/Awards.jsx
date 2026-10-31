// src/pages/Awards.jsx
// Awards standings (Chairman/SuperAdmin, rule #24). School awards (rule #16) and
// Group Championship per age group (rule #15), computed live from FINALISED
// results. Read-only view + CSV export.
import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Download, Trophy, School, GraduationCap, Award, ChevronRight } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { awardsApi } from '../api/client';

export default function Awards() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setFlash('');
    try { setData(await awardsApi.standings(token, 'active')); }
    catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  // group championship: champion = first (highest points) per age group
  const champions = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const r of data?.group_championship || []) {
      const champ = !seen.has(r.age_group_id);
      seen.add(r.age_group_id);
      out.push({ ...r, champ });
    }
    return out;
  }, [data]);

  async function exportCsv() {
    try {
      const csv = await awardsApi.exportCsv(token, 'active');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'awards.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setFlash(e.message); }
  }

  const num = (v) => Number(v || 0).toFixed(1);

  // Teacher drill-down (view only): expand a teacher to see their finalised entries.
  const [openT, setOpenT] = useState(null);
  const [tEntries, setTEntries] = useState({});
  const [tBusy, setTBusy] = useState(null);
  async function toggleTeacher(name) {
    if (openT === name) { setOpenT(null); return; }
    setOpenT(name);
    if (!tEntries[name]) {
      setTBusy(name);
      try {
        const r = await awardsApi.teacherEntries(token, 'active', name);
        setTEntries((m) => ({ ...m, [name]: r.entries || [] }));
      } catch (e) { setFlash(e.message); }
      finally { setTBusy(null); }
    }
  }
  const placeLabel = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n ? String(n) : '—');

  return (
    <AdminLayout title="Awards" subtitle="School awards and Group Championship, from finalised results. Chairman/SuperAdmin.">
      <div className="mb-4 flex items-center gap-2">
        <Badge tone="navy">Based on finalised results</Badge>
        <div className="flex-1" />
        <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
        <Button variant="outline" icon={Award} onClick={() => navigate('/admin/awards/certificates')}>Certificates</Button>
        <Button variant="outline" icon={Download} onClick={exportCsv}>Export CSV</Button>
      </div>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {loading ? <PageLoader label="Loading standings…" />
        : !data ? null
        : (
          <div className="space-y-5">
            <Card className="p-0 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-navy-800"><School size={15} /> School awards (total points)</div>
              {data.school_awards.length === 0 ? <p className="px-4 py-6 text-center text-sm text-slate-400">No finalised results yet.</p>
                : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-white text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">#</th>
                        <th className="px-3 py-2 text-left">School</th>
                        <th className="px-2 py-2 text-center">Rank pts</th>
                        <th className="px-2 py-2 text-center">Grade pts</th>
                        <th className="px-2 py-2 text-center">Participation</th>
                        <th className="px-2 py-2 text-center">Grand total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.school_awards.map((s, i) => (
                        <tr key={s.school_id} className={i === 0 ? 'bg-gold-50/40' : ''}>
                          <td className="px-3 py-2">{i === 0 ? '🏆' : i + 1}</td>
                          <td className="px-3 py-2 font-medium text-slate-800">{s.school_name}</td>
                          <td className="px-2 py-2 text-center text-slate-600">{num(s.total_rank_points)}</td>
                          <td className="px-2 py-2 text-center text-slate-600">{num(s.total_grade_points)}</td>
                          <td className="px-2 py-2 text-center text-slate-600">{num(s.total_participation_pts)}</td>
                          <td className="px-2 py-2 text-center font-semibold text-navy-800">{num(s.grand_total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </Card>

            <Card className="p-0 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-navy-800"><Trophy size={15} /> Group Championship (team events, per age group)</div>
              {champions.length === 0 ? <p className="px-4 py-6 text-center text-sm text-slate-400">No finalised team results yet.</p>
                : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-white text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">Age group</th>
                        <th className="px-3 py-2 text-left">School</th>
                        <th className="px-2 py-2 text-center">Points</th>
                        <th className="px-2 py-2 text-center">Champion</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {champions.map((r, i) => (
                        <tr key={`${r.age_group_id}-${r.school_id}-${i}`} className={r.champ ? 'bg-gold-50/40' : ''}>
                          <td className="px-3 py-2 text-slate-600">{r.age_group_label}</td>
                          <td className="px-3 py-2 font-medium text-slate-800">{r.school_name}</td>
                          <td className="px-2 py-2 text-center font-semibold text-navy-800">{num(r.total_points)}</td>
                          <td className="px-2 py-2 text-center">{r.champ ? '🏆' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
            </Card>

            <Card className="p-0 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-navy-800"><GraduationCap size={15} /> Teacher Awards (Best Teacher)</div>
              {(data.teacher_awards || []).length === 0 ? <p className="px-4 py-6 text-center text-sm text-slate-400">No teacher-linked finalised results yet.</p>
                : (
                  <table className="min-w-full text-sm">
                    <thead className="bg-white text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">#</th>
                        <th className="px-3 py-2 text-left">Teacher</th>
                        <th className="px-2 py-2 text-center">Entries</th>
                        <th className="px-2 py-2 text-center">Total points</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.teacher_awards.map((t, i) => (
                        <Fragment key={t.teacher_name}>
                          <tr onClick={() => toggleTeacher(t.teacher_name)}
                            className={`cursor-pointer hover:bg-slate-50 ${i === 0 ? 'bg-gold-50/40' : ''} ${openT === t.teacher_name ? 'bg-slate-50' : ''}`}
                            title="Click to view this teacher's entries">
                            <td className="px-3 py-2">{i === 0 ? '🏆' : i + 1}</td>
                            <td className="px-3 py-2 font-medium text-slate-800">
                              <span className="inline-flex items-center gap-1">
                                <ChevronRight size={13} className={`text-slate-400 transition-transform ${openT === t.teacher_name ? 'rotate-90' : ''}`} />
                                {t.teacher_name}
                              </span>
                            </td>
                            <td className="px-2 py-2 text-center text-navy-600 font-medium">{t.entries}</td>
                            <td className="px-2 py-2 text-center font-semibold text-navy-800">{num(t.total_points)}</td>
                          </tr>
                          {openT === t.teacher_name && (
                            <tr>
                              <td colSpan={4} className="bg-slate-50 px-4 py-3">
                                {tBusy === t.teacher_name ? (
                                  <p className="text-xs text-slate-400">Loading entries…</p>
                                ) : (tEntries[t.teacher_name] || []).length === 0 ? (
                                  <p className="text-xs text-slate-400">No finalised entries found for this teacher.</p>
                                ) : (
                                  <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                                    <table className="min-w-full text-xs">
                                      <thead className="text-[11px] uppercase tracking-wide text-slate-400">
                                        <tr>
                                          <th className="px-2 py-1.5 text-left">Participant / Team</th>
                                          <th className="px-2 py-1.5 text-left">Event</th>
                                          <th className="px-2 py-1.5 text-left">Group</th>
                                          <th className="px-2 py-1.5 text-left">Role</th>
                                          <th className="px-2 py-1.5 text-center">Prize</th>
                                          <th className="px-2 py-1.5 text-center">Grade</th>
                                          <th className="px-2 py-1.5 text-center">Points</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-slate-100">
                                        {tEntries[t.teacher_name].map((e, j) => (
                                          <tr key={j} className={e.prize_place ? 'bg-amber-50/40' : ''}>
                                            <td className="px-2 py-1.5 font-medium text-slate-700">
                                              {e.entry_name || '—'}{e.is_team ? ' (team)' : ''}
                                              {e.school ? <span className="block text-[10px] font-normal text-slate-400">{e.school}</span> : null}
                                            </td>
                                            <td className="px-2 py-1.5 text-slate-600"><span className="font-mono text-slate-400">{e.event_code}</span> {e.event_name}</td>
                                            <td className="px-2 py-1.5 text-slate-600">{e.age_group_label || e.age_group_code || '—'}</td>
                                            <td className="px-2 py-1.5 text-slate-500">{e.taught_as || '—'}</td>
                                            <td className="px-2 py-1.5 text-center font-medium text-slate-700">{placeLabel(e.prize_place)}</td>
                                            <td className="px-2 py-1.5 text-center text-slate-600">{e.grade || '—'}</td>
                                            <td className="px-2 py-1.5 text-center font-semibold text-navy-800">{num(e.total_points)}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
            </Card>

            <p className="text-xs text-slate-500">
              School awards = sum of rank + grade + participation points per school (rule #16). Group Championship = the top school per age group from team events (rule #15). Teacher Awards sum each teacher's students' points, excluding self-taught entries (rule #17). Figures use finalised results; publish them from the Results screen to show on the public board.
            </p>
          </div>
        )}
    </AdminLayout>
  );
}
