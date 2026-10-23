// src/pages/pwa/LivePage.jsx
// Public, standalone LIVE PROGRESS page for parents & participants (chest-only).
// Reachable from the public board, the parent portal and the participant portal.
import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Radio } from 'lucide-react';
import rpLogo from '../../assets/research-point-logo.png';
import { publicApi, API_BASE } from '../../api/client';
import LiveBoardInner from '../../components/LiveBoardInner';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);

export default function LivePage() {
  const [year, setYear] = useState(null);
  const navigate = useNavigate();
  useEffect(() => { publicApi.year().then(setYear).catch(() => {}); }, []);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-y-2 px-4 py-3">
          <div className="flex items-center gap-3">
            {asset(year?.its_logo_url) && <img src={asset(year.its_logo_url)} alt="ITS" className="h-11 w-auto object-contain" />}
            {asset(year?.kca_logo_url) && <img src={asset(year.kca_logo_url)} alt="KCA" className="h-9 w-auto object-contain" />}
            <div>
              <div className="text-base font-bold text-navy-800 leading-tight">{year?.event_year_label || 'KCA Indian Talent Scan'}</div>
              <div className="flex items-center gap-1 text-[11px] font-semibold text-amber-600"><Radio size={12} /> Live progress</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {asset(year?.sponsor_logo_url) && (
              <img src={asset(year.sponsor_logo_url)} alt={year?.sponsor_name || 'Title sponsor'} className="h-8 w-auto max-w-[96px] object-contain" />
            )}
            <span className="flex items-center rounded bg-white p-px ring-1 ring-slate-200">
              <img src={rpLogo} alt="Research Point WLL" className="h-6 w-auto object-contain" />
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-4">
        <button onClick={() => navigate(-1)} className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-navy-600 hover:text-navy-700">
          <ArrowLeft size={15} /> Back
        </button>
        <h1 className="mb-1 text-lg font-bold text-navy-800">Live event progress</h1>
        <p className="mb-3 text-sm text-slate-500">
          See where each group has reached on the stage right now, by chest number. <Link to="/pwa" className="font-medium text-navy-600 underline">Results &amp; schedule →</Link>
        </p>
        <LiveBoardInner />
      </main>
    </div>
  );
}
