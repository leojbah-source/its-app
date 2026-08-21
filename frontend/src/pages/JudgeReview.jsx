// src/pages/JudgeReview.jsx
// Chairman's judge-accountability report: flags + refusal statements (rule #9)
// and the blacklist (rule #10). Branded, printable. Chairman/SuperAdmin.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Printer, ArrowLeft, ShieldAlert } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { printoutsApi, API_BASE } from '../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const FLAG = { declined_revision: 'Declined revision', bias_noted: 'Bias noted' };

export default function JudgeReview() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { printoutsApi.judgeReview(token, 'active').then(setData).catch((e) => setErr(e.message)); }, [token]);

  if (err) return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-sm text-slate-500">Loading judge review…</div>;

  const b = data.branding || {};
  const flags = data.flags || [];
  const blacklist = data.blacklist || [];

  return (
    <div className="mx-auto max-w-4xl bg-white p-6 text-slate-800 print:p-0">
      <style>{`@media print { .no-print { display:none !important; } @page { margin: 14mm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`}</style>

      <div className="no-print mb-4 flex items-center gap-2">
        <button onClick={() => navigate('/admin/judging/judges')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><ArrowLeft size={15} /> Back to Judges</button>
        <div className="flex-1" />
        <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-700"><Printer size={15} /> Print / Save PDF</button>
      </div>

      <header className="flex items-center justify-between border-b-2 border-navy-700 pb-3">
        <div className="flex items-center gap-3">
          {asset(b.kca_logo_url) && <img src={asset(b.kca_logo_url)} alt="KCA" className="h-14 w-auto object-contain" />}
          <div>
            <div className="text-lg font-bold text-navy-800">{b.event_year_label || 'KCA Indian Talent Scan'}</div>
            <div className="text-xs text-slate-500">Judge Review — confidential (Chairman)</div>
          </div>
        </div>
        <ShieldAlert className="text-navy-400" size={26} />
      </header>

      <h2 className="mt-5 text-sm font-bold uppercase tracking-wide text-navy-800">Judge flags &amp; refusal statements (rule #9)</h2>
      {flags.length === 0 ? <p className="mt-2 text-sm text-slate-400">No judge flags recorded this year.</p>
        : (
          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-slate-300 bg-slate-50 text-left text-xs uppercase text-slate-500">
                <th className="px-2 py-2">Judge</th>
                <th className="px-2 py-2">Event</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Statement</th>
                <th className="px-2 py-2">Date</th>
                <th className="px-2 py-2 text-center">Reviewed</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((f, i) => (
                <tr key={i} className="border-b border-slate-100 align-top">
                  <td className="px-2 py-1.5 font-medium">{f.judge_name}</td>
                  <td className="px-2 py-1.5 text-slate-500">{f.event_name || '—'}</td>
                  <td className="px-2 py-1.5">{FLAG[f.flag_type] || f.flag_type}</td>
                  <td className="px-2 py-1.5 text-slate-700">{f.statement}</td>
                  <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{new Date(f.flagged_at).toLocaleDateString()}</td>
                  <td className="px-2 py-1.5 text-center">{f.reviewed_by_chairman ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <h2 className="mt-8 text-sm font-bold uppercase tracking-wide text-navy-800">Blacklist (rule #10)</h2>
      {blacklist.length === 0 ? <p className="mt-2 text-sm text-slate-400">No blacklisted judges.</p>
        : (
          <table className="mt-2 w-full border-collapse text-sm">
            <thead>
              <tr className="border-y border-slate-300 bg-slate-50 text-left text-xs uppercase text-slate-500">
                <th className="px-2 py-2">Judge</th>
                <th className="px-2 py-2">Reason</th>
                <th className="px-2 py-2">Since</th>
              </tr>
            </thead>
            <tbody>
              {blacklist.map((j, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="px-2 py-1.5 font-medium">{j.full_name}</td>
                  <td className="px-2 py-1.5 text-slate-700">{j.blacklist_reason || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-500">{j.blacklist_date ? new Date(j.blacklist_date).toLocaleDateString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      <div className="mt-12 flex justify-end">
        <div className="text-center">
          <div className="h-10 w-48 border-b border-slate-400" />
          <div className="mt-1 text-xs text-slate-500">Chairman — signature</div>
        </div>
      </div>
    </div>
  );
}
