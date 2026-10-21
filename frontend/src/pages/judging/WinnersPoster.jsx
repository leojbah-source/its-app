// src/pages/judging/WinnersPoster.jsx
// Winners announcement poster for a published (or finalised) event + age group.
// Renders the top-3 with photos + medals in the KCA/ITS house style; lets the
// user download the PNG, Share it (as a viewable image, e.g. to WhatsApp), or
// print it. Photos come from each winner's registered photo; a poor one can be
// replaced inline.
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { ArrowLeft, Download, Printer, Loader2, Camera, Share2, ZoomIn, ZoomOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { resultsApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return '';
  return `${String(dt.getDate()).padStart(2, '0')}-${dt.toLocaleString('en-GB', { month: 'short' })}-${dt.getFullYear()}`;
};
const MEDAL = {
  1: { ring: 'linear-gradient(145deg,#fff1a8,#f6d034 45%,#b8860b)' },
  2: { ring: 'linear-gradient(145deg,#f4f6f8,#cfd4da 45%,#8b939c)' },
  3: { ring: 'linear-gradient(145deg,#ffd9a8,#e8923a 45%,#9a5212)' },
};
const ORD = { 1: 'ST', 2: 'ND', 3: 'RD' };

// A distinct colour theme per age group so 150+ posters don't all look the
// same. Keyed by the age-group number; cycles if there are more than the list.
const THEMES = [
  { light: '#eaf6ea', mid: '#2f8a36', deep: '#13471b' }, // 1 · green
  { light: '#e9eefc', mid: '#2a53c9', deep: '#112a66' }, // 2 · royal blue
  { light: '#f3ecfb', mid: '#7a39b5', deep: '#34155c' }, // 3 · purple
  { light: '#e6f8f8', mid: '#0e9aa7', deep: '#063b43' }, // 4 · teal
  { light: '#fdecee', mid: '#c22a46', deep: '#58101f' }, // 5 · crimson
  { light: '#fff3e2', mid: '#d9821f', deep: '#6b3406' }, // 6 · amber
  { light: '#fdeaf4', mid: '#c23b84', deep: '#58103a' }, // 7 · magenta
  { light: '#edeefa', mid: '#4a4fb0', deep: '#1c2050' }, // 8 · indigo
];
const themeFor = (code) => {
  const m = String(code || '').match(/\d+/);
  const n = m ? parseInt(m[0], 10) : 1;
  return THEMES[(((n - 1) % THEMES.length) + THEMES.length) % THEMES.length];
};

// Image that falls back cleanly (and resets when the src changes, so a replaced
// photo shows immediately instead of staying hidden from a previous error).
function SafeImg({ src, style, fallback = null }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return fallback;
  return <img crossOrigin="anonymous" src={src} alt="" draggable={false} onDragStart={(e) => e.preventDefault()} onError={() => setFailed(true)} style={{ WebkitUserDrag: 'none', userSelect: 'none', ...style }} />;
}

function Medal({ place }) {
  const m = MEDAL[place] || MEDAL[3];
  return (
    <div style={{ position: 'relative', width: 72, height: 94, margin: '10px auto 0' }}>
      {/* ribbon tails hang BELOW the medallion so they never cover the number */}
      <div style={{ position: 'absolute', left: 23, top: 50, width: 13, height: 38, background: '#c0272d', transform: 'rotate(13deg)', borderRadius: '0 0 2px 2px', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
      <div style={{ position: 'absolute', right: 23, top: 50, width: 13, height: 38, background: '#9f1f26', transform: 'rotate(-13deg)', borderRadius: '0 0 2px 2px', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
      {/* medallion */}
      <div style={{ position: 'absolute', left: 4, top: 0, width: 64, height: 64, borderRadius: '50%', background: m.ring, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 3px 8px rgba(0,0,0,.35)', border: '3px solid rgba(255,255,255,.9)' }}>
        <div style={{ width: 50, height: 50, borderRadius: '50%', background: 'rgba(255,255,255,.18)', border: '1px solid rgba(255,255,255,.5)', display: 'flex', alignItems: 'baseline', justifyContent: 'center' }}>
          <span style={{ color: '#fff', fontWeight: 900, fontSize: 28, lineHeight: 1, textShadow: '0 1px 3px rgba(0,0,0,.45)' }}>{place}</span>
          <span style={{ color: '#fff', fontWeight: 800, fontSize: 12, marginLeft: 1, textShadow: '0 1px 3px rgba(0,0,0,.45)' }}>{ORD[place] || ''}</span>
        </div>
      </div>
    </div>
  );
}

const clampPct = (v) => Math.max(0, Math.min(100, v));
const clampZoom = (v) => Math.max(1, Math.min(3, Math.round(v * 100) / 100));

function WinnerCard({ w, big, onReplace, busyId }) {
  const fileRef = useRef(null);
  const drag = useRef(null);
  const [pos, setPos] = useState({ x: 50, y: 28 }); // bias upward so faces show
  const [zoom, setZoom] = useState(1);
  const frameW = big ? 220 : 180;
  const frameH = big ? 270 : 220;
  const silhouette = (
    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 64 }}>👤</div>
  );
  function onDown(e) { if (!w.photo_url) return; e.preventDefault(); drag.current = { x: e.clientX, y: e.clientY }; try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
  function onMove(e) {
    if (!drag.current) return;
    const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    setPos((p) => ({ x: clampPct(p.x - (dx / frameW) * 100), y: clampPct(p.y - (dy / frameH) * 100) }));
  }
  function onUp() { drag.current = null; }
  function onWheel(e) { if (!w.photo_url) return; e.preventDefault(); setZoom((z) => clampZoom(z - e.deltaY * 0.0015)); }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: frameW, marginBottom: big ? 36 : 0 }}>
      <div onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onWheel={onWheel}
        style={{ width: frameW, height: frameH, borderRadius: '16px', overflow: 'hidden', background: '#e2e8f0', border: '3px solid rgba(255,255,255,.7)', boxShadow: '0 4px 14px rgba(0,0,0,.35)', cursor: w.photo_url ? 'move' : 'default', touchAction: 'none' }}>
        <SafeImg src={asset(w.photo_url)} fallback={silhouette} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${pos.x}% ${pos.y}%`, transform: `scale(${zoom})`, transformOrigin: `${pos.x}% ${pos.y}%` }} />
      </div>
      <div style={{ color: '#fde047', fontWeight: 800, fontSize: big ? 24 : 20, textAlign: 'center', lineHeight: 1.1, marginTop: 10, textShadow: '0 1px 2px rgba(0,0,0,.4)' }}>{w.name || `Chest ${w.chest_number}`}</div>
      {w.grade && <div style={{ marginTop: 5, fontSize: 12, fontWeight: 800, color: '#1b2a4a', background: 'rgba(253,224,71,.95)', borderRadius: 999, padding: '2px 12px', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }}>Grade {w.grade}</div>}
      <Medal place={w.place} />
      {onReplace && (
        <div className="noshot" style={{ marginTop: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
          {w.photo_url && <div style={{ fontSize: 10, color: 'rgba(255,255,255,.85)' }}>Drag to position · scroll or +/− to zoom</div>}
          <div style={{ display: 'flex', gap: 6 }}>
            {w.photo_url && (
              <>
                <button onClick={() => setZoom((z) => clampZoom(z - 0.25))} title="Zoom out" className="inline-flex items-center rounded-md bg-white/85 px-2 py-1 text-navy-700 hover:bg-white"><ZoomOut size={12} /></button>
                <button onClick={() => setZoom((z) => clampZoom(z + 0.25))} title="Zoom in" className="inline-flex items-center rounded-md bg-white/85 px-2 py-1 text-navy-700 hover:bg-white"><ZoomIn size={12} /></button>
              </>
            )}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onReplace(w, f); e.target.value = ''; }} />
            <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 rounded-md bg-white/85 px-2 py-1 text-[11px] font-medium text-navy-700 hover:bg-white">
              {busyId === w.participant_id ? <Loader2 size={12} className="animate-spin" /> : <Camera size={12} />} Replace
            </button>
            {w.photo_url && <button onClick={() => { setPos({ x: 50, y: 28 }); setZoom(1); }} className="rounded-md bg-white/85 px-2 py-1 text-[11px] font-medium text-navy-700 hover:bg-white">Reset</button>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function WinnersPoster() {
  const { token, user } = useAuth();
  const { eventId, groupId } = useParams();
  const navigate = useNavigate();
  const posterRef = useRef(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busyAct, setBusyAct] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try { setData(await resultsApi.winners(token, eventId, groupId)); }
    catch (e) { setError(e.message); }
  }, [token, eventId, groupId]);
  useEffect(() => { load(); }, [load]);

  function goBack() {
    // Opened in its own tab from the Results page — just close it so the Results
    // page (with its selection) is still there underneath. Fallback: navigate.
    if (window.opener && !window.opener.closed) { window.close(); return; }
    navigate(user?.role === 'Media' ? '/admin/media' : '/admin/judging/results');
  }

  async function replacePhoto(w, file) {
    if (!w.participant_id) return;
    setBusyId(w.participant_id);
    try { await resultsApi.winnerPhoto(token, w.participant_id, file); await load(); }
    catch (e) { setError(e.message); }
    finally { setBusyId(null); }
  }

  const fileName = `ITS_${data?.event?.event_code || 'event'}_${data?.event?.age_group_code || ''}_winners.png`.replace(/\s+/g, '');
  const shareText = [data?.event?.event_name, data?.event?.age_group_label].filter(Boolean).join(' · ') + ' — Winners';

  async function renderCanvas() {
    return html2canvas(posterRef.current, {
      useCORS: true, scale: 2, backgroundColor: null,
      ignoreElements: (el) => el.classList && el.classList.contains('noshot'),
    });
  }

  async function downloadPng() {
    if (!posterRef.current) return;
    setBusyAct('dl'); setError(''); setNote('');
    try {
      const canvas = await renderCanvas();
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = fileName;
      a.click();
    } catch (e) { setError('Could not render the image: ' + e.message); }
    finally { setBusyAct(''); }
  }

  async function shareImage() {
    if (!posterRef.current) return;
    setBusyAct('share'); setError(''); setNote('');
    try {
      const canvas = await renderCanvas();
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const file = new File([blob], fileName, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text: shareText });
      } else {
        // Browser can't share a file (e.g. desktop): download it so the user can
        // attach it manually. On a phone the share sheet lets them pick WhatsApp.
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        a.click();
        setNote('Sharing images isn’t supported on this browser, so the image was downloaded instead. On a phone, tap Share to send it straight to WhatsApp as a photo.');
      }
    } catch (e) {
      if (e && e.name !== 'AbortError') setError('Could not share: ' + e.message);
    } finally { setBusyAct(''); }
  }

  if (error && !data) return (
    <div className="mx-auto max-w-2xl p-6">
      <button onClick={goBack} className="mb-3 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ArrowLeft size={16} /> Back to results</button>
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
    </div>
  );
  if (!data) return <div className="p-10 text-center text-sm text-slate-500">Loading…</div>;

  const b = data.branding || {};
  const ev = data.event || {};
  const winners = data.winners || [];
  const byPlace = (p) => winners.find((w) => w.place === p);
  const first = byPlace(1), second = byPlace(2);
  // There is normally one 3rd place, but a rare Additional 3rd is a full
  // 3rd place too (same place, points and prize) — render every place-3 winner.
  const thirds = winners.filter((w) => w.place === 3);
  const title = (b.event_year_label || 'KCA Indian Talent Scan').toUpperCase();
  const eventLine = [ev.event_name, ev.age_group_label || (ev.age_group_code ? `Group ${ev.age_group_code}` : '')].filter(Boolean).join(' · ');

  const th = themeFor(ev.age_group_code || ev.age_group_label);

  return (
    <div className="min-h-screen bg-slate-100 py-6">
      <div className="mx-auto max-w-[860px] px-4">
        <div className="noshot mb-4 flex flex-wrap items-center gap-2">
          <button onClick={goBack} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-navy-700 hover:bg-slate-50"><ArrowLeft size={16} /> Back to results</button>
          <div className="flex-1" />
          {!data.state?.published && <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-700">Not yet published — preview</span>}
          <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md border border-navy-300 bg-white px-3 py-1.5 text-sm font-medium text-navy-700 hover:bg-navy-50"><Printer size={16} /> Print</button>
          <button onClick={shareImage} disabled={!!busyAct} className="inline-flex items-center gap-1 rounded-md bg-green-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-60">
            {busyAct === 'share' ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />} Share
          </button>
          <button onClick={downloadPng} disabled={!!busyAct} className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-navy-700 disabled:opacity-60">
            {busyAct === 'dl' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Download image
          </button>
        </div>
        {note && <div className="noshot mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">{note}</div>}
        {error && <div className="noshot mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>}

        {/* ── Poster (captured) ── */}
        <div ref={posterRef} style={{ width: 820, boxSizing: 'border-box', margin: '0 auto', background: `linear-gradient(180deg,#ffffff 0%, ${th.light} 14%, ${th.mid} 50%, ${th.deep} 100%)`, fontFamily: 'Arial, Helvetica, sans-serif', paddingBottom: 40, border: '5px solid #d4af37' }}>
          <div style={{ background: `linear-gradient(180deg,#ffffff, ${th.light})`, padding: '18px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `4px solid ${th.deep}` }}>
            <SafeImg src={asset(b.kca_logo_url)} fallback={<div style={{ width: 90 }} />} style={{ height: 66, objectFit: 'contain' }} />
            <SafeImg src={asset(b.its_logo_url)} fallback={<div />} style={{ height: 92, objectFit: 'contain' }} />
            <SafeImg src={asset(b.sponsor_logo_url)} fallback={b.sponsor_name ? <div style={{ fontWeight: 700, color: '#0f2f5f' }}>{b.sponsor_name}</div> : <div style={{ width: 90 }} />} style={{ height: 56, objectFit: 'contain' }} />
          </div>

          <div style={{ padding: '22px 34px 0' }}>
            <div style={{ color: '#1e2a78', fontWeight: 800, fontSize: 32, lineHeight: 1.1 }}>{title}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
              <div style={{ color: '#1e2a78', fontWeight: 800, fontSize: 26 }}>Results</div>
              <div style={{ color: '#0f2f5f', fontWeight: 700, fontSize: 22 }}>{fmtDate(ev.event_date)}</div>
            </div>
            <div style={{ textAlign: 'center', marginTop: 14 }}>
              <span style={{ display: 'inline-block', color: '#fde047', fontWeight: 800, fontSize: 24, padding: '6px 22px', borderRadius: 999, background: 'rgba(0,0,0,.22)', boxShadow: '0 2px 6px rgba(0,0,0,.25)', textShadow: '0 1px 2px rgba(0,0,0,.5)' }}>{eventLine}</span>
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'center', gap: 28, padding: '34px 24px 10px' }}>
            {second && <WinnerCard w={second} onReplace={replacePhoto} busyId={busyId} />}
            {first && <WinnerCard w={first} big onReplace={replacePhoto} busyId={busyId} />}
            {thirds.map((w, i) => <WinnerCard key={w.participant_id || w.chest_number || `t${i}`} w={w} onReplace={replacePhoto} busyId={busyId} />)}
          </div>

          <div style={{ color: '#ffffff', fontWeight: 800, fontSize: 40, letterSpacing: 1, textAlign: 'center', marginTop: 18, textShadow: '0 2px 4px rgba(0,0,0,.4)' }}>CONGRATULATIONS</div>
        </div>
      </div>
    </div>
  );
}
