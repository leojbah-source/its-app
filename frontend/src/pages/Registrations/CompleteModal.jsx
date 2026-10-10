// src/pages/Registrations/CompleteModal.jsx
// Staff action: finish an In-Progress individual registration for a parent who
// did everything in person but never pressed "Register". Verifies all required
// fields server-side, optionally records cash paid in office, and marks the
// entry Completed. Never touches anything until the user presses Complete.
import { useEffect, useState } from 'react';
import { X, CheckCircle2, AlertTriangle, Info, Loader2 } from 'lucide-react';
import { registrationsApi } from '../../api/client';
import Button from '../../components/ui/Button';

const bd = (v) => Number(v || 0).toFixed(3);

export default function CompleteModal({ token, registration, onClose, onCompleted }) {
  const pid = registration?.participant_id;
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [data, setData] = useState(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [reference, setReference] = useState('');
  const [sendEmail, setSendEmail] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setErr(null);
    registrationsApi.completeCheck(token, pid)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setAmount(d.fees?.balance_due ? bd(d.fees.balance_due) : '');
        setSendEmail(!!d.parent?.email);
      })
      .catch((e) => alive && setErr(e.message || 'Could not load the entry'))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [token, pid]);

  const submit = async () => {
    setSubmitting(true); setErr(null);
    try {
      const res = await registrationsApi.complete(token, pid, {
        cash_amount: amount ? Number(amount) : 0,
        payment_method: method,
        payment_reference: reference || undefined,
        send_confirmation: sendEmail,
      });
      onCompleted?.(res);
    } catch (e) {
      setErr(e.message || 'Could not complete the registration');
      setSubmitting(false);
    }
  };

  const ready = data?.ready;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5">
          <h2 className="text-base font-semibold text-slate-800">
            Complete registration
          </h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-slate-500 justify-center">
              <Loader2 size={18} className="animate-spin" /> Checking the entry…
            </div>
          ) : !data ? (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {err || 'Could not load the entry.'}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Who */}
              <div>
                <p className="text-sm font-semibold text-slate-800">{data.participant.full_name}</p>
                <p className="text-xs text-slate-500 font-mono">
                  {data.participant.cpr_number || 'No CPR'} · {data.participant.age_group_code || 'No group'}
                  {data.participant.school_name ? ` · ${data.participant.school_name}` : ''}
                </p>
                {data.parent?.name && (
                  <p className="text-xs text-slate-500 mt-0.5">Parent: {data.parent.name}{data.parent.email ? ` · ${data.parent.email}` : ''}</p>
                )}
              </div>

              {/* Blockers */}
              {data.blockers?.length > 0 && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700 mb-1">
                    <AlertTriangle size={14} /> Fix these before completing
                  </p>
                  <ul className="list-disc pl-5 text-xs text-red-700 space-y-0.5">
                    {data.blockers.map((b, i) => <li key={i}>{b}</li>)}
                  </ul>
                </div>
              )}

              {/* Warnings */}
              {data.warnings?.length > 0 && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 mb-1">
                    <Info size={14} /> Please note
                  </p>
                  <ul className="list-disc pl-5 text-xs text-amber-700 space-y-0.5">
                    {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {/* Events + fees */}
              <div className="rounded-md border border-slate-200">
                <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
                  <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Events ({data.event_count})
                  </span>
                  <span className="text-xs text-slate-500">
                    {data.fees.member_rate_applied ? 'KCA member rate' : 'Standard rate'}
                  </span>
                </div>
                <ul className="divide-y divide-slate-50">
                  {data.events.map((ev) => (
                    <li key={ev.event_code} className="flex items-center justify-between px-3 py-1.5 text-sm">
                      <span className="text-slate-700"><span className="font-mono text-xs text-navy-700">{ev.event_code}</span> · {ev.event_name}</span>
                      <span className="text-slate-500">BD {bd(ev.fee_amount)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-sm">
                  <span className="text-slate-500">Total due</span>
                  <span className="font-semibold text-slate-800">BD {bd(data.fees.total_due)}</span>
                </div>
                {data.fees.paid_confirmed > 0 && (
                  <div className="flex items-center justify-between px-3 pb-1 text-xs">
                    <span className="text-slate-400">Already recorded as paid</span>
                    <span className="text-slate-500">BD {bd(data.fees.paid_confirmed)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between px-3 pb-2 text-xs">
                  <span className="text-slate-400">Balance</span>
                  <span className={`font-medium ${data.fees.balance_due > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
                    BD {bd(data.fees.balance_due)}
                  </span>
                </div>
              </div>

              {/* Record payment taken in office */}
              <div className="rounded-md border border-slate-200 px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                  Record payment taken in office (optional)
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col text-xs text-slate-500">
                    Amount (BD)
                    <input
                      type="number" step="0.001" min="0" value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-col text-xs text-slate-500">
                    Method
                    <select
                      value={method} onChange={(e) => setMethod(e.target.value)}
                      className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:outline-none"
                    >
                      <option value="cash">Cash (office)</option>
                      <option value="benefitpay">BenefitPay</option>
                      <option value="bank_transfer">Bank transfer</option>
                    </select>
                  </label>
                  <label className="flex flex-1 flex-col text-xs text-slate-500">
                    Reference (optional)
                    <input
                      value={reference} onChange={(e) => setReference(e.target.value)}
                      placeholder="receipt / txn no."
                      className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm shadow-sm focus:border-navy-500 focus:outline-none"
                    />
                  </label>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-400">
                  Leave the amount blank to complete without recording a payment. A recorded amount is marked confirmed.
                </p>
              </div>

              {/* Send acknowledgement */}
              <label className={`flex items-center gap-2 text-sm ${data.parent?.email ? 'text-slate-700' : 'text-slate-400'}`}>
                <input
                  type="checkbox" checked={sendEmail} disabled={!data.parent?.email}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Email the confirmation to the parent
                {!data.parent?.email && <span className="text-xs">(no email on file)</span>}
              </label>

              {err && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            variant="primary" size="sm" icon={CheckCircle2}
            disabled={loading || !ready || submitting}
            onClick={submit}
          >
            {submitting ? 'Completing…' : 'Complete registration'}
          </Button>
        </div>
      </div>
    </div>
  );
}
