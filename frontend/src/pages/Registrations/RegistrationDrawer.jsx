// src/pages/registrations/RegistrationDrawer.jsx
// Participant verification drawer. From here the admin can:
//   - view the uploaded CPR scans (front/back) + photo, check name/DOB, and
//     mark the identity as VERIFIED or flag an ISSUE (parent is notified);
//   - review payment proofs (BenefitPay/bank screenshots) and confirm or
//     reject them with a reason (parent notified);
//   - (Chairman only) correct the selected events with a mandatory reason;
//   - see the audit trail of every change.
// Every action is written to the insert-only audit_log.

import { useEffect, useState, useCallback } from 'react';
import {
  X, User, CreditCard, Tag, ScrollText, CheckCircle2, AlertTriangle, ExternalLink, MessageSquare,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import { Badge } from '../../components/ui/Card';
import { participantsApi, paymentsApi, teamsApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';

const VERIFY_TONE = { pending: 'slate', verified: 'success', issue: 'danger' };
const PAY_TONE = { pending: 'gold', confirmed: 'success', rejected: 'danger' };

function SectionTitle({ icon: Icon, children }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3 flex items-center gap-2">
      <Icon size={12} /> {children}
    </h3>
  );
}

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-slate-800 font-medium">{value || '—'}</p>
    </div>
  );
}

function DocLink({ url, label }) {
  if (!url) return <span className="text-xs text-red-500">{label}: missing</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer"
       className="inline-flex items-center gap-1 text-xs font-medium text-navy-700 underline">
      <ExternalLink size={11} /> {label}
    </a>
  );
}

