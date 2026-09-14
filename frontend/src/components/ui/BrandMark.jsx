// src/components/ui/BrandMark.jsx
// Shared brand tile: shows the uploaded ITS logo on a white background, and
// falls back to a supplied icon (on a coloured tile) when no logo is set yet.
// The logo URL is loaded once from the public /year endpoint and cached at the
// module level, so every header on every page shows the same mark without
// each one making its own request.
import { useEffect, useState } from 'react';
import { publicApi, API_BASE } from '../../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);

let cachedLogo; // undefined = not fetched yet, string = url, null = none
const waiters = new Set();

function ensureLoaded() {
  if (cachedLogo !== undefined) return;
  cachedLogo = null; // mark in-flight so we only fetch once
  publicApi.year()
    .then((y) => { cachedLogo = asset(y?.its_logo_url) || null; })
    .catch(() => { cachedLogo = null; })
    .finally(() => { waiters.forEach((fn) => fn(cachedLogo)); waiters.clear(); });
}

export default function BrandMark({
  className = 'h-8 w-8 rounded-lg',
  imgClassName = 'p-0.5',
  fallback: Fallback,
  fallbackSize = 16,
  fallbackBg = 'bg-gold-500',
  fallbackColor = 'text-white',
}) {
  const [logo, setLogo] = useState(typeof cachedLogo === 'string' ? cachedLogo : null);

  useEffect(() => {
    if (typeof cachedLogo === 'string' || cachedLogo === null) {
      // Already resolved (or resolving to none) — but if still in-flight, wait.
      if (cachedLogo) { setLogo(cachedLogo); return undefined; }
    }
    let alive = true;
    const cb = (u) => { if (alive) setLogo(u); };
    waiters.add(cb);
    ensureLoaded();
    return () => { alive = false; waiters.delete(cb); };
  }, []);

  return (
    <div className={`flex items-center justify-center overflow-hidden ${logo ? 'bg-white' : fallbackBg} ${className}`}>
      {logo
        ? <img src={logo} alt="ITS" className={`h-full w-full object-contain ${imgClassName}`} />
        : (Fallback ? <Fallback size={fallbackSize} className={fallbackColor} /> : null)}
    </div>
  );
}
