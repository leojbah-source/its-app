// src/pages/judging/JudgeInvite.jsx
// Warm, one-page invitation to a prospective judge. Enter the invitee's name,
// tick one or more sessions from the schedule — a judge may cover the same
// event across several age groups, or more than one event — and the details
// fill in automatically. Download it as a one-page JPEG (KCA + ITS logos).
import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import html2canvas from 'html2canvas';
import { ArrowLeft, Download, Printer, Loader2 } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { judgesApi, yearConfigApi, API_BASE } from '../../api/client';

const VENUE_SUFFIX = 'KCA, Segayya';
const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const rowKey = (r) => `${r.event_id}:${r.age_group_id}:${r.event_date}`;
const venueFull = (v) => (v ? `${v}, ${VENUE_SUFFIX}` : VENUE_SUFFIX);
const uniq = (a) => a.filter((x, i) => x && a.indexOf(x) === i);
const joinAnd = (a) => (a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} & ${a[a.length - 1]}`);
// Just the number of an age group ("Group 3" -> "3") for the compact "Age groups 3, 4 & 5" phrasing.
const groupNum = (r) => {
  const m = String(r.age_group_label || r.age_group_code || '').match(/\d+/);
  return m ? m[0] : (r.age_group_label || r.age_group_code || '');
};
const groupsPhrase = (sessions) => {
  const nums = uniq(sessions.map(groupNum));
  return nums.length > 1 ? `Age groups ${joinAnd(nums)}` : `Group ${nums[0] || ''}`.trim();
};
const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};
const fmtDateShort = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt)) return String(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmt12 = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  const ap = h < 12 ? 'am' : 'pm'; let hh = h % 12; if (hh === 0) hh = 12;
  return `${hh}.${String(m).padStart(2, '0')} ${ap}`;
};

const DEFAULT_ABOUT =
  'Now in its 26th year, the Indian Talent Scan (ITS) is the flagship youth cultural talent '
  + 'competition of the Kerala Catholic Association (KCA), Bahrain. Held annually, it brings together '
  + 'hundreds of young participants across dance, music, arts and literary events, offering them a '
  + 'professional stage to showcase their creativity and grow in confidence. Adjudicated by distinguished '
  + 'artists and educators, ITS celebrates excellence and nurtures the next generation of talent in our community.';

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
  const [keys, setKeys] = useState([]);           // selected rowKeys (one or more sessions)
  const [note, setNote] = useState('');
  const [about, setAbout] = useState(DEFAULT_ABOUT);

  useEffect(() => {
    judgesApi.eventAssignments(token).then(setRows).catch((e) => setErr(e.message));
    yearConfigApi.get(token).then(setCfg).catch(() => {});
  }, [token]);

  const yearLabel = cfg?.event_year_label || 'KCA Indian Talent Scan';

  // Selected sessions, grouped by event (schedule order); within each event,
  // sessions sharing the same date+time+venue collapse into one slot.
  const groups = [];
  const idx = {};
  for (const r of rows) {
    if (!keys.includes(rowKey(r))) continue;
    if (idx[r.event_id] == null) { idx[r.event_id] = groups.length; groups.push({ event: r, sessions: [], slots: [], sidx: {} }); }
    const g = groups[idx[r.event_id]];
    g.sessions.push(r);
    const sk = `${r.event_date}|${r.start_time}|${r.venue}`;
    if (g.sidx[sk] == null) { g.sidx[sk] = g.slots.length; g.slots.push({ ref: r, members: [] }); }
    g.slots[g.sidx[sk]].members.push(r);
  }
  const hasSel = groups.length > 0;

  // "Speech – Malayalam (Age groups 3, 4 & 5)" and "Classical Dance (Group 1)" joined with &.
  const eventsPhrase = joinAnd(groups.map((g) => `${g.event.event_name} (${groupsPhrase(g.sessions)})`));

  const toggle = (k) => setKeys((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

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

  return (
    <div className="min-h-screen bg-slate-100 py-6">
      <div className="mx-auto max-w-[840px] px-4">
        {/* Controls */}
        <div className="noshot mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button onClick={() => navigate('/admin/judging/judges')} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-navy-700 hover:bg-slate-50"><ArrowLeft size={16} /> Back to judges</button>
            <div className="flex-1" />
            <button onClick={() => window.print()} className="inline-flex items-center gap-1 rounded-md border border-navy-300 bg-white px-3 py-1.5 text-sm font-medium text-navy-700 hover:bg-navy-50"><Printer size={16} /> Print</button>
            <button onClick={download} disabled={!!busy || !name.trim() || !hasSel}
              className="inline-flex items-center gap-1 rounded-md bg-navy-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-navy-700 disabled:opacity-60">
              {busy === 'dl' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Download JPEG
            </button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Invitee's name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mrs. Pretty Roy"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Sessions to judge — tick one or more</label>
              <div className="max-h-56 overflow-y-auto rounded-md border border-slate-300 p-1">
                {rows.length === 0 && <div className="px-2 py-2 text-xs text-slate-400">No scheduled sessions yet.</div>}
                {rows.map((r) => {
                  const k = rowKey(r);
                  return (
                    <label key={k} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
                      <input type="checkbox" checked={keys.includes(k)} onChange={() => toggle(k)} className="mt-0.5" />
                      <span>{r.event_code} · {r.event_name} · Gr {groupNum(r)}{r.event_date ? ` · ${fmtDateShort(r.event_date)}` : ''}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">Personal line (optional)</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Your experience in classical music would be invaluable to our young artists."
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">About the Indian Talent Scan (editable)</label>
              <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={3}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </div>
          </div>
          {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
          {(!name.trim() || !hasSel) && <p className="mt-2 text-xs text-slate-400">Enter the invitee's name and tick at least one session to enable download.</p>}
        </div>

        {/* ── Invitation (captured) ── */}
        <div ref={ref} style={{ width: 800, margin: '0 auto', background: 'linear-gradient(180deg,#fbf3e2 0%,#f6e8cf 100%)', fontFamily: 'Georgia, "Times New Roman", serif', color: INK, padding: 14 }}>
          <div style={{ border: `2px solid ${GOLD}`, padding: 2 }}>
            <div style={{ border: `1px solid ${GOLD}`, padding: '26px 40px 34px' }}>

              {/* Logos — on a white band so the logos' white backgrounds blend in */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, background: '#ffffff', border: '1px solid #ece2cb', borderRadius: 10, padding: '14px 22px', marginBottom: 18 }}>
                <SafeImg src={asset(cfg?.kca_logo_url)} fallback={<div style={{ width: 86 }} />} style={{ height: 76, objectFit: 'contain' }} />
                <SafeImg src={asset(cfg?.its_logo_url)} fallback={<div />} style={{ height: 96, objectFit: 'contain' }} />
                <SafeImg src={asset(cfg?.sponsor_logo_url)} fallback={cfg?.sponsor_name ? <div style={{ width: 86, textAlign: 'right', fontWeight: 700, color: NAVY, fontSize: 13 }}>{cfg.sponsor_name}</div> : <div style={{ width: 86 }} />} style={{ height: 62, objectFit: 'contain' }} />
              </div>

              <div style={{ textAlign: 'center', color: NAVY, fontSize: 24, fontWeight: 700, letterSpacing: 0.5, lineHeight: 1.2 }}>{yearLabel}</div>
              <div style={{ textAlign: 'center', color: GOLD, fontSize: 17, fontStyle: 'italic', marginTop: 4 }}>Invitation to Serve as a Judge</div>
              <div style={{ height: 2, background: GOLD, opacity: 0.5, margin: '14px auto 18px', width: '70%' }} />

              <p style={{ fontSize: 17, margin: '0 0 12px' }}>Respected <b style={{ color: NAVY }}>{name || '______________'}</b>,</p>

              <p style={{ fontSize: 16, lineHeight: 1.6, margin: '0 0 14px', textAlign: 'justify' }}>
                It is our privilege to invite you to grace the <b>{yearLabel}</b> as a <b>Judge</b>
                {hasSel ? <> for <b style={{ color: NAVY }}>{eventsPhrase}</b></> : null}.
                We would be grateful for your time and guidance, which would mean a great deal to our young participants.
                {note ? ` ${note}` : ''}
              </p>

              {/* Event details */}
              {hasSel && (
                <div style={{ border: `1px solid ${GOLD}`, background: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: '12px 16px', margin: '4px 0 16px' }}>
                  <div style={{ color: GOLD, fontSize: 12, fontWeight: 700, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Event details</div>
                  {groups.map((g, gi) => (
                    <div key={g.event.event_id} style={{ marginTop: gi ? 14 : 0 }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: NAVY }}>{g.event.event_name}</div>
                      {g.event.category_name && <div style={{ fontSize: 13.5, color: '#7a6a52', marginBottom: 6 }}>{g.event.category_name}</div>}
                      {g.slots.map((slot) => (
                        <div key={`${slot.ref.event_date}|${slot.ref.start_time}|${slot.ref.venue}`} style={{ marginBottom: 6 }}>
                          <div style={{ fontSize: 15.5, color: INK }}>
                            <b style={{ color: NAVY }}>{groupsPhrase(slot.members)}</b>
                            {slot.ref.event_date ? <>  ·  {fmtDate(slot.ref.event_date)}</> : null}
                            {slot.ref.start_time ? <>  ·  {fmt12(slot.ref.start_time)}</> : null}
                          </div>
                          <div style={{ fontSize: 14, color: '#5c4a30' }}>{venueFull(slot.ref.venue)}</div>
                        </div>
                      ))}
                    </div>
                  ))}
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