export default function RegistrationDrawer({ registration, token, onClose, onUpdated }) {
  const { user } = useAuth();
  const isChairman = ['Chairman', 'SuperAdmin'].includes(user?.role);
  const canEditParent = ['SuperAdmin', 'Admin', 'Coordinator', 'Registrar'].includes(user?.role);
  const isRegistrar = user?.role === 'Registrar'; // may action cash payments only

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');         // action key in flight
  const [issueNote, setIssueNote] = useState('');
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [rejectFor, setRejectFor] = useState(null);  // payment id
  const [rejectReason, setRejectReason] = useState('');
  const [flash, setFlash] = useState('');
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgText, setMsgText] = useState('');
  const [msgInfo, setMsgInfo] = useState(null);
  const [msgBusy, setMsgBusy] = useState('');
  const [msgErr, setMsgErr] = useState('');
  const [editContact, setEditContact] = useState(false);
  const [editEmail, setEditEmail] = useState(false);
  const [emailVal, setEmailVal] = useState('');
  const [editId, setEditId] = useState(false);
  const [idName, setIdName] = useState('');
  const [idCpr, setIdCpr] = useState('');
  const [idDob, setIdDob] = useState('');
  const [idGender, setIdGender] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactWa2, setContactWa2] = useState('');

  // Chairman event corrections
  const [editEvents, setEditEvents] = useState(false);
  const [removeIds, setRemoveIds] = useState(new Set());
  const [addCodes, setAddCodes] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [eligibleEvents, setEligibleEvents] = useState([]);

  const participantId = registration?.participant_id;
  const teamId = registration?.team_id;
  const isTeam = !participantId && !!teamId;
  const [team, setTeam] = useState(null);
  const [teamLoading, setTeamLoading] = useState(false);
  const [teamErr, setTeamErr] = useState('');
  const [teamBusyMember, setTeamBusyMember] = useState(null);
  const [teamMsg, setTeamMsg] = useState('');
  const [teamNotifyBusy, setTeamNotifyBusy] = useState(false);
  const [teamNoteOpen, setTeamNoteOpen] = useState(false);

  const load = useCallback(async () => {
    if (!participantId) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      setData(await participantsApi.detail(token, participantId));
    } catch (err) {
      setError(err.message || 'Failed to load participant');
    } finally {
      setLoading(false);
    }
  }, [token, participantId]);

  useEffect(() => {
    if (!isTeam || !teamId) return;
    let alive = true;
    setTeamLoading(true); setTeamErr('');
    teamsApi.members(token, teamId)
      .then((d) => { if (alive) { setTeam(d); setTeamMsg(`Dear ${d.team?.team_name || 'team'} leader, regarding your team registration for ${d.team?.event_name || 'the event'}: `); } })
      .catch((e) => { if (alive) setTeamErr(e.message || 'Failed to load team'); })
      .finally(() => { if (alive) setTeamLoading(false); });
    return () => { alive = false; };
  }, [token, isTeam, teamId]);

  async function toggleMemberVerify(m) {
    setTeamBusyMember(m.id);
    setTeam((t) => ({ ...t, members: t.members.map((x) => (x.id === m.id ? { ...x, cpr_verified: !x.cpr_verified } : x)) }));
    try { await teamsApi.verifyMember(token, teamId, m.id, !m.cpr_verified); }
    catch (e) { setFlash(e.message); setTeam((t) => ({ ...t, members: t.members.map((x) => (x.id === m.id ? { ...x, cpr_verified: m.cpr_verified } : x)) })); }
    finally { setTeamBusyMember(null); }
  }
  async function sendTeamNote() {
    if (!teamMsg.trim()) { setFlash('Enter a message first.'); return; }
    setTeamNotifyBusy(true); setFlash('');
    try {
      const r = await teamsApi.notify(token, teamId, teamMsg.trim());
      setFlash(r.delivered ? `Note sent to ${r.recipients} number(s).` : 'Could not send the note.');
      setTeamNoteOpen(false);
    } catch (e) { setFlash(e.message); }
    finally { setTeamNotifyBusy(false); }
  }
  const isImageUrl = (u) => /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(String(u || ''));

  useEffect(() => { load(); }, [load]);

  if (!registration) return null;

  const p = data?.participant;

  async function openMessage() {
    setMsgOpen(true); setMsgErr(''); setMsgText(''); setMsgInfo(null); setMsgBusy('load');
    try { const info = await participantsApi.reminderInfo(token, participantId); setMsgInfo(info); setMsgText(info.message || ''); }
    catch (e) { setMsgErr(e.message); }
    finally { setMsgBusy(''); }
  }
  async function sendMessage() {
    setMsgBusy('send'); setMsgErr('');
    try {
      const r = await participantsApi.remind(token, participantId, msgText);
      setFlash(r.delivered ? 'Reminder sent on WhatsApp.' : 'Reminder queued (delivery pending).');
      setMsgOpen(false); load();
    } catch (e) { setMsgErr(e.message); }
    finally { setMsgBusy(''); }
  }
  async function saveContact() {
    setBusy('contact'); setFlash('');
    try {
      await participantsApi.updateContact(token, participantId, { guardian_name: contactName, guardian_phone: contactPhone, whatsapp_number_2: contactWa2 });
      setFlash('Contact updated.'); setEditContact(false); load();
    } catch (e) { setFlash(e.message); }
    finally { setBusy(''); }
  }

  async function saveEmail() {
    setBusy('email'); setFlash('');
    try {
      await participantsApi.updateParentEmail(token, participantId, { email: emailVal.trim() });
      setFlash('Parent email updated.'); setEditEmail(false); load();
    } catch (e) { setFlash(e.message); }
    finally { setBusy(''); }
  }

  function openIdentityEdit() {
    setIdName(p?.full_name || '');
    setIdCpr(p?.cpr_number || '');
    setIdDob(p?.dob ? new Date(p.dob).toISOString().slice(0, 10) : '');
    setIdGender(p?.gender || '');
    setEditId(true);
  }
  async function saveIdentity() {
    setBusy('identity'); setFlash('');
    try {
      await participantsApi.updateIdentity(token, participantId, {
        full_name: idName.trim(), cpr_number: idCpr.trim(), dob: idDob, gender: idGender,
      });
      setFlash('Participant details updated.'); setEditId(false); load();
    } catch (e) { setFlash(e.message); }
    finally { setBusy(''); }
  }

  async function doVerify(status) {
    setBusy('verify');
    setFlash('');
    try {
      const r = await participantsApi.verify(token, participantId, {
        status, note: status === 'issue' ? issueNote.trim() : undefined,
      });
      setFlash(status === 'verified'
        ? 'Marked as admin verified.'
        : `Issue recorded${r.parent_notified ? ' — parent has been notified' : ''}.`);
      setShowIssueForm(false);
      setIssueNote('');
      load();
      onUpdated?.();
    } catch (err) { setFlash(err.message); }
    finally { setBusy(''); }
  }

  async function doPayment(id, action) {
    setBusy(`pay${id}`);
    setFlash('');
    try {
      if (action === 'confirm') await paymentsApi.confirm(token, id);
      else await paymentsApi.reject(token, id, rejectReason.trim());
      setFlash(action === 'confirm' ? 'Payment confirmed — parent notified.' : 'Payment rejected — parent notified.');
      setRejectFor(null);
      setRejectReason('');
      load();
    } catch (err) { setFlash(err.message); }
    finally { setBusy(''); }
  }

  async function openEventEdit() {
    setEditEvents(true);
    setRemoveIds(new Set());
    setAddCodes('');
    setCorrectionReason('');
    try {
      const evs = await participantsApi.eligibleEvents(token, p.age_group_id, p.gender);
      setEligibleEvents(evs);
    } catch { setEligibleEvents([]); }
  }

  async function doEventCorrection() {
    const activeIds = new Set(
      (data.registrations || []).filter((r) => r.status === 'registered').map((r) => r.event_id));
    const add_event_ids = eligibleEvents
      .filter((e) => addCodes.split(',').map((c) => c.trim().toUpperCase()).includes(e.event_code.toUpperCase()))
      .filter((e) => !activeIds.has(e.id))
      .map((e) => e.id);
    setBusy('events');
    setFlash('');
    try {
      const r = await participantsApi.chairmanEvents(token, participantId, {
        add_event_ids,
        remove_event_ids: [...removeIds],
        reason: correctionReason.trim(),
      });
      setFlash(`Events corrected — now: ${r.events.join(', ') || 'none'}.`);
      setEditEvents(false);
      load();
      onUpdated?.();
    } catch (err) { setFlash(err.message); }
    finally { setBusy(''); }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" aria-modal="true">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-50 flex h-full w-full max-w-lg flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {registration.participant_name || registration.team_name}
            </h2>
            <p className="text-xs text-slate-500 font-mono">{registration.cpr_number}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-slate-100">
            <X size={20} className="text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {flash && (
            <p className="rounded-lg bg-navy-50 border border-navy-200 px-3 py-2 text-xs text-navy-700">{flash}</p>
          )}

          {isTeam ? (
            teamLoading ? (
              <div className="flex justify-center py-10"><div className="h-8 w-8 animate-spin rounded-full border-4 border-navy-200 border-t-navy-600" /></div>
            ) : teamErr ? (
              <p className="text-sm text-red-600">{teamErr}</p>
            ) : team ? (
              <section>
                {team.team && (
                  <p className="mb-2 text-sm font-semibold text-navy-800">
                    {team.team.event_code ? <span className="font-mono text-xs text-navy-500 mr-1.5">{team.team.event_code}</span> : null}
                    {team.team.event_name}{team.team.age_group_code ? ` · ${team.team.age_group_code}` : ''}
                  </p>
                )}
                <h3 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Team members</h3>
                <p className="mb-3 text-xs text-slate-500">
                  {(team.members || []).length} member(s) · {(team.members || []).filter((m) => m.cpr_verified).length} verified — tick each as you confirm their CPR, name and date of birth.
                </p>
                <div className="overflow-x-auto rounded-lg border border-slate-200">
                  <table className="w-full min-w-[460px] text-sm">
                    <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-3 py-2 w-10 text-center">OK</th>
                        <th className="px-3 py-2">Name</th>
                        <th className="px-3 py-2">CPR</th>
                        <th className="px-3 py-2">DOB</th>
                        <th className="px-3 py-2">Group</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {(team.members || []).map((m) => (
                        <tr key={m.id} className={m.cpr_verified ? 'bg-emerald-50/40' : ''}>
                          <td className="px-3 py-2 text-center">
                            <input type="checkbox" checked={!!m.cpr_verified} disabled={!canEditParent || teamBusyMember === m.id}
                              onChange={() => toggleMemberVerify(m)}
                              className="h-4 w-4 rounded border-slate-300 text-navy-600 focus:ring-navy-500" />
                          </td>
                          <td className="px-3 py-2 font-medium text-slate-800">{m.full_name}{m.is_substitute ? <span className="ml-1 text-[10px] text-amber-600">(sub)</span> : ''}</td>
                          <td className="px-3 py-2 font-mono text-slate-600">{m.cpr_number}</td>
                          <td className="px-3 py-2 text-slate-600">{m.dob ? new Date(m.dob).toLocaleDateString('en-GB') : '—'}</td>
                          <td className="px-3 py-2 text-slate-500">{m.age_group_code || '—'}</td>
                        </tr>
                      ))}
                      {(team.members || []).length === 0 && (
                        <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400">No members recorded.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {(team.documents || []).length > 0 && (
                  <div className="mt-3">
                    <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-slate-400">CPR documents ({team.documents.length})</h4>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {team.documents.map((d) => (
                        <a key={d.id} href={d.url} target="_blank" rel="noreferrer" title={d.original_name || 'Document'}
                          className="group block overflow-hidden rounded-md border border-slate-200 hover:border-navy-400">
                          {isImageUrl(d.url) ? (
                            <img src={d.url} alt={d.original_name || 'CPR'} loading="lazy"
                              className="h-24 w-full object-cover" />
                          ) : (
                            <div className="flex h-24 w-full items-center justify-center bg-slate-50 text-[11px] text-navy-700">
                              <ExternalLink size={14} className="mr-1" /> Open
                            </div>
                          )}
                          <div className="truncate px-1.5 py-1 text-[10px] text-slate-500">{d.original_name || 'Document'}</div>
                        </a>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-4 border-t border-slate-100 pt-3">
                  {!teamNoteOpen ? (
                    <button onClick={() => setTeamNoteOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-navy-700 hover:bg-slate-50">
                      <MessageSquare size={14} /> Send a note to the team leader
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <label className="block text-[11px] font-medium uppercase tracking-wide text-slate-400">Note to the team leader (WhatsApp) — edit before sending</label>
                      <textarea value={teamMsg} onChange={(e) => setTeamMsg(e.target.value)} rows={4}
                        className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300" />
                      <div className="flex justify-end gap-2">
                        <Button variant="outline" size="sm" onClick={() => setTeamNoteOpen(false)}>Cancel</Button>
                        <Button variant="primary" size="sm" icon={MessageSquare} loading={teamNotifyBusy} disabled={!teamMsg.trim()} onClick={sendTeamNote}>Send note</Button>
                      </div>
                      <p className="text-[11px] text-slate-400">Sent to the number(s) on the team leader's account (both WhatsApp numbers if a second one is on file).</p>
                    </div>
                  )}
                </div>
              </section>
            ) : null
          ) : loading ? (
            <div className="flex justify-center py-10">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-navy-200 border-t-navy-600" />
            </div>
          ) : error ? (
            <p className="text-sm text-red-600">{error}</p>
          ) : p && (
            <>
              {/* ── Identity & CPR verification ── */}
              <section>
                <div className="flex items-center justify-between">
                  <SectionTitle icon={User}>Identity &amp; CPR verification</SectionTitle>
                  {canEditParent && !editId && (
                    <button onClick={openIdentityEdit} className="mb-1 text-[11px] font-medium text-navy-600 hover:underline">Edit details</button>
                  )}
                </div>
                {editId && (
                  <div className="mb-3 rounded-lg border border-navy-200 bg-navy-50/50 p-3">
                    <div className="grid grid-cols-2 gap-3">
                      <label className="block text-[11px] font-medium text-slate-500">Full name
                        <input value={idName} onChange={(e) => setIdName(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-800" />
                      </label>
                      <label className="block text-[11px] font-medium text-slate-500">CPR number
                        <input value={idCpr} onChange={(e) => setIdCpr(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-800" />
                      </label>
                      <label className="block text-[11px] font-medium text-slate-500">Date of birth
                        <input type="date" value={idDob} onChange={(e) => setIdDob(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-800" />
                      </label>
                      <label className="block text-[11px] font-medium text-slate-500">Gender
                        <select value={idGender} onChange={(e) => setIdGender(e.target.value)} className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-800">
                          <option value="">—</option>
                          <option value="M">Male</option>
                          <option value="F">Female</option>
                        </select>
                      </label>
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-400">Age group and PWA username update automatically from DOB, name and CPR.</p>
                    <div className="mt-2 flex gap-2">
                      <Button variant="primary" size="sm" loading={busy === 'identity'} onClick={saveIdentity}>Save details</Button>
                      <Button variant="outline" size="sm" onClick={() => setEditId(false)}>Cancel</Button>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <Field label="Full name" value={p.full_name} />
                  <Field label="CPR" value={p.cpr_number} />
                  <Field label="DOB" value={p.dob ? new Date(p.dob).toLocaleDateString('en-GB') : null} />
                  <Field label="Group" value={p.age_group_code} />
                  <Field label="School" value={p.school_name} />
                  <Field label="Entry method" value={p.cpr_verified_method === 'ocr' ? 'OCR scan' : 'Manual'} />
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Parent (login email)</p>
                    {!editEmail ? (
                      <p className="text-sm font-medium text-slate-800">
                        {p.parent_name || '—'}
                        <span className="block text-xs font-normal text-slate-500">{p.parent_email || 'no email on file'}</span>
                        {canEditParent && (
                          <button
                            onClick={() => { setEmailVal(p.parent_email || ''); setEditEmail(true); }}
                            className="text-[11px] font-normal text-navy-600 hover:underline">Edit email</button>
                        )}
                      </p>
                    ) : (
                      <div className="mt-1 space-y-1.5">
                        <input type="email" value={emailVal} onChange={(e) => setEmailVal(e.target.value)} placeholder="parent@example.com"
                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
                        <p className="text-[10px] text-slate-400">Used for the password-reset link and confirmation emails.</p>
                        <div className="flex gap-2">
                          <Button variant="primary" size="sm" loading={busy === 'email'} onClick={saveEmail}>Save</Button>
                          <Button variant="outline" size="sm" onClick={() => setEditEmail(false)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                  <div>
                    <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Parent contact</p>
                    {!editContact ? (
                      <div>
                        <p className="text-sm font-medium text-slate-800">
                          {p.guardian_phone || p.parent_whatsapp || p.parent_phone || '—'}
                          {isChairman && (
                            <button
                              onClick={() => { setContactName(p.guardian_name || ''); setContactPhone(p.guardian_phone || ''); setContactWa2(p.parent_whatsapp_2 || ''); setEditContact(true); }}
                              className="ml-2 text-[11px] font-normal text-navy-600 hover:underline">Edit</button>
                          )}
                        </p>
                        {p.parent_whatsapp_2 && (
                          <p className="text-xs text-slate-500">2nd WhatsApp: {p.parent_whatsapp_2}</p>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1 space-y-1.5">
                        <input value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="Guardian name"
                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
                        <input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="Contact number (WhatsApp)"
                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
                        <input value={contactWa2} onChange={(e) => setContactWa2(e.target.value)} placeholder="2nd WhatsApp (optional, with country code)"
                          className="w-full rounded border border-slate-300 px-2 py-1 text-sm" />
                        <div className="flex gap-2">
                          <Button variant="primary" size="sm" loading={busy === 'contact'} onClick={saveContact}>Save</Button>
                          <Button variant="outline" size="sm" onClick={() => setEditContact(false)}>Cancel</Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 mb-3">
                  <DocLink url={p.cpr_scan_url} label="CPR front" />
                  <DocLink url={p.cpr_scan_back_url} label="CPR back" />
                  <DocLink url={p.photo_url} label="Photo" />
                </div>
                {p.cpr_scan_url && (
                  <a href={p.cpr_scan_url} target="_blank" rel="noreferrer">
                    <img src={p.cpr_scan_url} alt="CPR scan"
                         className="max-h-44 rounded-lg border border-slate-200 mb-3" />
                  </a>
                )}

                <div className="flex items-center gap-2 mb-2">
                  <Badge tone={VERIFY_TONE[p.admin_verified_status] || 'slate'}>
                    {p.admin_verified_status === 'verified' ? 'Admin verified'
                      : p.admin_verified_status === 'issue' ? 'Issue flagged' : 'Not verified yet'}
                  </Badge>
                  {p.admin_verified_by_name && (
                    <span className="text-[11px] text-slate-400">
                      by {p.admin_verified_by_name}
                      {p.admin_verified_at ? ` · ${new Date(p.admin_verified_at).toLocaleString('en-GB')}` : ''}
                    </span>
                  )}
                </div>
                {p.admin_verify_note && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
                    {p.admin_verify_note}
                  </p>
                )}

                {!showIssueForm ? (
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" icon={CheckCircle2}
                      loading={busy === 'verify'} onClick={() => doVerify('verified')}>
                      Mark verified
                    </Button>
                    <Button variant="outline" size="sm" icon={AlertTriangle}
                      onClick={() => setShowIssueForm(true)}>
                      Report issue
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <textarea
                      value={issueNote}
                      onChange={(e) => setIssueNote(e.target.value)}
                      rows={2}
                      placeholder="Describe the problem, e.g. 'DOB on card reads 27/03/2001 but form says 2002' — sent to the parent"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setShowIssueForm(false)}>Cancel</Button>
                      <Button variant="danger" size="sm" loading={busy === 'verify'}
                        disabled={!issueNote.trim()} onClick={() => doVerify('issue')}>
                        Flag issue &amp; notify parent
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              {/* ── Payments ── */}
              <section>
                <SectionTitle icon={CreditCard}>Payments</SectionTitle>
                {data.payments.length === 0 ? (
                  <p className="text-sm text-slate-400">No payments submitted.</p>
                ) : (
                  <div className="space-y-3">
                    {data.payments.map((pay) => (
                      <div key={pay.id} className="rounded-lg border border-slate-200 p-3 space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="font-semibold text-slate-800">
                            BD {Number(pay.amount).toFixed(3)}
                            <span className="ml-2 text-xs font-normal text-slate-500">
                              {pay.method === 'cash' ? 'KCA office' : pay.method === 'benefitpay' ? 'BenefitPay' : 'Bank transfer'}
                              {pay.reference ? ` · ref ${pay.reference}` : ''}
                            </span>
                          </span>
                          <Badge tone={PAY_TONE[pay.status] || 'slate'}>{pay.status}</Badge>
                        </div>
                        {pay.proof_url && (
                          <a href={pay.proof_url} target="_blank" rel="noreferrer">
                            <img src={pay.proof_url} alt="payment proof"
                                 className="max-h-36 rounded border border-slate-200" />
                          </a>
                        )}
                        {pay.notes && <p className="text-[11px] text-slate-500 whitespace-pre-line">{pay.notes}</p>}
                        {pay.status === 'pending' && isRegistrar && pay.method !== 'cash' && (
                          <p className="text-[11px] text-slate-400">
                            Electronic payment — verified by the Accountant.
                          </p>
                        )}
                        {pay.status === 'pending' && !(isRegistrar && pay.method !== 'cash') && (
                          rejectFor === pay.id ? (
                            <div className="space-y-2">
                              <textarea
                                value={rejectReason}
                                onChange={(e) => setRejectReason(e.target.value)}
                                rows={2}
                                placeholder="Reason, e.g. 'Transfer amount is BD 10 but BD 12 is due' — sent to the parent"
                                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                              />
                              <div className="flex gap-2">
                                <Button variant="outline" size="sm" onClick={() => setRejectFor(null)}>Cancel</Button>
                                <Button variant="danger" size="sm" loading={busy === `pay${pay.id}`}
                                  disabled={!rejectReason.trim()}
                                  onClick={() => doPayment(pay.id, 'reject')}>
                                  Reject &amp; notify parent
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="flex gap-2">
                              <Button variant="primary" size="sm" loading={busy === `pay${pay.id}`}
                                onClick={() => doPayment(pay.id, 'confirm')}>
                                Confirm payment
                              </Button>
                              <Button variant="outline" size="sm" onClick={() => { setRejectFor(pay.id); setRejectReason(''); }}>
                                Reject…
                              </Button>
                            </div>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* ── Events (Chairman corrections) ── */}
              <section>
                <SectionTitle icon={Tag}>Events</SectionTitle>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {data.registrations.map((r) => (
                    <span key={r.id}
                      title={`${r.event_name} — ${r.status}`}
                      className={`rounded px-1.5 py-0.5 text-[11px] font-mono border ${
                        r.status !== 'registered'
                          ? 'bg-slate-50 text-slate-400 border-slate-200 line-through'
                          : editEvents && removeIds.has(r.event_id)
                            ? 'bg-red-50 text-red-600 border-red-300 line-through cursor-pointer'
                            : `bg-navy-50 text-navy-700 border-navy-200${editEvents ? ' cursor-pointer' : ''}`}`}
                      onClick={editEvents && r.status === 'registered'
                        ? () => setRemoveIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(r.event_id)) next.delete(r.event_id); else next.add(r.event_id);
                            return next;
                          })
                        : undefined}
                    >
                      {r.event_code}
                    </span>
                  ))}
                </div>

                {isChairman && !editEvents && (
                  <Button variant="outline" size="sm" onClick={openEventEdit}>
                    Correct events (Chairman)
                  </Button>
                )}
                {editEvents && (
                  <div className="space-y-2 rounded-lg border border-gold-300 bg-gold-50/50 p-3">
                    <p className="text-[11px] text-slate-600">
                      Tap event chips above to mark them for removal. To add events, enter their
                      codes below (comma-separated).
                    </p>
                    <input
                      value={addCodes}
                      onChange={(e) => setAddCodes(e.target.value)}
                      placeholder="Add events by code, e.g. D02, L03"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <textarea
                      value={correctionReason}
                      onChange={(e) => setCorrectionReason(e.target.value)}
                      rows={2}
                      placeholder="Reason for the correction (required — recorded in the audit trail)"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    />
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => setEditEvents(false)}>Cancel</Button>
                      <Button variant="primary" size="sm" loading={busy === 'events'}
                        disabled={!correctionReason.trim() || (removeIds.size === 0 && !addCodes.trim())}
                        onClick={doEventCorrection}>
                        Apply correction
                      </Button>
                    </div>
                  </div>
                )}
              </section>

              {/* ── Audit trail ── */}
              <section>
                <SectionTitle icon={ScrollText}>Audit trail</SectionTitle>
                {data.audit.length === 0 ? (
                  <p className="text-sm text-slate-400">No recorded changes yet.</p>
                ) : (
                  <ol className="space-y-2">
                    {data.audit.map((a) => (
                      <li key={a.id} className="text-xs border-l-2 border-slate-200 pl-3">
                        <span className="font-semibold text-slate-700">{a.action}</span>
                        <span className="text-slate-400"> · {a.changed_by_name || 'system'} · {new Date(a.changed_at).toLocaleString('en-GB')}</span>
                        {a.reason && <p className="text-slate-500">{a.reason}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>

        <div className="border-t border-slate-200 px-6 py-4 flex justify-end gap-2">
          {p && <Button variant="outline" size="sm" icon={MessageSquare} onClick={openMessage}>Message parent</Button>}
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
      {msgOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" onClick={() => setMsgOpen(false)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 flex items-center gap-2 text-base font-semibold text-navy-900"><MessageSquare size={16} /> Message parent</h3>
            {msgInfo?.last_reminder_at && (
              <p className="mb-2 text-xs text-slate-500">
                Last reminder: {new Date(msgInfo.last_reminder_at).toLocaleString('en-GB')}
                {(Date.now() - new Date(msgInfo.last_reminder_at).getTime()) < 5 * 864e5 && <span className="text-amber-600"> — under 5 days ago</span>}
              </p>
            )}
            {msgBusy === 'load' ? <p className="py-6 text-center text-sm text-slate-400">Loading…</p> : (
              <>
                <textarea rows={9} value={msgText} onChange={(e) => setMsgText(e.target.value)}
                  className="mb-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300" />
                <p className="mb-2 text-[11px] text-slate-400">Sent via WhatsApp to {msgInfo?.phone || 'the guardian number on file'}. Edit the text above before sending if you like.</p>
                {msgErr && <div className="mb-2 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{msgErr}</div>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setMsgOpen(false)}>Cancel</Button>
                  <Button variant="primary" size="sm" loading={msgBusy === 'send'} disabled={!msgText.trim()} onClick={sendMessage}>Send WhatsApp</Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
