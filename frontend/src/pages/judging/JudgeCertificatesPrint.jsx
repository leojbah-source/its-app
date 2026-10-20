// src/pages/judging/JudgeCertificatesPrint.jsx
// Certificates of appreciation for an event's judges — one per landscape page.
// Two print modes:
//   • Full certificate  — logos, border, titles, signatures + name & event.
//   • Name only         — prints ONLY the judge name and event/date, in the
//     exact same positions, for overprinting onto pre-printed blank sheets.
// Layout is mm-based A4-landscape and matches the standalone blank template,
// so both modes align. Date + Event + Judge name. Print / Save-as-PDF.
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Printer, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { printoutsApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const fmtDate = (d) => (d ? new Date(d + 'T00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '');

const CSS = `
  .cert {
    width: 100%; max-width: 1040px; margin: 16px auto;
    height: calc(210mm - 25mm);
    border: 3mm double #C9A227; border-radius: 2mm;
    padding: 9mm 14mm; display: flex; flex-direction: column; background: #fff;
    box-shadow: 0 1px 6px rgba(0,0,0,0.15);
    font-family: Helvetica, Arial, "Segoe UI", sans-serif; color: #3a2a16;
  }
  .cert .top { display: flex; align-items: center; justify-content: space-between; gap: 8mm; }
  .cert .kca { height: 24mm; width: auto; object-fit: contain; }
  .cert .bfc { height: 15mm; width: auto; object-fit: contain; }
  .cert .ttl { text-align: center; flex: 1; }
  .cert .t1 { font-size: 20pt; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; color: #0f2f5f; line-height: 1.15; white-space: nowrap; }
  .cert .t2 { font-size: 11.5pt; color: #5b6472; margin-top: 1.5mm; }
  .cert .mid { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
  .cert .its { height: 33mm; width: auto; object-fit: contain; margin-bottom: 3mm; }
  .cert .coa { font-size: 29pt; font-weight: 800; letter-spacing: 1px; color: #0f2f5f; }
  .cert .rule { width: 34mm; height: 1.2mm; background: #C9A227; margin: 2.5mm auto 0; border-radius: 2px; }
  .cert .lead { font-size: 13pt; color: #6b7280; margin-top: 6mm; }
  .cert .namezone { height: 14mm; display: flex; align-items: center; justify-content: center; }
  .cert .name { font-size: 28pt; font-weight: 800; color: #0f2f5f; }
  .cert .lead2 { font-size: 13.5pt; color: #3f4651; margin-top: 1mm; }
  .cert .eventzone { height: 12mm; display: flex; align-items: center; justify-content: center; }
  .cert .event { font-size: 15pt; font-weight: 700; color: #0f2f5f; }
  .cert .sign { display: flex; align-items: flex-end; justify-content: space-between; padding: 0 6mm; margin-top: 4mm; }
  .cert .sbox { width: 78mm; text-align: center; }
  .cert .sline { height: 11mm; border-bottom: 0.4mm solid #7a8493; margin-bottom: 2mm; }
  .cert .scap { font-size: 11pt; color: #4b5563; line-height: 1.3; }

  /* Name-only: hide everything that is already on the pre-printed sheet,
     keeping its space so the name & event stay in the same position. */
  .names-mode .cert { border-color: transparent; box-shadow: none; }
  .names-mode .ink { visibility: hidden; }

  @media print {
    .no-print { display: none !important; }
    @page { size: A4 landscape; margin: 12mm; }
    .cert { margin: 0; max-width: none; box-shadow: none; page-break-after: always; }
    .cert:last-child { page-break-after: auto; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

export default function JudgeCertificatesPrint() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const { eventId } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('full'); // 'full' | 'names'

  useEffect(() => { printoutsApi.judgeCertificates(token, eventId).then(setData).catch((e) => setErr(e.message)); }, [token, eventId]);

  // Blank the document title so the browser print header doesn't stamp the app name.
  useEffect(() => {
    const prev = document.title; document.title = ' ';
    return () => { document.title = prev; };
  }, []);

  if (err) return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-sm text-slate-500">Loading certificates…</div>;

  const b = data.branding || {};
  const ev = data.event || {};
  const judges = data.judges || [];
  const yearLabel = b.event_year_label || 'KCA Indian Talent Scan';
  const eventLine = `${ev.event_name || ''}${ev.event_date ? `  —  held on ${fmtDate(ev.event_date)}` : ''}`;

  const tabBtn = (val, label) => (
    <button onClick={() => setMode(val)}
      className={`px-3 py-1.5 text-sm font-medium ${mode === val ? 'bg-navy-600 text-white' : 'bg-white text-navy-700 hover:bg-slate-50'}`}>
      {label}
    </button>
  );

  return (
    <div className={`bg-slate-100 print:bg-white ${mode === 'names' ? 'names-mode' : ''}`}>
      <style>{CSS}</style>

      <div className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
        <button onClick={() => navigate('/admin/judging/assignment')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"><ArrowLeft size={15} /> Back</button>
        <span className="text-sm font-medium text-navy-800">{ev.event_code} · {ev.event_name}</span>
        <div className="flex-1" />
        <div className="inline-flex overflow-hidden rounded-md border border-navy-300">
          {tabBtn('full', 'Full certificate')}
          <span className="w-px bg-navy-200" />
          {tabBtn('names', 'Name only')}
        </div>
        <span className="text-sm text-slate-500">{judges.length} certificate{judges.length === 1 ? '' : 's'}</span>
        <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-700"><Printer size={15} /> Print / Save PDF</button>
      </div>

      {mode === 'names' && (
        <div className="no-print mx-auto max-w-3xl px-4 pt-3 text-center text-xs text-amber-700">
          Name-only mode: prints just the judge name and event line, positioned for your pre-printed blank certificates.
          Load the pre-printed sheets in the printer (A4, landscape) and keep "Headers and footers" off in the print dialog.
        </div>
      )}

      {judges.length === 0 ? <p className="p-8 text-center text-sm text-slate-400">No judges are assigned to this event yet.</p>
        : (
          <div className="p-4 print:p-0">
            {judges.map((j, i) => (
              <div key={i} className="cert">
                <div className="top ink">
                  {asset(b.kca_logo_url) ? <img src={asset(b.kca_logo_url)} alt="KCA" className="kca" /> : <span className="kca" />}
                  <div className="ttl">
                    <div className="t1">{yearLabel}</div>
                    <div className="t2">Kerala Catholic Association, Bahrain</div>
                  </div>
                  {asset(b.sponsor_logo_url) ? <img src={asset(b.sponsor_logo_url)} alt={b.sponsor_name || 'Sponsor'} className="bfc" /> : <span className="bfc" />}
                </div>

                <div className="mid">
                  {asset(b.its_logo_url) && <img src={asset(b.its_logo_url)} alt="Indian Talent Scan" className="its ink" />}
                  <div className="coa ink">Certificate of Appreciation</div>
                  <div className="rule ink" />
                  <div className="lead ink">This certificate is presented to</div>
                  <div className="namezone"><div className="name">{j.full_name}</div></div>
                  <div className="lead2 ink">in grateful appreciation of serving as a Judge for</div>
                  <div className="eventzone"><div className="event">{eventLine}</div></div>
                </div>

                <div className="sign ink">
                  <div className="sbox"><div className="sline" /><div className="scap">President,<br />Kerala Catholic Association</div></div>
                  <div className="sbox"><div className="sline" /><div className="scap">Chairman,<br />Indian Talent Scan Organizing Committee</div></div>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
