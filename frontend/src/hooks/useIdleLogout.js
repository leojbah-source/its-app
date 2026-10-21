// src/hooks/useIdleLogout.js
// Signs the user out after `minutes` with no interaction, then runs onIdle.
// Resets on real user activity. Used across every portal so an abandoned tablet
// frees itself (and its single-session lock) instead of sitting logged in.
import { useEffect, useRef } from 'react';

export function useIdleLogout({ active, onIdle, minutes = 15 }) {
  const cb = useRef(onIdle);
  useEffect(() => { cb.current = onIdle; }, [onIdle]);
  useEffect(() => {
    if (!active) return undefined;
    let timer;
    const ms = minutes * 60000;
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => { if (cb.current) cb.current(); }, ms); };
    const evs = ['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel'];
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => { clearTimeout(timer); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [active, minutes]);
}
