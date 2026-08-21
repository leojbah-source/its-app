// src/pages/CertificatesPrint.jsx
// Branded winners' certificates — one per finalised prize placement (1st/2nd/3rd).
// Print / Save-as-PDF from the browser; one certificate per page. Toolbar hidden
// on paper. Chairman/Admin/SuperAdmin.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Printer, ArrowLeft } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { printoutsApi, API_BASE } from '../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const PLACE = { 1: 'First', 2: 'Second', 3: 'Third' };

export default function CertificatesPrint() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => { printoutsApi.certificates(token, 'active').then(setData).catch((e) => setErr(e.message)); }, [token]);

  if (err) return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-sm text-slate-500">Loading certificates…</div>;

  const b = data.branding || {};
  const winners = data.winners || [];

  return (
    <div className="bg-slate-100 print:bg-white">
      <style>{`@media print { .no-print { display:none !important; } .cert { page-break-after: always; } .cert:last-child { page-break-after: auto; } @page { size: landscape; margin: 12mm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`}</style>

      <div className="no-print sticky top-0 z-10 flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <button onClick={() => navigate('/admin/awards')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><ArrowLeft size={15} /> Back to Awards</button>
        <div className="flex-1" />
        <span className="text-sm text-slate-500">{winners.length} certificate{winners.length === 1 ? '' : 's'}</span>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-700"><Printer size={15} /> Print / Save PDF</button>
      </div>

      {winners.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">No finalised prize winners yet. Finalise event results first.</p>
        : (
          <div className="mx-auto max-w-5xl p-4 print:p-0">
            {winners.map((w, i) => (
              <div key={i} className="cert mx-auto mb-4 bg-white p-8 shadow print:mb-0 print:shadow-none" style={{ border: '6px double #C9A227' }}>
                <div className="flex items-center justify-between">
                  {asset(b.kca_logo_url) ? <img src={asset(b.kca_logo_url)} alt="KCA" className="h-16 w-auto object-contain" /> : <span />}
                  <div className="text-center">
                    <div className="text-sm font-semibold text-navy-700">{b.event_year_label || 'KCA Indian Talent Scan'}</div>
                    <div className="text-[11px] text-slate-500">Kerala Catholic Association, Bahrain</div>
                  </div>
                  {asset(b.sponsor_logo_url) ? <img src={asset(b.sponsor_logo_url)} alt={b.sponsor_name || ''} className="h-14 w-auto object-contain" /> : <span />}
                </div>

                <div className="mt-6 text-center">
                  <div className="text-2xl font-bold tracking-wide text-navy-800">Certificate of Achievement</div>
                  <div className="mx-auto mt-2 h-0.5 w-24 bg-gold-500" />
                  <p className="mt-6 text-sm text-slate-500">This is to certify that</p>
                  <p className="mt-1 text-3xl font-bold text-navy-900">{w.name}</p>
                  <p className="mt-4 text-base text-slate-700">
                    secured <span className="font-semibold text-gold-700">{PLACE[w.prize_place] || `${w.prize_place}th`} Place</span> in
                  </p>
                  <p className="mt-1 text-lg font-semibold text-navy-800">
                    {w.event_name}{w.category_name ? ` · ${w.category_name}` : ''}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Age group: {w.age_group_label || '—'}{w.grade ? `  ·  Grade ${w.grade}` : ''}
                  </p>
                </div>

                <div className="mt-10 flex items-end justify-between px-6">
                  <div className="text-center">
                    <div className="h-10 w-40 border-b border-slate-400" />
                    <div className="mt-1 text-xs text-slate-500">Convener</div>
                  </div>
                  <div className="text-center">
                    <div className="h-10 w-40 border-b border-slate-400" />
                    <div className="mt-1 text-xs text-slate-500">Chairman</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
