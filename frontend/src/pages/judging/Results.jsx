// src/pages/judging/Results.jsx
// Judging → Results. Per event + age group: compute (rank-aggregation), review
// ranks/grades/points with tie & divergence flags, then finalise (Stage 1) and
// Chairman publish (Stage 2). Chairman/SuperAdmin only. When a placement tie
// cannot be broken by criteria order, a Chairman opens a tiebreaker (rule #8)
// and the judges' 1–10 marks are keyed in to separate the tied chests.
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Calculator, CheckCircle2, Send, AlertTriangle, Scale, X, Printer, Trophy } from 'lucide-react';
import AdminLayout from '../../components/layout/AdminLayout';
import { Card, Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { PageLoader } from '../../components/ui/States';
import { pickDefaultDate } from '../../utils/dates';
import { useAuth } from '../../context/AuthContext';
import { scheduleApi, resultsApi } from '../../api/client';

export default function Results() {
  const { token, user } = useAuth();
  const navigate = useNavigate();
  const isChairman = user?.role === 'Chairman' || user?.role === 'SuperAdmin';
  const [schedule, setSchedule] = useState([]);
  const [date, setDate] = useState('');
  const [eventId, setEventId] = useState('');
  const [groups, setGroups] = useState([]);
  const [groupId, setGroupId] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [busy, setBusy] = useState(false);
  const [tbOpen, setTbOpen] = useState(false);

  useEffect(() => { scheduleApi.list(token).then(setSchedule).catch(() => {}); }, [token]);
  const dates = useMemo(() => [...new Set(schedule.map((r) => String(r.event_date).slice(0, 10)))].sort(), [schedule]);
  useEffect(() => { if (!date && dates.length) setDate(pickDefaultDate(dates)); }, [dates, date]);
  // Events scheduled on the selected date (deduped), like the Event assignment page.
  const events = useMemo(() => {
    const map = new Map();
    for (const r of schedule) {
      if (date && String(r.event_date).slice(0, 10) !== date) continue;
      if (!map.has(r.event_id)) map.set(r.event_id, { event_id: r.event_id, code: r.event_code, name: r.event_name });
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [schedule, date]);
  useEffect(() => { setEventId(''); setGroups([]); setGroupId(''); setData(null); }, [date]);

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

  // Silent refresh (no spinner, keeps the flash message) used by the auto-poll.
  const pollResults = useCallback(async () => {
    if (!eventId || !groupId) return;
    try { setData(await resultsApi.get(token, eventId, groupId)); } catch { /* ignore transient poll errors */ }
  }, [token, eventId, groupId]);

  async function act(kind) {
    if (kind === 'publish') {
      const st = data?.state || {};
      if (!st.all_agreed) {
        if (!window.confirm(`Only ${st.judges_agreed ?? 0} of ${st.judges_total ?? 0} judges have agreed this result.\n\nPublish anyway (override)?`)) return;
      }
      if (!window.confirm('Publishing makes this result FINAL and sends it out to participants (and the public results board).\n\nPublish now?')) return;
    }
    if (kind === 'finalise') {
      const over = (data?.results || []).filter((r) => r.over_time && !r.is_disqualified);
      if (over.length) {
        const chests = over.map((r) => `#${r.chest_number}`).join(', ');
        if (!window.confirm(`${chests} went over time + grace and ${over.length === 1 ? 'has' : 'have'} NOT been disqualified or cleared.\n\nReview the DQ column first — click Disqualify if the rules require it. Finalise anyway?`)) return;
      }
    }
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
  const flagged = useMemo(() => (data?.results || []).filter((r) => r.exact_tie || r.divergence_flag).length, [data]);
  const unreviewedDiv = useMemo(() => (data?.results || []).filter((r) => r.divergence_flag && !r.divergence_notes).length, [data]);
  const tieRows = useMemo(() => (data?.results || []).filter((r) => r.needs_tiebreak), [data]);
  const overUnhandled = useMemo(() => (data?.results || []).filter((r) => r.over_time && !r.is_disqualified), [data]);
  const showTiebreak = Boolean(data?.complete && data?.tiebreak_needed);

  // Auto-refresh the live state (judges done, flags, finalise/publish/stale) every
  // 5s so the page and its buttons update without a manual reload. Paused during an
  // action, while the tiebreak modal is open, and once the result is published.
  useEffect(() => {
    if (!eventId || !groupId || state.published) return undefined;
    const iv = setInterval(() => { if (!busy && !tbOpen) { pollResults(); loadGroups(); } }, 5000);
    return () => clearInterval(iv);
  }, [eventId, groupId, state.published, busy, tbOpen, pollResults, loadGroups]);

  const EXTRA_LABEL = { additional_3rd: "Add'l 3rd", consolation: 'Consolation' };
  async function setExtra(row, type) {
    try {
      await resultsApi.setExtraPrize(token, eventId, groupId, row.registration_id, type || null);
      setFlash(type ? 'Extra/consolation prize awarded.' : 'Extra prize removed.');
      loadResults();
    } catch (e) { setFlash(e.message); }
  }
  async function reviewDiv(row) {
    const note = window.prompt(`Chest ${row.chest_number} — judges' ranks diverge (±${data.absolute_threshold} ranks). Enter a Chairman review note:`, row.divergence_notes || '');
    if (note == null) return;
    try { await resultsApi.reviewDivergence(token, eventId, groupId, row.registration_id, note); setFlash('Divergence reviewed.'); loadResults(); }
    catch (e) { setFlash(e.message); }
  }
  async function disqualify(row) {
    const reason = window.prompt(`Disqualify chest ${row.chest_number}? They are removed from the ranking and get NO grade or rank points (rule #22). Judges are not notified. Enter the reason:`, row.over_time ? 'Exceeded time limit and grace period' : '');
    if (reason == null) return;
    if (!reason.trim()) { setFlash('A disqualification reason is required.'); return; }
    setBusy(true); setFlash('');
    try { await resultsApi.disqualify(token, eventId, row.registration_id, reason.trim()); setFlash(`Chest ${row.chest_number} disqualified.`); loadResults(); loadGroups(); }
    catch (e) { setFlash(e.message); } finally { setBusy(false); }
  }
  async function reinstate(row) {
    const reason = window.prompt(`Reinstate chest ${row.chest_number} back into the ranking (e.g. appeal upheld)? Enter the reason:`, '');
    if (reason == null) return;
    setBusy(true); setFlash('');
    try { await resultsApi.reinstate(token, eventId, row.registration_id, (reason || '').trim()); setFlash(`Chest ${row.chest_number} reinstated.`); loadResults(); loadGroups(); }
    catch (e) { setFlash(e.message); } finally { setBusy(false); }
  }
  const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  return (
    <AdminLayout title="Results" subtitle="Compute placements (rank aggregation), review, finalise, then publish. Chairman/SuperAdmin only.">
      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Date</label>
            <select value={date} onChange={(e) => setDate(e.target.value)} className={sel}>
              <option value="">All dates</option>
              {dates.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div className="min-w-[16rem] flex-1">
            <label className="block text-xs font-medium text-slate-600 mb-1">Event</label>
            <select value={eventId} onChange={(e) => setEventId(e.target.value)} className={`${sel} w-full`}>
              <option value="">{events.length ? 'Select an event…' : 'No events on this date'}</option>
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
              {data.judges_total > 0 && <Badge tone={data.all_done ? 'success' : 'gold'}>judges done {data.judges_done}/{data.judges_total}</Badge>}
              {flagged > 0 && <Badge tone="gold"><span className="inline-flex items-center gap-1"><AlertTriangle size={11} /> {flagged} flagged</span></Badge>}
              {data.prize_cap === 0 && <Badge tone="danger">no prizes · {data.participant_count} &lt; {data.no_prize_below}</Badge>}
              {data.prize_cap === 2 && <Badge tone="gold">1st &amp; 2nd only · {data.participant_count} &lt; {data.min_entries_threshold}</Badge>}
              {showTiebreak && <Badge tone="danger"><span className="inline-flex items-center gap-1"><Scale size={11} /> tie to resolve</span></Badge>}
              {state.published ? <Badge tone="success">published</Badge> : state.finalised ? <Badge tone="gold">finalised</Badge> : null}
              <div className="flex-1" />
              <Button variant="outline" icon={RefreshCw} onClick={loadResults}>Refresh</Button>
              <Button variant="outline" icon={Printer} onClick={() => navigate(`/admin/judging/results/print/${eventId}/${groupId}`)}>Print sheet</Button>
              {!state.published && <Button variant="outline" icon={Calculator} loading={busy} onClick={() => act('compute')}>Compute &amp; save</Button>}
              {(!state.finalised || state.stale_finalise) && <Button variant="primary" icon={CheckCircle2} loading={busy} disabled={!data.complete || unreviewedDiv > 0 || data.tiebreak_needed || (data.judges_total > 0 && !data.all_done)} onClick={() => act('finalise')}>{state.finalised ? 'Finalise again' : 'Finalise'}</Button>}
              {(state.finalised || state.published) && <Button variant="outline" icon={Trophy} onClick={() => window.open(`/admin/judging/winners/${eventId}/${groupId}`, '_blank')}>{state.published ? 'Winners poster' : 'Preview winners poster'}</Button>}
              {state.finalised && !state.published && <Button variant="gold" icon={Send} loading={busy} onClick={() => act('publish')}>Publish</Button>}
            </div>

            {state.stale_finalise && <div className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">A judge changed a score after this group was finalised, so the finalised result is out of date. Click <b>Finalise again</b> before publishing (publishing is blocked until you do).</div>}
            {state.finalised && !state.published && !state.stale_finalise && <div className={`mb-3 rounded-md border px-3 py-2 text-xs font-medium ${state.all_agreed ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-amber-300 bg-amber-50 text-amber-800'}`}>{state.all_agreed ? '✓ All judges have agreed this result — ready to publish.' : `Judges agreed: ${state.judges_agreed ?? 0}/${state.judges_total ?? 0}. Each judge confirms from their screen. You can publish now (override) if needed.`}</div>}
            {!data.complete && <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">Not all judges have scored every participant yet — you can compute a preview, but finalising is disabled until scoring is complete.</div>}
            {data.complete && data.judges_total > 0 && !data.all_done && <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">Judges are still finishing — {data.judges_done}/{data.judges_total} have clicked “Done scoring”. Finalise unlocks once all judges mark done.</div>}
            {overUnhandled.length > 0 && <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">⏱ Chest {overUnhandled.map((r) => r.chest_number).join(', ')} went over time + grace and {overUnhandled.length === 1 ? 'has' : 'have'} not been reviewed. Check the <b>DQ</b> column — <b>Disqualify</b> if the rules require it, or leave it and finalise if allowed.</div>}
            {data.complete && unreviewedDiv > 0 && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{unreviewedDiv} result(s) have diverging judge ranks — click “review diverge” on each and add a note before finalising.</div>}
            {showTiebreak && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                <Scale size={14} className="shrink-0" />
                <span className="flex-1">
                  A prize-position tie (chest {tieRows.map((r) => r.chest_number).join(', ')}) could not be broken by the criteria order. Rule #8: the Chairman opens a tiebreaker and each judge gives a 1–10 mark to the tied chests.
                </span>
                {isChairman
                  ? <Button variant="danger" icon={Scale} onClick={() => setTbOpen(true)}>Resolve tie</Button>
                  : <span className="rounded bg-white px-2 py-1 font-medium text-red-600">Chairman must resolve this.</span>}
              </div>
            )}

            <Card className="p-0 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Place</th>
                      <th className="px-2 py-2 text-center">Final rank</th>
                      <th className="px-3 py-2 text-left">Chest</th>
                      {(data.judge_meta || data.judges.map((n) => ({ name: n, agreed: false }))).map((j, ji) => (
                        <th key={ji} className="px-2 py-2 text-center" title={j.agreed ? `${j.name} — agreed the result` : j.name}>
                          <span className={j.agreed ? 'text-emerald-700' : ''}>{j.name.split(' ')[0]}{j.agreed ? ' ✓' : ''}</span>
                          <div className="text-[10px] font-normal normal-case text-slate-400">rank</div>
                        </th>
                      ))}
                      <th className="px-2 py-2 text-center">Rank sum</th>
                      <th className="px-2 py-2 text-center">Avg %</th>
                      <th className="px-2 py-2 text-center">Grade</th>
                      <th className="px-2 py-2 text-center">Points</th>
                      <th className="px-2 py-2 text-center">Extra</th>
                      <th className="px-2 py-2 text-center">Flags</th>
                      <th className="px-2 py-2 text-center">DQ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.results.map((r) => (
                      <tr key={r.registration_id} className={r.is_disqualified ? 'bg-red-50/60 text-slate-400' : showTiebreak && r.needs_tiebreak ? 'bg-red-50/40' : r.place ? 'bg-gold-50/30' : ''}>
                        <td className="px-3 py-2">{r.is_disqualified ? <span className="rounded bg-red-200 px-1.5 py-0.5 text-[10px] font-bold text-red-800">DQ</span> : r.place ? <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gold-500 text-xs font-bold text-white">{r.place}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-2 py-2 text-center font-semibold text-navy-800">{r.final_rank ?? '—'}</td>
                        <td className="px-3 py-2"><span className="font-mono font-semibold text-navy-800">{r.chest_number}</span></td>
                        {r.per_judge.map((pj, i) => <td key={i} className="px-2 py-2 text-center text-slate-600" title={`total ${pj.total}`}>{pj.rank}</td>)}
                        <td className="px-2 py-2 text-center font-semibold text-navy-800">{r.rank_sum}</td>
                        <td className="px-2 py-2 text-center text-slate-600">{r.avg_pct}</td>
                        <td className="px-2 py-2 text-center">{r.grade ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-navy-700">{r.grade}</span> : <span className="text-slate-300">—</span>}</td>
                        <td className="px-2 py-2 text-center text-slate-600">{r.total_points}</td>
                        <td className="px-2 py-2 text-center">
                          {isChairman && !state.published && !r.place ? (
                            <select value={r.extra_prize_type || ''} onChange={(e) => setExtra(r, e.target.value)}
                              className="rounded border border-slate-300 px-1 py-0.5 text-[11px] text-slate-600 focus:outline-none focus:ring-1 focus:ring-navy-300">
                              <option value="">—</option>
                              <option value="additional_3rd">Add&apos;l 3rd</option>
                              <option value="consolation">Consolation</option>
                            </select>
                          ) : r.extra_prize_type ? (
                            <span className="rounded bg-navy-100 px-1.5 py-0.5 text-[10px] font-medium text-navy-700">{EXTRA_LABEL[r.extra_prize_type]}</span>
                          ) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <div className="flex justify-center gap-1">
                            {showTiebreak && r.needs_tiebreak
                              ? <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700" title="Exact tie — needs a rule #8 tiebreaker">tiebreak{r.mark_sum ? ` · ${r.mark_sum}` : ''}</span>
                              : r.exact_tie && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700" title="Exact tie — identical on rank sum and every criterion">tie</span>}
                            {r.divergence_flag && (state.published
                              ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600" title={r.divergence_notes || ''}>diverge</span>
                              : r.divergence_notes
                                ? <button onClick={() => reviewDiv(r)} title={r.divergence_notes} className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] text-green-700">diverge ✓</button>
                                : <button onClick={() => reviewDiv(r)} className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700">review diverge</button>)}
                          </div>
                        </td>
                        <td className="px-2 py-2 text-center">
                          {r.over_time && !r.is_disqualified && <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700" title="Timer: exceeded time + grace period">&#9201; over</span>}
                          {r.is_disqualified ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700" title={r.dq_reason || 'Disqualified'}>Disqualified</span>
                              {isChairman && !state.published && <button onClick={() => reinstate(r)} className="text-[10px] text-navy-600 underline">reinstate</button>}
                            </span>
                          ) : (isChairman && !state.published
                            ? <button onClick={() => disqualify(r)} className="rounded border border-red-300 bg-white px-1.5 py-0.5 text-[10px] font-medium text-red-700 hover:bg-red-50">Disqualify</button>
                            : <span className="text-slate-300">&mdash;</span>)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <p className="mt-2 text-xs text-slate-500">
              Final rank = the resolved order: lowest sum of the {data.judges.length} judges' ranks, equal sums broken by C1 totals, then C2…, then tiebreaker marks — so a shared rank sum is not a tie once the criteria separate them. “Place” shows prize positions only. Grade is from average % (a separate measure, so neighbouring ranks can differ in grade). Divergence threshold ±{data.absolute_threshold} ranks.
              {' '}Prizes: none below {data.no_prize_below} entries; 1st &amp; 2nd only below {data.min_entries_threshold}; full top&nbsp;3 at {data.min_entries_threshold}+.
            </p>
          </>
        )}

      {tbOpen && data && (
        <TiebreakModal
          token={token} eventId={eventId} groupId={groupId}
          judges={data.judge_meta || []} tieRows={tieRows}
          onClose={() => setTbOpen(false)}
          onDone={(msg) => { setTbOpen(false); setFlash(msg); loadResults(); loadGroups(); }}
        />
      )}
    </AdminLayout>
  );
}

// Chairman opens the session (records who authorised) and the judges' 1–10 marks
// are keyed in for each tied chest. Higher mark total wins the tie (rule #8).
function TiebreakModal({ token, eventId, groupId, judges, tieRows, onClose, onDone }) {
  const [marks, setMarks] = useState({}); // `${reg}:${judge_id}` -> string
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const setCell = (reg, jid, v) => setMarks((m) => ({ ...m, [`${reg}:${jid}`]: v }));
  const allFilled = tieRows.length > 0 && judges.length > 0 &&
    tieRows.every((r) => judges.every((j) => {
      const v = Number(marks[`${r.registration_id}:${j.judge_id}`]);
      return Number.isInteger(v) && v >= 1 && v <= 10;
    }));

  async function save() {
    setBusy(true); setErr('');
    try {
      const { unlock_id } = await resultsApi.tiebreakUnlock(token, eventId, groupId);
      const payload = [];
      for (const r of tieRows) for (const j of judges)
        payload.push({ registration_id: r.registration_id, judge_id: j.judge_id, mark: Number(marks[`${r.registration_id}:${j.judge_id}`]) });
      await resultsApi.tiebreakMarks(token, eventId, groupId, unlock_id, payload);
      onDone('Tiebreaker marks recorded — tie resolved by mark total.');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-navy-800"><Scale size={16} /> Resolve tie (rule #8)</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="px-4 py-3">
          <p className="mb-3 text-xs text-slate-500">
            Each judge gives every tied chest a mark from 1 to 10. The highest total wins the higher place.
            Opening this session records you (the Chairman) as the authoriser.
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Chest</th>
                  {judges.map((j) => <th key={j.judge_id} className="px-2 py-2 text-center" title={j.name}>{j.name.split(' ')[0]}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tieRows.map((r) => (
                  <tr key={r.registration_id}>
                    <td className="px-3 py-2 font-mono font-semibold text-navy-800">{r.chest_number}</td>
                    {judges.map((j) => (
                      <td key={j.judge_id} className="px-2 py-2 text-center">
                        <input type="number" min="1" max="10" value={marks[`${r.registration_id}:${j.judge_id}`] || ''}
                          onChange={(e) => setCell(r.registration_id, j.judge_id, e.target.value)}
                          className="w-16 rounded-md border border-slate-300 px-2 py-1 text-center focus:outline-none focus:ring-2 focus:ring-navy-300" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {err && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-4 py-3">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!allFilled} onClick={save}>Save marks &amp; resolve</Button>
        </div>
      </div>
    </div>
  );
}
