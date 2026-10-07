// src/pages/judging/JudgeCertificatesPrint.jsx
// Certificates of appreciation for an event's judges — one per page, same
// branded template as the winners' certificates. Date + Event + Judge name
// (no age group). Print / Save-as-PDF from the browser.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Printer, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { printoutsApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const fmtDate = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

export default function JudgeCertificatesPrint() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const { eventId } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { printoutsApi.judgeCertificates(token, eventId).then(setData).catch((e) => setErr(e.message)); }, [token, eventId]);

  if (err) return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-sm text-slate-500">Loading certificates…</div>;

  const b = data.branding || {};
  const ev = data.event || {};
  const judges = data.judges || [];

  return (
    <div className="bg-slate-100 print:bg-white">
      <style>{`@media print { .no-print { display:none !important; } .cert { page-break-after: always; } .cert:last-child { page-break-after: auto; } @page { size: landscape; margin: 12mm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`}</style>

      <div className="no-print sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <button onClick={() => navigate('/admin/judging/assignment')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><ArrowLeft size={15} /> Back</button>
        <span className="text-sm font-medium text-navy-800">{ev.event_code} · {ev.event_name}</span>
        <div className="flex-1" />
        <span className="text-sm text-slate-500">{judges.length} certificate{judges.length === 1 ? '' : 's'}</span>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-700"><Printer size={15} /> Print / Save PDF</button>
      </div>

      {judges.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">No judges are assigned to this event yet.</p>
        : (
          <div className="mx-auto max-w-5xl p-4 print:p-0">
            {judges.map((j, i) => (
              <div key={i} className="cert mx-auto mb-4 bg-white p-8 shadow print:mb-0 print:shadow-none" style={{ border: '6px double #C9A227' }}>
                <div className="flex items-center justify-between">
                  {asset(b.kca_logo_url) ? <img src={asset(b.kca_logo_url)} alt="KCA" className="h-16 w-auto object-contain" /> : <span />}
                  <div className="text-center">
                    <div className="text-sm font-semibold text-navy-700">{b.event_year_label || 'KCA Indian Talent Scan'}</div>
                    <div className="text-[11px] text-slate-500">Kerala Catholic Association, Bahrain</div>
                  </div>
                  {asset(b.sponsor_logo_url) ? <img src={asset(b.sponsor_logo_url)} alt={b.sponsor_name || ''} className="h-14 w-auto object-contain" /> : <span />}
                </div>

                {asset(b.its_logo_url) && (
                  <div className="mt-4 flex justify-center">
                    <img src={asset(b.its_logo_url)} alt="Indian Talent Scan" className="h-28 w-auto object-contain" />
                  </div>
                )}

                <div className={`${asset(b.its_logo_url) ? 'mt-3' : 'mt-6'} text-center`}>
                  <div className="text-2xl font-bold tracking-wide text-navy-800">Certificate of Appreciation</div>
                  <div className="mx-auto mt-2 h-0.5 w-24 bg-gold-500" />
                  <p className="mt-6 text-sm text-slate-500">This certificate is presented to</p>
                  <p className="mt-1 text-3xl font-bold text-navy-900">{j.full_name}</p>
                  <p className="mt-4 text-base text-slate-700">
                    in grateful appreciation of serving as a <span className="font-semibold text-gold-700">Judge</span> for
                  </p>
                  <p className="mt-1 text-lg font-semibold text-navy-800">
                    {ev.event_name}{ev.event_date ? ` — held on ${fmtDate(ev.event_date)}` : ''}
                  </p>
                </div>

                <div className="mt-12 flex items-end justify-between px-4">
                  <div className="w-60 text-center">
                    <div className="mb-1 h-10 border-b border-slate-400" />
                    <div className="text-xs leading-snug text-slate-600">President,<br />Kerala Catholic Association</div>
                  </div>
                  <div className="w-60 text-center">
                    <div className="mb-1 h-10 border-b border-slate-400" />
                    <div className="text-xs leading-snug text-slate-600">Chairman,<br />Indian Talent Scan Organizing Committee</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
