// src/pages/register/TeamRegister.jsx
// Team event registration (§5.5). Separate deadline from individual events.
// A team may be registered with just one member (the leader) + payment;
// remaining members can be added later, up to the event's max, with each
// member's DOB validated against the event's eligible age groups.

import { useEffect, useState, useCallback } from 'react';
import { Users, Plus, Trash2, Clock, CheckCircle2, Upload } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import { portalApi, API_BASE } from './registerApi';
import RegisterLayout from './RegisterLayout';

const fmtBD = (v) => `BD ${Number(v || 0).toFixed(3)}`;
const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

const emptyMember = () => ({ full_name: '', dob: '', cpr_number: '', school_id: '' });

const inputCls =
  'w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-400 bg-white';

// ── Member rows editor (shared by create + add-later) ────────────────────────
function MemberRows({ members, setMembers, schools, max }) {
  const update = (i, k, v) =>
    setMembers((list) => list.map((m, idx) => (idx === i ? { ...m, [k]: v } : m)));
  return (
    <div className="space-y-3">
      {members.map((m, i) => (
        <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Member {i + 1}</span>
            {members.length > 1 && (
              <button onClick={() => setMembers((l) => l.filter((_, idx) => idx !== i))}
                className="text-slate-400 hover:text-red-500">
                <Trash2 size={14} />
              </button>
            )}
          </div>
          <input placeholder="Full name (as on CPR)" value={m.full_name}
            onChange={(e) => update(i, 'full_name', e.target.value)} className={inputCls} />
          <div className="grid grid-cols-2 gap-2">
            <input type="date" value={m.dob}
              onChange={(e) => update(i, 'dob', e.target.value)} className={inputCls} />
            <input placeholder="CPR number" inputMode="numeric" value={m.cpr_number}
              onChange={(e) => update(i, 'cpr_number', e.target.value)} className={inputCls} />
          </div>
          <select value={m.school_id}
            onChange={(e) => update(i, 'school_id', e.target.value)} className={inputCls}>
            <option value="">School (optional)</option>
            {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
      ))}
      {members.length < max && (
        <button onClick={() => setMembers((l) => [...l, emptyMember()])}
          className="w-full rounded-lg border border-dashed border-slate-300 py-2.5 text-sm text-slate-500 hover:border-navy-400 flex items-center justify-center gap-1.5">
          <Plus size={14} /> Add another member
        </button>
      )}
    </div>
  );
}

// ── Team payment form ─────────────────────────────────────────────────────────
function TeamPayForm({ token, team, config, onPaid }) {
  const [method, setMethod] = useState('benefitpay');
  const [reference, setReference] = useState('');
  const [proofUrl, setProofUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function upload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/api/register/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Upload failed');
      setProofUrl(d.url);
    } catch (err) { setError(err.message); }
    finally { setUploading(false); }
  }

  async function submit() {
    setError('');
    if (method !== 'cash' && !proofUrl) { setError('Please upload the payment screenshot.'); return; }
    setBusy(true);
    try {
      await portalApi.teamPayment(token, team.id, {
        amount: Number(team.fee_amount), method,
        reference: reference.trim() || undefined,
        proof_url: proofUrl || undefined,
      });
      onPaid();
    } catch (err) { setError(err.message || 'Payment failed.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3 mt-3">
      <p className="text-sm font-semibold text-slate-700">Pay team fee — {fmtBD(team.fee_amount)}</p>
      <div className="grid grid-cols-3 gap-2">
        {[['cash', 'Cash at KCA'], ['benefitpay', 'BenefitPay'], ['bank_transfer', 'Bank transfer']].map(([v, l]) => (
          <button key={v} onClick={() => setMethod(v)}
            className={`rounded-lg border px-2 py-2 text-xs font-medium ${
              method === v ? 'border-navy-600 bg-navy-50 text-navy-700' : 'border-slate-200 text-slate-500'}`}>
            {l}
          </button>
        ))}
      </div>
      {method === 'benefitpay' && config?.benefit_pay_number && (
        <p className="text-xs text-slate-500">Send to KCA BenefitPay <b>{config.benefit_pay_number}</b>, include the team name in the notes.</p>
      )}
      {method === 'bank_transfer' && config?.kca_iban && (
        <p className="text-xs text-slate-500">Transfer to KCA IBAN <b>{config.kca_iban}</b>, include the team name in the remarks.</p>
      )}
      {method !== 'cash' && (
        <label className={`flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 py-3 text-xs font-medium cursor-pointer ${
          proofUrl ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-500'}`}>
          <Upload size={13} />
          {uploading ? 'Uploading…' : proofUrl ? 'Screenshot uploaded ✓' : 'Upload payment screenshot'}
          <input type="file" accept="image/*" className="hidden" onChange={upload} />
        </label>
      )}
      <input placeholder="Transaction reference (optional)" value={reference}
        onChange={(e) => setReference(e.target.value)} className={inputCls} />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button onClick={submit} disabled={busy || uploading}
        className="w-full rounded-lg bg-navy-700 py-2.5 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60">
        {busy ? 'Submitting…' : 'Submit Payment'}
      </button>
    </div>
  );
}

// ── My team card (members, add-later, payment) ────────────────────────────────
function TeamCard({ token, team, schools, config, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState(null);
  const [newMembers, setNewMembers] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function toggle() {
    if (!expanded && !detail) {
      try { setDetail(await portalApi.teamGet(token, team.id)); } catch { /* noop */ }
    }
    setExpanded((x) => !x);
  }

  async function saveMembers() {
    const valid = newMembers.filter((m) => m.full_name && m.dob && m.cpr_number);
    if (!valid.length) { setMsg('Fill name, DOB and CPR for each member.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await portalApi.teamAddMembers(token, team.id, valid);
      setMsg(r.note || `${r.added} member(s) added.`);
      setNewMembers([]);
      setDetail(await portalApi.teamGet(token, team.id));
      onChanged();
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  }

  const [docBusy, setDocBusy] = useState(false);
  async function uploadDoc(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setDocBusy(true); setMsg('');
    try {
      await portalApi.teamDocUpload(token, team.id, file);
      setDetail(await portalApi.teamGet(token, team.id));
      setMsg('CPR document uploaded — KCA will verify it.');
    } catch (err) { setMsg(err.message); }
    finally { setDocBusy(false); }
  }

  const paid = Number(team.paid_confirmed) + Number(team.paid_pending) >= Number(team.fee_amount);
  const belowMin = team.members_count < team.size_min;

  return (
    <div className="rounded-2xl bg-white border border-slate-200 p-4">
      <button onClick={toggle} className="w-full text-left">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-slate-800 text-sm">{team.team_name}</p>
            <p className="text-xs text-slate-500">{team.event_name} · {team.event_code}</p>
          </div>
          <div className="text-right text-xs space-y-1">
            <span className={`inline-block rounded-full px-2 py-0.5 font-medium ${
              belowMin ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
              {team.members_count}/{team.size_min}–{team.size_max} members
            </span>
            <span className={`block ${paid ? 'text-emerald-600' : 'text-amber-600'} font-medium`}>
              {paid ? `Fee ${fmtBD(team.fee_amount)} received` : `Fee due: ${fmtBD(team.fee_amount)}`}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          {detail?.members?.length > 0 && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 divide-y divide-slate-100">
              {detail.members.map((m) => (
                <div key={m.member_id} className="px-3 py-2 text-xs text-slate-600 flex justify-between">
                  <span className="font-medium text-slate-700">{m.full_name}</span>
                  <span className="font-mono text-slate-400">{m.cpr_number}</span>
                </div>
              ))}
            </div>
          )}

          {team.members_count < team.size_max && (
            <div>
              <p className="text-xs font-semibold text-slate-600 mb-2">Add members</p>
              {newMembers.length === 0 ? (
                <button onClick={() => setNewMembers([emptyMember()])}
                  className="w-full rounded-lg border border-dashed border-slate-300 py-2.5 text-sm text-slate-500 hover:border-navy-400 flex items-center justify-center gap-1.5">
                  <Plus size={14} /> Add team members
                </button>
              ) : (
                <div className="space-y-2">
                  <MemberRows members={newMembers} setMembers={setNewMembers}
                    schools={schools} max={team.size_max - team.members_count} />
                  <button onClick={saveMembers} disabled={busy}
                    className="w-full rounded-lg bg-navy-700 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
                    {busy ? 'Saving…' : 'Save Members'}
                  </button>
                </div>
              )}
            </div>
          )}
          {/* CPR documents — bulk scans, image or PDF (several members per file OK) */}
          <div>
            <p className="text-xs font-semibold text-slate-600 mb-1.5">Members' CPR copies</p>
            {detail?.documents?.length > 0 && (
              <ul className="mb-2 space-y-1">
                {detail.documents.map((d) => (
                  <li key={d.id} className="text-xs text-slate-600 flex items-center gap-1.5">
                    <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
                    <a href={d.url} target="_blank" rel="noreferrer" className="underline truncate">
                      {d.original_name || 'document'}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <label className={`flex items-center justify-center gap-2 rounded-lg border-2 border-dashed px-3 py-2.5 text-xs font-medium cursor-pointer ${
              detail?.documents?.length ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-500 hover:border-navy-400'}`}>
              <Upload size={13} />
              {docBusy ? 'Uploading…' : 'Upload CPR scans (PDF or photo — several members in one file is fine)'}
              <input type="file" accept="image/*,application/pdf" className="hidden"
                     disabled={docBusy} onChange={uploadDoc} />
            </label>
            <p className="text-[11px] text-slate-400 mt-1">
              Please upload CPR copies for all team members. KCA verifies these manually.
            </p>
          </div>

          {msg && <p className="text-xs text-navy-700">{msg}</p>}

          {!paid && <TeamPayForm token={token} team={team} config={config} onPaid={onChanged} />}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function TeamRegister() {
  const { token } = useParentAuth();
  const [config, setConfig] = useState(null);
  const [teamEvents, setTeamEvents] = useState([]);
  const [schools, setSchools] = useState([]);
  const [myTeams, setMyTeams] = useState([]);
  const [loading, setLoading] = useState(true);

  // New team form
  const [showForm, setShowForm] = useState(false);
  const [eventId, setEventId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [members, setMembers] = useState([emptyMember()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cfg, evs, sch, teams] = await Promise.all([
        portalApi.config(),
        portalApi.events(null, null, 'team'),
        portalApi.schools(),
        portalApi.myTeams(token),
      ]);
      setConfig(cfg); setTeamEvents(evs); setSchools(sch); setMyTeams(teams);
    } catch { /* page-level errors surface per action */ }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const deadlinePassed = config?.team_reg_deadline
    ? new Date() > new Date(config.team_reg_deadline) : false;
  const selectedEvent = teamEvents.find((e) => e.id === Number(eventId));

  async function handleCreate() {
    setError('');
    if (!eventId || !teamName.trim()) { setError('Choose the event and enter a team name.'); return; }
    const valid = members.filter((m) => m.full_name && m.dob && m.cpr_number);
    if (!valid.length) { setError('Enter at least one member (name, DOB, CPR) — you can add the rest later.'); return; }
    setBusy(true);
    try {
      const r = await portalApi.teamCreate(token, {
        event_id: Number(eventId), team_name: teamName.trim(), members: valid,
      });
      setCreated(r);
      setShowForm(false);
      setEventId(''); setTeamName(''); setMembers([emptyMember()]);
      load();
    } catch (err) { setError(err.message || 'Could not register the team.'); }
    finally { setBusy(false); }
  }

  return (
    <RegisterLayout title="Team Events" showBack backTo="/register/dashboard">
      <div className="space-y-5">
        {config?.team_reg_deadline && (
          <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full font-medium border ${
            deadlinePassed ? 'bg-slate-100 text-slate-500 border-slate-200'
                           : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
            <Clock size={11} />
            Team registration deadline: {fmtDate(config.team_reg_deadline)}{deadlinePassed ? ' (closed)' : ''}
          </span>
        )}

        {created && (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-300 p-4 space-y-1">
            <p className="flex items-center gap-2 font-semibold text-emerald-800 text-sm">
              <CheckCircle2 size={16} /> Team "{created.team_name}" registered!
            </p>
            <p className="text-xs text-emerald-700">{created.note}</p>
            <p className="text-xs text-emerald-700">
              Team fee: {fmtBD(created.fee_amount)} — pay from the team card below.
            </p>
          </div>
        )}

        {/* My teams */}
        {loading ? (
          <div className="flex justify-center py-10">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-navy-200 border-t-navy-600" />
          </div>
        ) : myTeams.length > 0 && (
          <section className="space-y-3">
            <h2 className="font-semibold text-slate-800 text-base flex items-center gap-2">
              <Users size={17} className="text-navy-600" /> My Teams
            </h2>
            {myTeams.map((t) => (
              <TeamCard key={t.id} token={token} team={t} schools={schools}
                config={config} onChanged={load} />
            ))}
          </section>
        )}

        {/* New team */}
        {!deadlinePassed && (
          !showForm ? (
            <button onClick={() => setShowForm(true)}
              className="w-full rounded-2xl border-2 border-dashed border-navy-300 bg-navy-50 py-4 text-base font-semibold text-navy-700 hover:bg-navy-100">
              Register a New Team →
            </button>
          ) : (
            <section className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
              <h2 className="font-semibold text-slate-800 text-base">New Team</h2>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Team event</label>
                <select value={eventId} onChange={(e) => setEventId(e.target.value)} className={inputCls}>
                  <option value="">Select team event…</option>
                  {teamEvents.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.event_name} ({ev.event_code}) — {fmtBD(ev.fee_amount)}
                    </option>
                  ))}
                </select>
                {selectedEvent && (
                  <p className="text-xs text-slate-400 mt-1">
                    Members' dates of birth must fall within this event's eligible age groups —
                    each member is checked when saved.
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Team name</label>
                <input value={teamName} onChange={(e) => setTeamName(e.target.value)}
                  placeholder="e.g. Rhythm Raiders" className={inputCls} />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Members — at least the team leader now, the rest can be added later
                </label>
                <MemberRows members={members} setMembers={setMembers} schools={schools} max={10} />
              </div>

              {error && (
                <p className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">{error}</p>
              )}

              <div className="flex gap-2">
                <button onClick={() => { setShowForm(false); setError(''); }}
                  className="flex-1 rounded-xl border border-slate-300 py-3 text-sm font-medium text-slate-600">
                  Cancel
                </button>
                <button onClick={handleCreate} disabled={busy}
                  className="flex-1 rounded-xl bg-navy-700 py-3 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60">
                  {busy ? 'Registering…' : 'Register Team'}
                </button>
              </div>
            </section>
          )
        )}
      </div>
    </RegisterLayout>
  );
}
