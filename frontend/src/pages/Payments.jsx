// src/pages/Payments.jsx
// Accountant / Chairman / Admin: verify parent payments (confirm or reject) and
// process refunds from withdrawn events. Confirming a payment is what finally
// clears a participant's balance; rejecting frees a bad/duplicate submission.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Check, X, Wallet, Undo2, ExternalLink } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { paymentsApi, yearConfigApi, API_BASE } from '../api/client';

const money = (v) => `BD ${Number(v || 0).toFixed(3)}`;
const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const METHOD = { cash: 'Cash', benefitpay: 'BenefitPay', bank_transfer: 'Bank transfer' };
const tone = (s) => (s === 'confirmed' ? 'success' : s === 'rejected' ? 'danger' : 'gold');

export default function Payments() {
  const { token } = useAuth();
  const [yearId, setYearId] = useState(null);
  const [tab, setTab] = useState('payments');
  const [status, setStatus] = useState('pending');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');

  const load = useCallback(async (yId, t, st, query) => {
    setLoading(true); setFlash('');
    try {
      if (t === 'payments') setRows(await paymentsApi.list(token, { yearId: yId, status: st || undefined, q: query || undefined }));
      else setRows(await paymentsApi.refunds(token, { yearId: yId, status: st || undefined }));
    } catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    yearConfigApi.get(token).then((cfg) => { setYearId(cfg.id); load(cfg.id, tab, status, q); })
      .catch((e) => { setFlash(e.message); setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => { if (yearId) load(yearId, tab, status, q); /* eslint-disable-next-line */ }, [tab, status]);

  async function confirmPayment(r) {
    try { await paymentsApi.confirm(token, r.id); setFlash(`Confirmed ${money(r.amount)} for ${r.participant_name || 'participant'}.`); load(yearId, tab, status, q); }
    catch (e) { setFlash(e.message); }
  }
  async function rejectPayment(r) {
    const reason = window.prompt(`Reject ${money(r.amount)} for ${r.participant_name || 'participant'} — reason (the parent is notified to resubmit):`, '');
    if (reason == null || !reason.trim()) return;
    try { await paymentsApi.reject(token, r.id, reason.trim()); setFlash('Payment rejected.'); load(yearId, tab, status, q); }
    catch (e) { setFlash(e.message); }
  }
  async function confirmRefund(r) {
    const amtStr = window.prompt(`Refund for ${r.participant_name} — amount (BD):`, String(r.original_amount ?? r.refund_amount ?? ''));
    if (amtStr == null) return;
    const method = window.prompt('Refund method: cash / benefitpay / bank_transfer', 'cash');
    if (method == null) return;
    try { await paymentsApi.refundConfirm(token, r.id, { refund_amount: Number(amtStr), method: method.trim() }); setFlash('Refund confirmed.'); load(yearId, tab, status, q); }
    catch (e) { setFlash(e.message); }
  }
  async function rejectRefund(r) {
    if (!window.confirm(`Reject the refund request for ${r.participant_name}?`)) return;
    try { await paymentsApi.refundReject(token, r.id); setFlash('Refund rejected.'); load(yearId, tab, status, q); }
    catch (e) { setFlash(e.message); }
  }

  const sel = 'rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';
  const TabBtn = ({ id, icon: Icon, label }) => (
    <button onClick={() => { setTab(id); setStatus('pending'); }}
      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium ${tab === id ? 'bg-navy-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>
      <Icon size={15} /> {label}
    </button>
  );

  return (
    <AdminLayout title="Payments & Refunds" subtitle="Verify parent payments and process refunds. Confirming a payment clears the balance.">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <TabBtn id="payments" icon={Wallet} label="Payments" />
        <TabBtn id="refunds" icon={Undo2} label="Refunds" />
        <div className="flex-1" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
          <option value="pending">Pending</option>
          <option value="confirmed">Confirmed</option>
          <option value="rejected">Rejected</option>
          <option value="">All</option>
        </select>
        {tab === 'payments' && (
          <form onSubmit={(e) => { e.preventDefault(); load(yearId, tab, status, q); }}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name / CPR" className={sel} />
          </form>
        )}
        <Button variant="outline" icon={RefreshCw} onClick={() => load(yearId, tab, status, q)}>Refresh</Button>
      </div>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {loading ? <PageLoader label="Loading…" />
        : rows.length === 0 ? <Card><p className="py-8 text-center text-sm text-slate-400">Nothing here.</p></Card>
        : tab === 'payments' ? (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Participant</th>
                    <th className="px-3 py-2 text-left">Parent</th>
                    <th className="px-2 py-2 text-right">Amount</th>
                    <th className="px-2 py-2 text-left">Method</th>
                    <th className="px-2 py-2 text-left">Reference / proof</th>
                    <th className="px-2 py-2 text-center">Status</th>
                    <th className="px-2 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2"><div className="font-medium text-slate-800">{r.participant_name || '—'}</div><div className="text-[11px] text-slate-400">{r.cpr_number}</div></td>
                      <td className="px-3 py-2 text-slate-600">{r.parent_name || '—'}</td>
                      <td className="px-2 py-2 text-right font-semibold text-navy-800">{money(r.amount)}</td>
                      <td className="px-2 py-2 text-slate-600">{METHOD[r.method] || r.method}</td>
                      <td className="px-2 py-2 text-slate-500">
                        {r.reference || ''}
                        {asset(r.proof_url) && <a href={asset(r.proof_url)} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-navy-600 hover:underline">proof <ExternalLink size={11} /></a>}
                      </td>
                      <td className="px-2 py-2 text-center"><Badge tone={tone(r.status)}>{r.status}</Badge></td>
                      <td className="px-2 py-2 text-right">
                        {r.status === 'pending' ? (
                          <div className="flex justify-end gap-1">
                            <Button variant="primary" icon={Check} onClick={() => confirmPayment(r)}>Confirm</Button>
                            <Button variant="outline" icon={X} onClick={() => rejectPayment(r)}>Reject</Button>
                          </div>
                        ) : <span className="text-[11px] text-slate-400">{r.confirmed_by_name ? `by ${r.confirmed_by_name}` : ''}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ) : (
          <Card className="p-0 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Participant</th>
                    <th className="px-2 py-2 text-left">Events withdrawn</th>
                    <th className="px-2 py-2 text-left">Reason</th>
                    <th className="px-2 py-2 text-right">Original</th>
                    <th className="px-2 py-2 text-right">Refund</th>
                    <th className="px-2 py-2 text-center">Status</th>
                    <th className="px-2 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2"><div className="font-medium text-slate-800">{r.participant_name}</div><div className="text-[11px] text-slate-400">{r.cpr_number}</div></td>
                      <td className="px-2 py-2 text-slate-600">{r.events_withdrawn}</td>
                      <td className="px-2 py-2 text-slate-500">{r.reason}</td>
                      <td className="px-2 py-2 text-right text-slate-600">{money(r.original_amount)}</td>
                      <td className="px-2 py-2 text-right font-semibold text-navy-800">{r.refund_amount != null ? money(r.refund_amount) : '—'}</td>
                      <td className="px-2 py-2 text-center"><Badge tone={tone(r.status)}>{r.status}</Badge></td>
                      <td className="px-2 py-2 text-right">
                        {r.status === 'pending' ? (
                          <div className="flex justify-end gap-1">
                            <Button variant="primary" icon={Check} onClick={() => confirmRefund(r)}>Confirm</Button>
                            <Button variant="outline" icon={X} onClick={() => rejectRefund(r)}>Reject</Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
    </AdminLayout>
  );
}
