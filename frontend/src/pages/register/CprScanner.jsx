// src/pages/register/CprScanner.jsx
// Camera capture + in-browser OCR (tesseract.js) for Bahrain CPR cards.
// Flow: parent photographs the card → OCR extracts CPR number / DOB / name
// candidates → fields are pre-filled (or verified against typed values) →
// the captured photo is uploaded and used as the participant's CPR scan.
// OCR is best-effort: the parent always reviews, and the server re-validates
// the CPR-vs-DOB prefix on submit.

import { useState } from 'react';
import { Camera, CheckCircle2, AlertTriangle } from 'lucide-react';
import { API_BASE } from './registerApi';

/** Pulls CPR / DOB / name candidates out of raw OCR text. */
export function parseCprText(raw) {
  const text = (raw || '').replace(/[|]/g, ' ');
  const out = {};

  // CPR: standalone 9- (or 8-) digit number; prefer one whose YYMM prefix is plausible
  const nums = [...text.matchAll(/\b(\d{8,9})\b/g)].map((m) => m[1]);
  const plausible = nums.find((n) => {
    const full = n.length === 8 ? '0' + n : n;
    const mm = Number(full.slice(2, 4));
    return mm >= 1 && mm <= 12;
  });
  if (plausible || nums[0]) out.cpr_number = plausible || nums[0];

  // DOB: dd/mm/yyyy or dd-mm-yyyy or yyyy-mm-dd
  let m = text.match(/\b(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})\b/);
  if (m) {
    const [, d, mo, y] = m;
    if (Number(mo) >= 1 && Number(mo) <= 12) out.dob = `${y}-${mo}-${d}`;
  } else {
    m = text.match(/\b(\d{4})[\/\-.](\d{2})[\/\-.](\d{2})\b/);
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) out.dob = `${m[1]}-${m[2]}-${m[3]}`;
  }

  // Name: the line after a "Name" label, or the longest latin-letters line
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const nameIdx = lines.findIndex((l) => /^name\b/i.test(l));
  let name = null;
  if (nameIdx !== -1) {
    const inline = lines[nameIdx].replace(/^name[:\s]*/i, '').trim();
    name = inline.length >= 3 ? inline : (lines[nameIdx + 1] || '').trim();
  }
  if (!name) {
    const candidates = lines.filter((l) =>
      /^[A-Z][A-Za-z .'-]{5,}$/.test(l) && !/kingdom|bahrain|identity|card|number|birth/i.test(l));
    name = candidates.sort((a, b) => b.length - a.length)[0] || null;
  }
  if (name) out.full_name = name.replace(/\s{2,}/g, ' ');

  return out;
}

export default function CprScanner({ token, onResult }) {
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');   // progress label
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleCapture(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(true); setError(''); setDone(false);

    try {
      // 1. Upload the photo (becomes the participant's CPR scan on record)
      setStage('Uploading photo…');
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/api/register/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const up = await res.json();
      if (!res.ok) throw new Error(up.error || 'Upload failed');

      // 2. OCR in the browser (tesseract.js, lazy-loaded)
      setStage('Reading the card… (first scan downloads the reader, ~10s)');
      const { default: Tesseract } = await import('tesseract.js');
      const { data } = await Tesseract.recognize(file, 'eng', {
        logger: (m) => {
          if (m.status === 'recognizing text')
            setStage(`Reading the card… ${Math.round((m.progress || 0) * 100)}%`);
        },
      });

      const fields = parseCprText(data.text);
      setDone(true);
      onResult({ ...fields, cpr_scan_url: up.url, raw_text: data.text });
    } catch (err) {
      setError(err.message || 'Could not read the card — you can still type the details and the photo upload below.');
    } finally {
      setBusy(false); setStage('');
    }
  }

  return (
    <div className="rounded-xl border border-navy-200 bg-navy-50 p-3 space-y-2">
      <label className={`flex items-center justify-center gap-2 rounded-lg py-3 text-sm font-semibold cursor-pointer transition-colors ${
        busy ? 'bg-navy-200 text-navy-500' : 'bg-navy-700 text-white hover:bg-navy-800'}`}>
        <Camera size={16} />
        {busy ? (stage || 'Working…') : done ? 'Scan again' : 'Scan CPR card with camera'}
        <input type="file" accept="image/*" capture="environment" className="hidden"
               disabled={busy} onChange={handleCapture} />
      </label>
      {done && !error && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700">
          <CheckCircle2 size={13} />
          Card scanned — details filled below. Please check them against the card before saving.
        </p>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
      <p className="text-[11px] text-navy-400">
        Take the photo in good light with the card filling the frame. The photo is saved as
        the official CPR scan.
      </p>
    </div>
  );
}
