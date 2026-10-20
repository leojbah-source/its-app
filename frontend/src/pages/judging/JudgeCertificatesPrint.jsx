// src/pages/judging/JudgeCertificatesPrint.jsx
// Certificates of appreciation for an event's judges — one per landscape page.
// The gold border is drawn on a box that fills the printable page area
// (box-sizing: border-box + min-height), so it sits an equal distance from all
// four paper edges. Date + Event + Judge name. Print / Save-as-PDF.
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

  // Blank the document title so the browser's print header doesn't stamp
  // "TalentHub · Indian Talent Scan" across the top of each certificate.
  useEffect(() => {
    const prev = document.title; document.title = ' ';
    return () => { document.title = prev; };
  }, []);

  if (err) return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-sm text-slate-500">Loading certificates…</div>;

  const b = data.branding || {};
  const ev = data.event || {};
  const judges = data.judges || [];

  return (
    <div className="bg-slate-100 print:bg-white">
      <style>{`
        @media print {
          .no-print { display:none !important; }
          .cert { page-break-after: always; }
          .cert:last-child { page-break-after: auto; }
          @page { size: A4 landscape; margin: 12mm; }
          .cert { width: 100% !important; min-height: calc(210mm - 24mm) !important; margin: 0 !important; box-shadow: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <button onClick={() => navigate('/admin/judging/assignment')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><ArrowLeft size={15} /> Back</button>
        <span className="text-sm font-medium text-navy-800">{ev.event_code} · {ev.event_name}</span>
        <div className="flex-1" />
        <span className="text-sm text-slate-500">{judges.length} certificate{judges.length === 1 ? '' : 's'}</span>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-700"><Printer size={15} /> Print / Save PDF</button>
      </div>

      {judges.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">No judges are assigned to this event yet.</p>
        : (
          <div className="p-4 print:p-0">
            {judges.map((j, i) => (
              <div
                key={i}
                className="cert mx-auto mb-6 flex w-full max-w-[1040px] flex-col bg-white px-14 py-10 shadow print:mb-0"
                style={{ border: '8px double #C9A227', boxSizing: 'border-box', minHeight: '620px' }}
              >
                {/* Top: logos flanking the event title */}
                <div className="flex items-center justify-between gap-6">
                  {asset(b.kca_logo_url) ? <img src={asset(b.kca_logo_url)} alt="KCA" className="h-24 w-auto object-contain" /> : <span className="w-24" />}
                  <div className="text-center">
                    <div className="text-3xl font-extrabold uppercase tracking-wide text-navy-800">{b.event_year_label || 'KCA Indian Talent Scan'}</div>
                    <div className="mt-1 text-sm text-slate-500">Kerala Catholic Association, Bahrain</div>
                  </div>
                  {asset(b.sponsor_logo_url) ? <img src={asset(b.sponsor_logo_url)} alt={b.sponsor_name || ''} className="h-20 w-auto object-contain" /> : <span className="w-24" />}
                </div>

                {/* Middle: grows to fill the page so the border is even top & bottom */}
                <div className="flex flex-1 flex-col items-center justify-center text-center">
                  {asset(b.its_logo_url) && (
                    <img src={asset(b.its_logo_url)} alt="Indian Talent Scan" className="mb-4 h-32 w-auto object-contain" />
                  )}
                  <div className="text-4xl font-bold tracking-wide text-navy-800">Certificate of Appreciation</div>
                  <div className="mx-auto mt-3 h-1 w-32 bg-gold-500" />
                  <p className="mt-6 text-base text-slate-500">This certificate is presented to</p>
                  <p className="mt-2 text-4xl font-bold text-navy-900">{j.full_name}</p>
                  <p className="mt-5 text-lg text-slate-700">
                    in grateful appreciation of serving as a <span className="font-semibold text-gold-700">Judge</span> for
                  </p>
                  <p className="mt-1 text-xl font-semibold text-navy-800">
                    {ev.event_name}{ev.event_date ? ` — held on ${fmtDate(ev.event_date)}` : ''}
                  </p>
                </div>

                {/* Bottom: signatures pinned to the lower edge */}
                <div className="mt-8 flex items-end justify-between px-6">
                  <div className="w-64 text-center">
                    <div className="mb-1 h-12 border-b border-slate-400" />
                    <div className="text-sm leading-snug text-slate-600">President,<br />Kerala Catholic Association</div>
                  </div>
                  <div className="w-64 text-center">
                    <div className="mb-1 h-12 border-b border-slate-400" />
                    <div className="text-sm leading-snug text-slate-600">Chairman,<br />Indian Talent Scan Organizing Committee</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
