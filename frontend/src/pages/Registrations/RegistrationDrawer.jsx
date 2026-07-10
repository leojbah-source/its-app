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
  X, User, CreditCard, Tag, ScrollText, CheckCircle2, AlertTriangle, ExternalLink,
} from 'lucide-react';
import Button from '../../components/ui/Button';
import { Badge } from '../../components/ui/Card';
import { participantsApi, paymentsApi } from '../../api/client';
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

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');         // action key in flight
  const [issueNote, setIssueNote] = useState('');
  const [showIssueForm, setShowIssueForm] = useState(false);
  const [rejectFor, setRejectFor] = useState(null);  // payment id
  const [rejectReason, setRejectReason] = useState('');
  const [flash, setFlash] = useState('');

  // Chairman event corrections
  const [editEvents, setEditEvents] = useState(false);
  const [removeIds, setRemoveIds] = useState(new Set());
  const [addCodes, setAddCodes] = useState('');
  const [correctionReason, setCorrectionReason] = useState('');
  const [eligibleEvents, setEligibleEvents] = useState([]);

  const participantId = registration?.participant_id;

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

  useEffect(() => { load(); }, [load]);

  if (!registration) return null;

  const p = data?.participant;

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

          {!participantId ? (
            <p className="text-sm text-slate-500">
              Team registration — member details and CPR documents are under the Teams view.
            </p>
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
                <SectionTitle icon={User}>Identity &amp; CPR verification</SectionTitle>
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <Field label="Full name" value={p.full_name} />
                  <Field label="CPR" value={p.cpr_number} />
                  <Field label="DOB" value={p.dob ? new Date(p.dob).toLocaleDateString('en-GB') : null} />
                  <Field label="Group" value={p.age_group_code} />
                  <Field label="School" value={p.school_name} />
                  <Field label="Entry method" value={p.cpr_verified_method === 'ocr' ? 'OCR scan' : 'Manual'} />
                  <Field label="Parent" value={p.parent_name} />
                  <Field label="Parent contact" value={p.parent_whatsapp || p.parent_phone} />
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
                        {pay.status === 'pending' && (
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

        <div className="border-t border-slate-200 px-6 py-4 flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}
