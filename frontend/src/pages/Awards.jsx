// src/pages/Awards.jsx
// Awards standings (Chairman/SuperAdmin, rule #24). School awards (rule #16) and
// Group Championship per age group (rule #15), computed live from FINALISED
// results. Read-only view + CSV export.
import { useEffect, useState, useCallback, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Download, Trophy, School, GraduationCap, Award, ChevronRight, X } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { awardsApi } from '../api/client';

function toSections(rows, keyField, labelField) {
  const map = new Map();
  for (const r of rows || []) {
    if (!map.has(r[keyField])) map.set(r[keyField], { key: r[keyField], label: r[labelField], rows: [] });
    map.get(r[keyField]).rows.push(r);
  }
  return [...map.values()];
}

export default function Awards() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [trophy, setTrophy] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setFlash('');
    try {
      const [st, tc] = await Promise.all([
        awardsApi.standings(token, 'active'),
        awardsApi.trophyCount(token, 'active').catch(() => null),
      ]);
      setData(st); setTrophy(tc);
    }
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

  const [dlTrophy, setDlTrophy] = useState(false);
  async function downloadTrophyXlsx() {
    setDlTrophy(true); setFlash('');
    try {
      const blob = await awardsApi.trophyCountXlsx(token, 'active');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'trophy-order.xlsx';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { setFlash(e.message || 'Could not generate the trophy order.'); }
    finally { setDlTrophy(false); }
  }

  const num = (v) => Number(v || 0).toFixed(1);

  const [cleanupOpen, setCleanupOpen] = useState(false);
  const placeLabel = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n ? String(n) : '—');
  const ageSections = useMemo(() => toSections(data?.age_group_toppers, 'age_group_id', 'age_group_label'), [data]);
  const catSections = useMemo(() => toSections(data?.category_toppers, 'category_id', 'category_name'), [data]);

  return (
    <AdminLayout title="Awards" subtitle="School awards and Group Championship, from finalised results. Chairman/SuperAdmin.">
      <div className="mb-4 flex items-center gap-2">
        <Badge tone="navy">Based on finalised results</Badge>
        <div className="flex-1" />
        <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
        <Button variant="outline" icon={Award} onClick={() => navigate('/admin/awards/certificates')}>Certificates</Button>
        <Button variant="outline" icon={Download} onClick={exportCsv}>Export CSV</Button>
        <Button variant="outline" icon={Trophy} onClick={downloadTrophyXlsx} loading={dlTrophy}>Trophy order (Excel)</Button>
      </div>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {loading ? <PageLoader label="Loading standings…" />
        : !data ? null
        : (
          <div className="space-y-5">
            <TrophyCount trophy={trophy} />
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
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-navy-800"><GraduationCap size={15} /> Teacher Awards</span>
                <Button variant="outline" size="sm" onClick={() => setCleanupOpen(true)}>Clean up teacher names</Button>
              </div>
              <div className="grid gap-4 p-4 lg:grid-cols-2">
                <TeacherAwards token={token} category="dance" title="Best Dance Teacher" rows={data.dance_teacher_awards || []} />
                <TeacherAwards token={token} category="music" title="Best Music Teacher" rows={data.music_teacher_awards || []} />
              </div>
            </Card>

            {(data.age_group_toppers || []).length > 0 && (
              <Card className="p-0 overflow-hidden">
                <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-navy-800">
                  <Trophy size={15} /> Top 5 participants by age group
                </div>
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  {ageSections.map((sec) => (
                    <div key={sec.key} className="rounded-lg border border-slate-200">
                      <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs font-semibold text-navy-700">{sec.label}</div>
                      <table className="min-w-full text-xs">
                        <tbody className="divide-y divide-slate-100">
                          {sec.rows.map((r) => (
                            <tr key={r.participant_id} className={r.rnk === 1 ? 'bg-gold-50/40' : ''}>
                              <td className="px-2 py-1.5 w-7 text-slate-400">{r.rnk === 1 ? '🏆' : r.rnk}</td>
                              <td className="px-2 py-1.5 font-medium text-slate-700">{r.full_name}{r.school ? <span className="block text-[10px] font-normal text-slate-400">{r.school}</span> : null}</td>
                              <td className="px-2 py-1.5 text-center text-slate-400 whitespace-nowrap">{r.entries} ent.</td>
                              <td className="px-2 py-1.5 text-right font-semibold text-navy-800 whitespace-nowrap">{num(r.total_points)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {(data.category_toppers || []).length > 0 && (
              <Card className="p-0 overflow-hidden">
                <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold text-navy-800">
                  <Award size={15} /> Overall top 5 by event category (all age groups combined)
                </div>
                <div className="grid gap-4 p-4 sm:grid-cols-2">
                  {catSections.map((sec) => (
                    <div key={sec.key} className="rounded-lg border border-slate-200">
                      <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs font-semibold text-navy-700">{sec.label}</div>
                      <table className="min-w-full text-xs">
                        <tbody className="divide-y divide-slate-100">
                          {sec.rows.map((r) => (
                            <tr key={r.participant_id} className={r.rnk === 1 ? 'bg-gold-50/40' : ''}>
                              <td className="px-2 py-1.5 w-7 text-slate-400">{r.rnk === 1 ? '🏆' : r.rnk}</td>
                              <td className="px-2 py-1.5 font-medium text-slate-700">{r.full_name}{r.school ? <span className="block text-[10px] font-normal text-slate-400">{r.school}</span> : null}</td>
                              <td className="px-2 py-1.5 text-center text-slate-400 whitespace-nowrap">{r.entries} ent.</td>
                              <td className="px-2 py-1.5 text-right font-semibold text-navy-800 whitespace-nowrap">{num(r.total_points)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            <p className="text-xs text-slate-500">
              School awards = sum of rank + grade + participation points per school (rule #16). Group Championship = the top school per age group from team events (rule #15). Teacher Awards sum each teacher's students' points, excluding self-taught entries (rule #17). Figures use finalised results; publish them from the Results screen to show on the public board.
            </p>
          </div>
        )}
      {cleanupOpen && <TeacherCleanup token={token} onClose={() => { setCleanupOpen(false); load(); }} />}
    </AdminLayout>
  );
}

function Tile({ label, value, tone = 'navy' }) {
  const tones = {
    navy: 'bg-navy-50 text-navy-800 border-navy-100',
    gold: 'bg-gold-50 text-gold-800 border-gold-200',
    slate: 'bg-slate-50 text-slate-700 border-slate-200',
  };
  return (
    <div className={`rounded-xl border px-4 py-3 ${tones[tone] || tones.navy}`}>
      <div className="text-2xl font-bold leading-none">{value}</div>
      <div className="mt-1 text-[11px] font-medium uppercase tracking-wide opacity-70">{label}</div>
    </div>
  );
}

function TrophyCount({ trophy }) {
  if (!trophy) return null;
  const ind = trophy.individual || {};
  const pj = ind.projected || { first: 0, second: 0, third: 0, total: 0 };
  const dec = ind.decided_published || {};
  const team = trophy.team || {};
  const pending = (ind.cells_total || 0) - (ind.cells_published || 0);
  return (
    <Card title="Trophy count" description="Individual places are the projected maximum from current entries; team trophies go to every member of the winning teams — top 3 teams per contest, or fewer if fewer than 3 teams.">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile label="Individual 1st" value={pj.first} />
        <Tile label="Individual 2nd" value={pj.second} />
        <Tile label="Individual 3rd" value={pj.third} />
        <Tile label="Individual total" value={pj.total} tone="slate" />
        <Tile label="Team (winners’ members)" value={team.trophies ?? 0} tone="gold" />
        <Tile label="Grand total" value={trophy.grand_total ?? 0} tone="gold" />
      </div>

      <div className="mt-3 space-y-1 text-xs text-slate-500">
        <p>A cell with 2 entrants counts a 1st + 2nd only; 1 entrant counts a 1st only. Across <b>{ind.cells_total ?? 0}</b> individual event/age-group cells{pending > 0 ? <> — <b>{pending}</b> not yet published, so these figures may still change.</> : <> — all published.</>}</p>
        <p>Decided so far (published): 1st <b>{dec.first ?? 0}</b> · 2nd <b>{dec.second ?? 0}</b> · 3rd <b>{dec.third ?? 0}</b>
          {(dec.additional_3rd || dec.consolation) ? <> · extra prizes: additional 3rd <b>{dec.additional_3rd || 0}</b>, consolation <b>{dec.consolation || 0}</b></> : null}</p>
        <p>Teams: <b>{team.trophies ?? 0}</b> trophies for the winning teams (<b>{team.winning_teams ?? 0}</b> winning of <b>{team.total_teams ?? 0}</b> teams). Top 3 teams per contest win (fewer if fewer than 3 teams); every member of a winning team gets a trophy. Decided so far: <b>{team.decided?.trophies ?? 0}</b>.</p>
        <p>Team trophies by place (members of the winning teams): 1st <b>{team.projected?.first ?? 0}</b> · 2nd <b>{team.projected?.second ?? 0}</b> · 3rd <b>{team.projected?.third ?? 0}</b>.</p>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-navy-700">Show detail</summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Individual events</p>
            <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-2 py-1.5">Event</th><th className="px-2 py-1.5">Group</th><th className="px-2 py-1.5 text-right">Entrants</th><th className="px-2 py-1.5 text-right">Trophies</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(ind.cells || []).map((r, i) => (
                    <tr key={i} className={r.published ? '' : 'bg-amber-50/40'}>
                      <td className="px-2 py-1.5"><span className="font-mono text-[10px] text-navy-600">{r.event_code}</span> {r.event_name}</td>
                      <td className="px-2 py-1.5 text-slate-500">{r.age_group_code}</td>
                      <td className="px-2 py-1.5 text-right">{r.entrants}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{r.trophies}</td>
                    </tr>
                  ))}
                  {(ind.cells || []).length === 0 && <tr><td colSpan={4} className="px-2 py-4 text-center text-slate-400">No individual entries.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Team events (one trophy per member)</p>
            <div className="max-h-80 overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-2 py-1.5">Event</th><th className="px-2 py-1.5">Group</th><th className="px-2 py-1.5 text-right">Teams</th><th className="px-2 py-1.5 text-right">Winning</th><th className="px-2 py-1.5 text-right">1st</th><th className="px-2 py-1.5 text-right">2nd</th><th className="px-2 py-1.5 text-right">3rd</th><th className="px-2 py-1.5 text-right">Trophies</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {(team.cells || []).map((r, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1.5"><span className="font-mono text-[10px] text-navy-600">{r.event_code}</span> {r.event_name}</td>
                      <td className="px-2 py-1.5 text-slate-500">{r.age_group_code || '—'}</td>
                      <td className="px-2 py-1.5 text-right">{r.teams}</td>
                      <td className="px-2 py-1.5 text-right">{r.winning_teams}</td>
                      <td className="px-2 py-1.5 text-right">{r.first}</td>
                      <td className="px-2 py-1.5 text-right">{r.second}</td>
                      <td className="px-2 py-1.5 text-right">{r.third}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{r.trophies}</td>
                    </tr>
                  ))}
                  {(team.cells || []).length === 0 && <tr><td colSpan={8} className="px-2 py-4 text-center text-slate-400">No team entries.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </details>
    </Card>
  );
}


function TeacherAwards({ token, category, title, rows }) {
  const [openKey, setOpenKey] = useState(null);
  const [entries, setEntries] = useState({});
  const [busy, setBusy] = useState(null);
  const num = (v) => Number(v || 0).toFixed(1);
  const placeLabel = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n ? String(n) : 'â');
  async function toggle(name) {
    if (openKey === name) { setOpenKey(null); return; }
    setOpenKey(name);
    if (!entries[name]) {
      setBusy(name);
      try { const r = await awardsApi.teacherEntries(token, 'active', name, category); setEntries((m) => ({ ...m, [name]: r.entries || [] })); }
      catch { /* ignore */ }
      finally { setBusy(null); }
    }
  }
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="border-b border-slate-100 bg-slate-50/60 px-3 py-1.5 text-xs font-semibold text-navy-700">{title}</div>
      {rows.length === 0 ? <p className="px-3 py-5 text-center text-xs text-slate-400">No finalised entries yet.</p> : (
        <table className="min-w-full text-sm">
          <thead className="text-[11px] uppercase tracking-wide text-slate-400">
            <tr><th className="px-3 py-2 text-left">#</th><th className="px-3 py-2 text-left">Teacher</th><th className="px-2 py-2 text-center">Entries</th><th className="px-2 py-2 text-center">Points</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((t, i) => (
              <Fragment key={t.tkey || t.teacher_name}>
                <tr onClick={() => toggle(t.teacher_name)} className={`cursor-pointer hover:bg-slate-50 ${i === 0 ? 'bg-gold-50/40' : ''}`} title="Click to view entries">
                  <td className="px-3 py-2">{i === 0 ? '🏆' : i + 1}</td>
                  <td className="px-3 py-2 font-medium text-slate-800"><span className="inline-flex items-center gap-1"><ChevronRight size={13} className={`text-slate-400 transition-transform ${openKey === t.teacher_name ? 'rotate-90' : ''}`} />{t.teacher_name}</span></td>
                  <td className="px-2 py-2 text-center font-medium text-navy-600">{t.entries}</td>
                  <td className="px-2 py-2 text-center font-semibold text-navy-800">{num(t.total_points)}</td>
                </tr>
                {openKey === t.teacher_name && (
                  <tr><td colSpan={4} className="bg-slate-50 px-3 py-2">
                    {busy === t.teacher_name ? <p className="text-xs text-slate-400">Loadingâ¦</p>
                      : (entries[t.teacher_name] || []).length === 0 ? <p className="text-xs text-slate-400">No finalised entries.</p>
                      : (
                        <div className="overflow-x-auto rounded border border-slate-200 bg-white">
                          <table className="min-w-full text-xs">
                            <thead className="text-[10px] uppercase tracking-wide text-slate-400"><tr>
                              <th className="px-2 py-1 text-left">Participant</th><th className="px-2 py-1 text-left">Event</th><th className="px-2 py-1 text-left">Group</th><th className="px-2 py-1 text-center">Prize</th><th className="px-2 py-1 text-center">Grade</th><th className="px-2 py-1 text-center">Points</th>
                            </tr></thead>
                            <tbody className="divide-y divide-slate-100">
                              {entries[t.teacher_name].map((e, j) => (
                                <tr key={j} className={e.prize_place ? 'bg-amber-50/40' : ''}>
                                  <td className="px-2 py-1 font-medium text-slate-700">{e.entry_name || 'â'}{e.is_team ? ' (team)' : ''}{e.school ? <span className="block text-[10px] font-normal text-slate-400">{e.school}</span> : null}</td>
                                  <td className="px-2 py-1 text-slate-600"><span className="font-mono text-slate-400">{e.event_code}</span> {e.event_name}</td>
                                  <td className="px-2 py-1 text-slate-600">{e.age_group_label || e.age_group_code || 'â'}</td>
                                  <td className="px-2 py-1 text-center">{placeLabel(e.prize_place)}</td>
                                  <td className="px-2 py-1 text-center text-slate-600">{e.grade || 'â'}</td>
                                  <td className="px-2 py-1 text-center font-semibold text-navy-800">{num(e.total_points)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function TeacherCleanup({ token, onClose }) {
  const [category, setCategory] = useState('dance');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editKey, setEditKey] = useState(null);
  const [editVal, setEditVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const num = (v) => Number(v || 0).toFixed(1);
  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await awardsApi.teachers(token, 'active', category); setList(r.teachers || []); }
    catch (e) { setMsg(e.message); }
    finally { setLoading(false); }
  }, [token, category]);
  useEffect(() => { load(); }, [load]);
  async function save(from) {
    const to = editVal.trim();
    if (!to) { setEditKey(null); return; }
    setBusy(true); setMsg('');
    try {
      const r = await awardsApi.renameTeacher(token, 'active', { category, from, to });
      setMsg(`Updated ${r.updated} entr${r.updated === 1 ? 'y' : 'ies'}: â${from}â â â${to}â.`);
      setEditKey(null); setEditVal(''); load();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-base font-semibold text-navy-900">Clean up teacher names</h3>
          <button onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100"><X size={18} /></button>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
          <div className="flex overflow-hidden rounded-md border border-slate-300 text-sm">
            <button onClick={() => setCategory('dance')} className={`px-3 py-1.5 ${category === 'dance' ? 'bg-navy-700 text-white' : 'bg-white text-slate-600'}`}>Dance teachers</button>
            <button onClick={() => setCategory('music')} className={`px-3 py-1.5 ${category === 'music' ? 'bg-navy-700 text-white' : 'bg-white text-slate-600'}`}>Music teachers</button>
          </div>
          <p className="text-xs text-slate-500">To merge two, rename one to the other's exact spelling.</p>
        </div>
        {msg && <p className="mx-5 mt-2 rounded bg-slate-50 px-3 py-1.5 text-xs text-slate-600">{msg}</p>}
        <div className="flex-1 overflow-y-auto p-5">
          {loading ? <p className="text-sm text-slate-400">Loadingâ¦</p>
            : list.length === 0 ? <p className="text-sm text-slate-400">No teachers in this category.</p>
            : (
              <table className="min-w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wide text-slate-400"><tr>
                  <th className="px-2 py-1.5 text-left">Teacher</th><th className="px-2 py-1.5 text-center">Entries</th><th className="px-2 py-1.5 text-center">Points</th><th className="px-2 py-1.5"></th>
                </tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {list.map((t) => (
                    <tr key={t.tkey}>
                      <td className="px-2 py-1.5">
                        {editKey === t.tkey ? (
                          <input autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') save(t.teacher_name); if (e.key === 'Escape') setEditKey(null); }}
                            className="w-full rounded border border-navy-300 px-2 py-1 text-sm" />
                        ) : <span className="font-medium text-slate-800">{t.teacher_name}{t.spellings > 1 ? <span className="ml-1 text-[10px] text-amber-600">({t.spellings} spellings)</span> : null}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-center text-slate-500">{t.entries}</td>
                      <td className="px-2 py-1.5 text-center text-slate-500">{num(t.total_points)}</td>
                      <td className="px-2 py-1.5 text-right whitespace-nowrap">
                        {editKey === t.tkey ? (
                          <>
                            <button disabled={busy} onClick={() => save(t.teacher_name)} className="rounded bg-navy-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-50">Save</button>
                            <button onClick={() => setEditKey(null)} className="ml-1 rounded border border-slate-300 px-2 py-1 text-xs">Cancel</button>
                          </>
                        ) : <button onClick={() => { setEditKey(t.tkey); setEditVal(t.teacher_name); }} className="text-xs text-navy-600 hover:underline">Rename / merge</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
        <div className="border-t border-slate-100 px-5 py-3 text-right"><button onClick={onClose} className="rounded-md border border-slate-300 px-4 py-1.5 text-sm">Done</button></div>
      </div>
    </div>
  );
}

