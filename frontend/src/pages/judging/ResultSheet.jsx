// src/pages/judging/ResultSheet.jsx
// Official printable result sheet for one event + age group (rule #13 Stage-1
// print for signatures). Branded header (KCA + sponsor logos), the FULL ranked
// list with grades + points + extra/consolation prizes, and signature lines for
// the assigned judges + Chairman. Chairman/SuperAdmin only. Print via the button
// (browser print / Save-as-PDF); the toolbar is hidden on paper.
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Printer, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { resultsApi, API_BASE } from '../../api/client';

const EXTRA_LABEL = { additional_3rd: 'Additional 3rd', consolation: 'Consolation' };
const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);

export default function ResultSheet() {
  const { eventId, ageGroupId } = useParams();
  const navigate = useNavigate();
  const { token } = useAuth();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    resultsApi.sheet(token, eventId, ageGroupId).then(setData).catch((e) => setErr(e.message));
  }, [token, eventId, ageGroupId]);

  if (err) return <div className="p-8 text-sm text-red-600">{err}</div>;
  if (!data) return <div className="p-8 text-sm text-slate-500">Loading result sheet…</div>;

  const ev = data.event || {};
  const b = data.branding || {};
  const published = data.state?.published;
  const finalised = data.state?.finalised;
  const statusLabel = published ? 'PUBLISHED' : finalised ? 'FINALISED' : data.complete ? 'PROVISIONAL' : 'DRAFT — scoring incomplete';

  return (
    <div className="mx-auto max-w-4xl bg-white p-6 text-slate-800 print:max-w-none print:p-0">
      <style>{`@media print { .no-print { display: none !important; } @page { margin: 14mm; } body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }`}</style>

      {/* Toolbar — screen only */}
      <div className="no-print mb-4 flex items-center gap-2">
        <button onClick={() => navigate('/admin/judging/results')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50">
          <ArrowLeft size={15} /> Back to Results
        </button>
        <div className="flex-1" />
        {!data.complete && <span className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700">Scoring incomplete — this will print as a draft.</span>}
        <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-navy-700">
          <Printer size={15} /> Print / Save PDF
        </button>
      </div>

      {/* Sheet */}
      <div id="result-sheet">
        <header className="flex items-center justify-between border-b-2 border-navy-700 pb-3">
          <div className="flex items-center gap-3">
            {asset(b.kca_logo_url) && <img src={asset(b.kca_logo_url)} alt="KCA" className="h-14 w-auto object-contain" />}
            <div>
              <div className="text-lg font-bold text-navy-800">{b.event_year_label || 'KCA Indian Talent Scan'}</div>
              <div className="text-xs text-slate-500">Kerala Catholic Association, Bahrain</div>
            </div>
          </div>
          {asset(b.sponsor_logo_url) && (
            <div className="text-right">
              <img src={asset(b.sponsor_logo_url)} alt={b.sponsor_name || 'Sponsor'} className="h-12 w-auto object-contain" />
              {b.sponsor_name && <div className="text-[10px] text-slate-400">{b.sponsor_name}</div>}
            </div>
          )}
        </header>

        <div className="mt-4 flex items-end justify-between">
          <div>
            <h1 className="text-xl font-bold text-navy-900">Official Result Sheet</h1>
            <p className="mt-1 text-sm text-slate-600">
              <span className="font-semibold">{ev.event_code ? `${ev.event_code} · ` : ''}{ev.event_name}</span>
              {ev.category_name ? <span className="text-slate-400"> · {ev.category_name}</span> : null}
            </p>
            <p className="text-sm text-slate-600">Age group: <span className="font-semibold">{ev.age_group_label || ev.age_group_code}</span> · {data.participant_count} participant{data.participant_count === 1 ? '' : 's'}</p>
          </div>
          <div className="text-right">
            <span className={`rounded px-2 py-1 text-xs font-bold ${published ? 'bg-green-100 text-green-700' : finalised ? 'bg-gold-100 text-gold-700' : 'bg-slate-100 text-slate-600'}`}>{statusLabel}</span>
          </div>
        </div>

        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-y border-slate-300 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="px-2 py-2">Rank</th>
              <th className="px-2 py-2">Place</th>
              <th className="px-2 py-2">Chest</th>
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">School</th>
              <th className="px-2 py-2 text-center">Grade</th>
              <th className="px-2 py-2 text-center">Rank pts</th>
              <th className="px-2 py-2 text-center">Grade pts</th>
              <th className="px-2 py-2 text-center">Part.</th>
              <th className="px-2 py-2 text-center">Total</th>
              <th className="px-2 py-2">Extra</th>
            </tr>
          </thead>
          <tbody>
            {data.results.map((r) => (
              <tr key={r.chest_number} className={`border-b border-slate-100 ${r.place ? 'bg-gold-50/40' : ''}`}>
                <td className="px-2 py-1.5 text-slate-500">{r.order}</td>
                <td className="px-2 py-1.5 font-bold text-navy-800">{r.place || '—'}</td>
                <td className="px-2 py-1.5 font-mono">{r.chest_number}</td>
                <td className="px-2 py-1.5 font-medium">{r.name || '—'}</td>
                <td className="px-2 py-1.5 text-slate-500">{r.school || '—'}</td>
                <td className="px-2 py-1.5 text-center">{r.grade || '—'}</td>
                <td className="px-2 py-1.5 text-center">{r.rank_points}</td>
                <td className="px-2 py-1.5 text-center">{r.grade_points}</td>
                <td className="px-2 py-1.5 text-center">{r.participation_bonus_pts}</td>
                <td className="px-2 py-1.5 text-center font-semibold">{r.total_points}</td>
                <td className="px-2 py-1.5 text-navy-700">{r.extra_prize_type ? EXTRA_LABEL[r.extra_prize_type] : ''}</td>
              </tr>
            ))}
            {data.results.length === 0 && (
              <tr><td colSpan={11} className="px-2 py-6 text-center text-slate-400">No attended participants in this group.</td></tr>
            )}
          </tbody>
        </table>

        {/* Signatures */}
        <div className="mt-10 grid grid-cols-2 gap-x-10 gap-y-8">
          {(data.judges || []).map((j) => (
            <div key={j.judge_id} className="border-t border-slate-400 pt-1 text-sm">
              <div className="font-medium">{j.name}</div>
              <div className="text-xs text-slate-500">Judge — signature</div>
            </div>
          ))}
          <div className="border-t border-slate-400 pt-1 text-sm">
            <div className="font-medium">&nbsp;</div>
            <div className="text-xs text-slate-500">Chairman — signature</div>
          </div>
        </div>

        <p className="mt-8 text-[10px] text-slate-400">
          Generated {new Date(data.generated_at).toLocaleString()} · Placement by sum of judges' ranks; grade by average %.
          {!data.complete && ' DRAFT — not all judges have finished scoring.'}
        </p>
      </div>
    </div>
  );
}
