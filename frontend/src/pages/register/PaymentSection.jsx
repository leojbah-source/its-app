// src/pages/register/PaymentSection.jsx
// Server-driven fee summary + payment submission for a participant.
// Data source: GET  /api/register/participant/:id/fees   (portalApi.fees)
// Actions:     POST /api/register/upload                 (proof screenshot)
//              POST /api/register/participant/:id/payment (portalApi.paymentSubmit)

import { useEffect, useState, useCallback } from 'react';
import { BanknoteIcon, Upload, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { portalApi, API_BASE } from './registerApi';

const fmt = (v) => `BD ${Number(v || 0).toFixed(3)}`;

const METHODS = [
  { value: 'cash',          label: 'Cash at KCA office' },
  { value: 'benefitpay',    label: 'BenefitPay' },
  { value: 'bank_transfer', label: 'Bank transfer' },
];

function StatusChip({ status }) {
  const map = {
    pending:   ['bg-amber-100 text-amber-700', Clock,        'Pending'],
    confirmed: ['bg-emerald-100 text-emerald-700', CheckCircle2, 'Confirmed'],
    rejected:  ['bg-red-100 text-red-600', XCircle,      'Rejected'],
  };
  const [cls, Icon, label] = map[status] || map.pending;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${cls}`}>
      <Icon size={12} /> {label}
    </span>
  );
}

export default function PaymentSection({ token, participantId, config, refreshKey }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Payment form state
  const [showForm, setShowForm] = useState(false);
  const [method, setMethod] = useState('benefitpay');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [proofUrl, setProofUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await portalApi.fees(token, participantId);
      setData(d);
      setAmount(String(d.summary.balance_due > 0 ? d.summary.balance_due : ''));
    } catch (err) {
      setError(err.message || 'Failed to load fees');
    } finally {
      setLoading(false);
    }
  }, [token, participantId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setFormError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/api/register/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Upload failed');
      setProofUrl(d.url);
    } catch (err) {
      setFormError(err.message || 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit() {
    setFormError('');
    const amt = Number(amount);
    if (!amt || amt <= 0) { setFormError('Enter a valid amount.'); return; }
    if (method !== 'cash' && !proofUrl) {
      setFormError('Please upload your payment screenshot.');
      return;
    }
    setSubmitting(true);
    try {
      const result = await portalApi.paymentSubmit(token, participantId, {
        amount: amt, method, reference: reference.trim() || undefined, proof_url: proofUrl || undefined,
      });
      setEmailSent(Boolean(result?.email_sent));
      setSubmitted(true);
      setShowForm(false);
      setProofUrl(''); setReference('');
      load();
      setTimeout(() => setSubmitted(false), 10000);
    } catch (err) {
      setFormError(err.message || 'Payment submission failed.');
    } finally {
      setSubmitting(false);
    }
  }

  const [recheck, setRecheck] = useState({ busy: false, note: '' });
  async function handleRecheckMembership() {
    setRecheck({ busy: true, note: '' });
    try {
      const r = await portalApi.membershipRefresh(token);
      setRecheck({ busy: false, note: r.note || '' });
      load(); // refresh fees with new status
    } catch (err) {
      setRecheck({ busy: false, note: err.message || 'Could not re-check membership.' });
    }
  }

  if (loading && !data) return null;
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!data || data.items.length === 0) return null;

  const { items, payments, summary, membership } = data;
  const due = summary.balance_due;

  return (
    <section>
      <h2 className="font-semibold text-slate-800 text-base mb-3 flex items-center gap-2">
        <BanknoteIcon size={18} className="text-emerald-600" />
        Fees &amp; Payment
      </h2>

      {membership?.note && (
        <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-800 space-y-2">
          <p>{membership.note}</p>
          <button
            onClick={handleRecheckMembership}
            disabled={recheck.busy}
            className="text-xs font-semibold underline text-amber-900 disabled:opacity-50"
          >
            {recheck.busy ? 'Checking…' : 'Re-check membership'}
          </button>
          {recheck.note && <p className="text-xs">{recheck.note}</p>}
        </div>
      )}

      <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
        {/* ── Fee table (live from server, member rate already applied) ── */}
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs">
              <th className="text-left px-4 py-2.5 text-slate-500 font-medium">Event</th>
              <th className="text-right px-4 py-2.5 text-slate-500 font-medium w-24">Fee</th>
            </tr>
          </thead>
          <tbody>
            {items.map((r, i) => (
              <tr key={r.registration_id} className={i < items.length - 1 ? 'border-b border-slate-100' : ''}>
                <td className="px-4 py-2.5 text-slate-700 font-medium">{r.event_name}</td>
                <td className="px-4 py-2.5 text-right font-semibold text-slate-800">{fmt(r.fee_amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-navy-50 border-t-2 border-navy-200">
              <td className="px-4 py-3 font-bold text-navy-800 text-sm">
                Total ({items.length} event{items.length !== 1 ? 's' : ''})
              </td>
              <td className="px-4 py-3 text-right font-bold text-navy-800">{fmt(summary.fees_total)}</td>
            </tr>
          </tfoot>
        </table>

        {/* ── Balance strip ── */}
        <div className={`px-4 py-3 border-t text-sm font-semibold flex justify-between
          ${due > 0 ? 'bg-amber-50 border-amber-100 text-amber-800' : 'bg-emerald-50 border-emerald-100 text-emerald-700'}`}>
          <span>{due > 0 ? 'Balance due' : 'Fully paid'}</span>
          <span>{fmt(Math.max(due, 0))}</span>
        </div>
        {summary.paid_pending > 0 && (
          <p className="px-4 py-2 text-xs text-slate-500 border-t border-slate-100">
            {fmt(summary.paid_pending)} submitted and awaiting confirmation by KCA.
          </p>
        )}

        {/* ── Payment history ── */}
        {payments.length > 0 && (
          <div className="border-t border-slate-200 px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-slate-700">Payments</p>
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between text-xs text-slate-600">
                <span>{fmt(p.amount)} · {METHODS.find((m) => m.value === p.method)?.label || p.method}</span>
                <StatusChip status={p.status} />
              </div>
            ))}
          </div>
        )}

        {submitted && (
          <p className="px-4 py-2.5 text-xs font-medium text-emerald-700 bg-emerald-50 border-t border-emerald-100">
            Payment submitted! You will receive a WhatsApp confirmation once KCA verifies it.
            {emailSent
              ? ' A registration summary email with all your details has been sent to you.'
              : ''}
          </p>
        )}

        {/* ── Make a payment ── */}
        {due > 0 && !showForm && (
          <div className="px-4 py-3 border-t border-slate-200">
            <button
              onClick={() => setShowForm(true)}
              className="w-full rounded-xl bg-emerald-600 py-3 text-sm font-semibold text-white hover:bg-emerald-700 transition-colors"
            >
              Make a Payment — {fmt(due)}
            </button>
          </div>
        )}

        {showForm && (
          <div className="px-4 py-4 border-t border-slate-200 space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Payment method</label>
              <div className="grid grid-cols-3 gap-2">
                {METHODS.map((m) => (
                  <button
                    key={m.value}
                    onClick={() => setMethod(m.value)}
                    className={`rounded-lg border px-2 py-2 text-xs font-medium transition-colors
                      ${method === m.value
                        ? 'border-navy-600 bg-navy-50 text-navy-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'}`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Method-specific instructions from year config */}
            {method === 'benefitpay' && config?.benefit_pay_number && (
              <p className="text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">
                Send to KCA BenefitPay <b>{config.benefit_pay_number}</b>. Include your child's
                name and this number in the transaction notes, then upload the screenshot below.
              </p>
            )}
            {method === 'bank_transfer' && config?.kca_iban && (
              <p className="text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">
                Transfer to KCA IBAN <b>{config.kca_iban}</b>. Include your child's name in the
                remarks, then upload the confirmation screenshot below.
              </p>
            )}
            {method === 'cash' && (
              <p className="text-xs text-slate-600 bg-slate-50 rounded-lg px-3 py-2">
                Pay at the KCA office. Your registration stays provisional until KCA staff
                confirm receipt.
              </p>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Amount (BD)</label>
              <input
                type="number" min="0" step="0.001" value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-navy-500 focus:outline-none"
              />
            </div>

            {method !== 'cash' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Transaction reference (optional)
                  </label>
                  <input
                    value={reference} onChange={(e) => setReference(e.target.value)}
                    placeholder="e.g. BenefitPay ref no."
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-navy-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Payment screenshot <span className="text-red-500">*</span>
                  </label>
                  <label className={`flex items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4 text-xs font-medium cursor-pointer transition-colors
                    ${proofUrl ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-500 hover:border-navy-400'}`}>
                    <Upload size={14} />
                    {uploading ? 'Uploading…' : proofUrl ? 'Screenshot uploaded ✓ (tap to replace)' : 'Upload screenshot (png/jpg, max 5 MB)'}
                    <input type="file" accept="image/*" className="hidden" onChange={handleUpload} />
                  </label>
                </div>
              </>
            )}

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button
                onClick={() => { setShowForm(false); setFormError(''); }}
                className="flex-1 rounded-xl border border-slate-300 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting || uploading}
                className="flex-1 rounded-xl bg-navy-700 py-3 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60"
              >
                {submitting ? 'Submitting…' : 'Submit Payment'}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
