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
  1: { ring: 'linear-gradient(145deg,#fde047,#ca8a04)', label: '1' },
  2: { ring: 'linear-gradient(145deg,#e5e7eb,#9ca3af)', label: '2' },
  3: { ring: 'linear-gradient(145deg,#fdba74,#b45309)', label: '3' },
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
    <div style={{ position: 'relative', width: 54, height: 54, margin: '6px auto 0' }}>
      <div style={{ position: 'absolute', left: 12, top: 30, width: 12, height: 26, background: '#b91c1c', transform: 'rotate(18deg)' }} />
      <div style={{ position: 'absolute', right: 12, top: 30, width: 12, height: 26, background: '#b91c1c', transform: 'rotate(-18deg)' }} />
      <div style={{ width: 54, height: 54, borderRadius: '50%', background: m.ring, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 6px rgba(0,0,0,.3)', border: '3px solid rgba(255,255,255,.65)' }}>
        <span style={{ color: '#fff', fontWeight: 800, fontSize: 24, textShadow: '0 1px 2px rgba(0,0,0,.35)' }}>{m.label}</span>
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
  const first = byPlace(1), second = byPlace(2), third = byPlace(3);
  const title = (b.event_year_label || 'KCA Indian Talent Scan').toUpperCase();
  const eventLine = [ev.event_name, ev.age_group_label || (ev.age_group_code ? `Group ${ev.age_group_code}` : '')].filter(Boolean).join(' · ');

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
        <div ref={posterRef} style={{ width: 820, margin: '0 auto', background: 'linear-gradient(180deg,#eef7ee 0%,#bfe0bf 16%,#2f7d32 48%,#15481a 100%)', fontFamily: 'Arial, Helvetica, sans-serif', paddingBottom: 40 }}>
          <div style={{ background: 'linear-gradient(180deg,#ffffff,#eef7ee)', padding: '18px 26px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '3px solid #0f2f5f' }}>
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
            <div style={{ color: '#fde047', fontWeight: 800, fontSize: 24, textAlign: 'center', marginTop: 10, textShadow: '0 1px 2px rgba(0,0,0,.35)' }}>{eventLine}</div>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center', gap: 28, padding: '34px 24px 10px' }}>
            {second && <WinnerCard w={second} onReplace={replacePhoto} busyId={busyId} />}
            {first && <WinnerCard w={first} big onReplace={replacePhoto} busyId={busyId} />}
            {third && <WinnerCard w={third} onReplace={replacePhoto} busyId={busyId} />}
          </div>

          <div style={{ color: '#ffffff', fontWeight: 800, fontSize: 40, letterSpacing: 1, textAlign: 'center', marginTop: 18, textShadow: '0 2px 4px rgba(0,0,0,.4)' }}>CONGRATULATIONS</div>
        </div>
      </div>
    </div>
  );
}
