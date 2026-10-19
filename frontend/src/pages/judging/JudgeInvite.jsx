// src/pages/judging/JudgeInvite.jsx
// Warm, one-page invitation to a prospective judge. Enter the invitee's name,
// pick an event from the schedule — the event, date, age group and venue fill
// in automatically — then download it as a JPEG (KCA + ITS logos, ITS blurb).
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { ArrowLeft, Download, Printer, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { judgesApi, yearConfigApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const rowKey = (r) => `${r.event_id}:${r.age_group_id}:${r.event_date}`;
const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const fmt12 = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm'; let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}.${String(m).padStart(2, '0')} ${ap}`;
};

const DEFAULT_ABOUT =
  'The Indian Talent Scan (ITS) is the flagship youth cultural talent competition of the '
  + 'Kerala Catholic Association (KCA), Bahrain. Held annually, it brings together hundreds of '
  + 'young participants across dance, music, arts and literary events, offering them a professional '
  + 'stage to showcase their creativity and grow in confidence. Adjudicated by distinguished artists '
  + 'and educators, ITS celebrates excellence and nurtures the next generation of talent in our community.';

function SafeImg({ src, style, fallback = null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return fallback;
  return <img crossOrigin="anonymous" src={src} alt="" onError={() => setFailed(true)} style={style} />;
}

export default function JudgeInvite() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const ref = useRef(null);
  const [rows, setRows] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const [name, setName] = useState('');
  const [sel, setSel] = useState('');
  const [note, setNote] = useState('');
  const [about, setAbout] = useState(DEFAULT_ABOUT);

  useEffect(() => {
    judgesApi.eventAssignments(token).then(setRows).catch((e) => setErr(e.message));
    yearConfigApi.get(token).then(setCfg).catch(() => {});
  }, [token]);

  const ev = rows.find((r) => rowKey(r) === sel) || null;
  const yearLabel = cfg?.event_year_label || 'KCA Indian Talent Scan';

  const fileName = `ITS-Judge-Invitation${name ? '-' + name.replace(/\s+/g, '_') : ''}.jpg`;

  const render = useCallback(async () => {
    return html2canvas(ref.current, {
      useCORS: true, scale: 2, backgroundColor: '#ffffff',
      ignoreElements: (el) => el.classList && el.classList.contains('noshot'),
    });
  }, []);

  async function download() {
    if (!ref.current) return;
    setBusy('dl'); setErr('');
    try {
      const canvas = await render();
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/jpeg', 0.95);
      a.download = fileName; a.click();
    } catch (e) { setErr('Could not render the image: ' + e.message); }
    finally { setBusy(''); }
  }

  const NAVY = '#0f2f5f', GOLD = '#b8860b', INK = '#3a2a16';
  const detailRow = (label, value) => value ? (
    <tr>
      <td style={{ padding: '4px 10px', color: '#7a6a52', whiteSpace: 'nowrap', verticalAlign: 'top', fontSize: 15 }}>{label}</td>
      <td style={{ padding: '4px 10px', fontWeight: 700, color: NAVY, fontSize: 15 }}>{value}</td>
    </tr>
  ) : null;

  return (
    <div className="min-h-screen bg-slate-100 py-6">
      <div className="mx-auto max-w-[840px] px-4">
        {/* Controls */}
        <div className="noshot mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button onClick={() => navigate('/admin/judging/judges')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-navy-700 hover:bg-slate-50"><ArrowLeft size={16} /> Back to judges</button>
            <div className="flex-1" />
            <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md border border-navy-300 bg-white px-3 py-1.5 text-sm font-medium text-navy-700 hover:bg-navy-50"><Printer size={16} /> Print</button>
            <button onClick={download} disabled={!!busy || !name.trim() || !ev}
              className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-navy-700 disabled:opacity-60">
              {busy === 'dl' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Download JPEG
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Invitee's name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mrs. Smitha Balan"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Event (from the schedule)</label>
              <select value={sel} onChange={(e) => setSel(e.target.value)} className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
                <option value="">Select an event…</option>
                {rows.map((r) => (
                  <option key={rowKey(r)} value={rowKey(r)}>
                    {r.event_code} · {r.event_name} · {r.age_group_code}{r.event_date ? ` · ${r.event_date}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Personal line (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Your rich experience in classical music would be invaluable to our young artists."
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">About the Indian Talent Scan (editable)</label>
              <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={3}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </div>
          {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
          {(!name.trim() || !ev) && <p className="mt-2 text-xs text-slate-400">Enter the invitee's name and pick an event to enable download.</p>}
        </div>

        {/* ── Invitation (captured) ── */}
        <div ref={ref} style={{ width: 800, margin: '0 auto', background: 'linear-gradient(180deg,#fbf3e2 0%,#f6e8cf 100%)', fontFamily: 'Georgia, "Times New Roman", serif', color: INK, padding: 14 }}>
          <div style={{ border: `2px solid ${GOLD}`, padding: 2 }}>
            <div style={{ border: `1px solid ${GOLD}`, padding: '28px 40px 34px' }}>

              {/* Logos */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <SafeImg src={asset(cfg?.kca_logo_url)} fallback={<div style={{ width: 86 }} />} style={{ height: 78, objectFit: 'contain' }} />
                <SafeImg src={asset(cfg?.its_logo_url)} fallback={<div />} style={{ height: 104, objectFit: 'contain' }} />
                <SafeImg src={asset(cfg?.sponsor_logo_url)} fallback={cfg?.sponsor_name ? <div style={{ width: 86, textAlign: 'right', fontWeight: 700, color: NAVY, fontSize: 13 }}>{cfg.sponsor_name}</div> : <div style={{ width: 86 }} />} style={{ height: 66, objectFit: 'contain' }} />
              </div>

              <div style={{ textAlign: 'center', color: NAVY, fontSize: 24, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1.2 }}>{yearLabel}</div>
              <div style={{ textAlign: 'center', color: GOLD, fontSize: 17, fontStyle: 'italic', marginTop: 4 }}>Invitation to Serve as a Judge</div>
              <div style={{ height: 2, background: GOLD, opacity: 0.5, margin: '14px auto 18px', width: '70%' }} />

              <p style={{ fontSize: 17, margin: '0 0 12px' }}>Respected <b style={{ color: NAVY }}>{name || '______________'}</b>,</p>

              <p style={{ fontSize: 16, lineHeight: 1.6, margin: '0 0 14px', textAlign: 'justify' }}>
                It is our privilege to invite you to grace the <b>{yearLabel}</b> as a <b>Judge</b>
                {ev ? <> for <b style={{ color: NAVY }}>{ev.event_name}</b>{ev.age_group_label ? <> ({ev.age_group_label})</> : ev.age_group_code ? <> (Group {ev.age_group_code})</> : null}</> : null}.
                Your discerning eye and distinguished experience would greatly enrich the adjudication and inspire our young participants to give their very best.
                {note ? ` ${note}` : ''}
              </p>

              {/* Event details */}
              {ev && (
                <div style={{ border: `1px solid ${GOLD}`, background: 'rgba(255,255,255,0.55)', borderRadius: 6, padding: '12px 14px', margin: '4px 0 16px' }}>
                  <div style={{ color: GOLD, fontSize: 12, fontWeight: 700, letterSpacing: 1, marginBottom: 4, textTransform: 'uppercase' }}>Event details</div>
                  <table style={{ borderCollapse: 'collapse' }}>
                    <tbody>
                      {detailRow('Event', `${ev.event_code} — ${ev.event_name}`)}
                      {detailRow('Category', ev.category_name)}
                      {detailRow('Age group', ev.age_group_label || ev.age_group_code)}
                      {detailRow('Date', fmtDate(ev.event_date))}
                      {detailRow('Time', fmt12(ev.start_time))}
                      {detailRow('Venue', ev.venue)}
                    </tbody>
                  </table>
                </div>
              )}

              {about && (
                <p style={{ fontSize: 14.5, lineHeight: 1.55, fontStyle: 'italic', color: '#5c4a30', margin: '0 0 16px', textAlign: 'justify' }}>{about}</p>
              )}

              <p style={{ fontSize: 16, lineHeight: 1.6, margin: '0 0 18px' }}>
                We would be deeply honoured by your gracious acceptance, and we look forward to welcoming you to this celebration of young talent.
              </p>

              <p style={{ fontSize: 16, margin: '0 0 2px' }}>With warm regards,</p>
              <p style={{ fontSize: 17, fontWeight: 700, color: NAVY, margin: '0 0 1px' }}>The Organizing Committee</p>
              <p style={{ fontSize: 15, color: '#5c4a30', margin: 0 }}>{yearLabel}</p>

              <div style={{ height: 1, background: GOLD, opacity: 0.4, margin: '18px 0 10px' }} />
              <div style={{ textAlign: 'center', fontSize: 12.5, color: '#7a6a52' }}>
                The Indian Talent Scan · Kerala Catholic Association (KCA), Bahrain
                {cfg?.website_domain ? ` · ${cfg.website_domain}` : ''}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
