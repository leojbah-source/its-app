// src/pages/timer/StageDisplay.jsx
// Full-screen, controls-free stage view for a second screen / projector.
// Public + read-only: polls the running timing for an event and shows a big
// colour panel with the chest number and the running clock (green → yellow →
// red, matching the Timer's own logic). Open via ?event_id=<id>.
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { publicApi } from '../../api/client';

const clock = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.max(0, Math.round(s)) % 60).padStart(2, '0')}`);

function lightFor(sec, t) {
  const allotted = Number(t?.allotted_time_seconds) || 0;
  const yellow = Number(t?.yellow_alert_seconds) || 0;
  const grace = Number(t?.grace_period_seconds) || 0;
  if (allotted && sec >= allotted + grace) return { bg: '#7f1d1d', label: 'OVER' };
  if (allotted && sec >= allotted) return { bg: '#dc2626', label: 'TIME UP' };
  if (allotted && sec >= allotted - yellow) return { bg: '#f59e0b', label: '' };
  return { bg: '#16a34a', label: '' };
}

export default function StageDisplay() {
  const [params] = useSearchParams();
  const eventId = params.get('event_id');
  const [snap, setSnap] = useState({ running: null, timing: null, startMs: null, offset: 0, eventName: '' });
  const [, force] = useState(0);

  useEffect(() => {
    if (!eventId) return;
    let alive = true;
    async function poll() {
      try {
        const d = await publicApi.stage(eventId);
        if (!alive) return;
        if (d.running) {
          const startMs = Number(d.running.start_ms);
          const serverMs = Number(d.running.server_ms ?? d.server_ms);
          setSnap({ running: d.running, timing: d.running, startMs, offset: serverMs - Date.now(), eventName: d.running.event_name || '' });
        } else {
          setSnap((s) => ({ ...s, running: null, timing: d.event, startMs: null, eventName: d.event?.event_name || s.eventName }));
        }
      } catch { /* keep last */ }
    }
    poll();
    const iv = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(iv); };
  }, [eventId]);

  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 100);
    return () => clearInterval(t);
  }, []);

  const elapsed = snap.running && snap.startMs != null ? (Date.now() + snap.offset - snap.startMs) / 1000 : null;
  const ls = elapsed != null ? lightFor(elapsed, snap.timing) : { bg: '#0f172a', label: '' };

  return (
    <div style={{ background: ls.bg, transition: 'background 300ms' }} className="fixed inset-0 flex items-center justify-center overflow-hidden">
      {!eventId ? (
        <div className="text-2xl text-white/80">No event specified — open with ?event_id=…</div>
      ) : elapsed == null ? (
        <div className="text-center text-white">
          <div className="uppercase tracking-[0.3em] opacity-80" style={{ fontSize: '3vw' }}>{snap.eventName || 'Timer'}</div>
          <div className="mt-6 font-black opacity-90" style={{ fontSize: '7vw' }}>Ready</div>
        </div>
      ) : (
        <div className="text-center text-white">
          <div className="uppercase tracking-[0.3em] opacity-80" style={{ fontSize: '2.5vw' }}>Chest</div>
          <div className="font-mono font-black leading-none" style={{ fontSize: '20vw' }}>{snap.running.chest_number ?? '—'}</div>
          <div className="mt-2 font-mono font-black tabular-nums" style={{ fontSize: '11vw' }}>{clock(elapsed)}</div>
          {ls.label && <div className="mt-3 font-bold tracking-[0.3em]" style={{ fontSize: '3vw' }}>{ls.label}</div>}
        </div>
      )}
    </div>
  );
}
