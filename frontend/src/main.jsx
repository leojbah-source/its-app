import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Use the active year's ITS logo as the tab favicon AND the iOS/Android
// home-screen icon, everywhere in the app. Falls back to the bundled favicon.
async function setAppIcons() {
  try {
    const base = import.meta.env.VITE_API_BASE_URL ?? '';
    const res = await fetch(`${base}/api/register/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    if (!cfg?.its_logo_url) return;
    const set = (rel) => {
      let l = document.querySelector(`link[rel="${rel}"]`);
      if (!l) { l = document.createElement('link'); l.rel = rel; document.head.appendChild(l); }
      l.removeAttribute('type');
      l.href = cfg.its_logo_url;
    };
    set('icon');
    set('apple-touch-icon');
  } catch { /* keep the bundled favicon */ }
}
setAppIcons();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
