// src/pages/register/CprScanner.jsx
// Two-sided camera capture + in-browser OCR (tesseract.js) for Bahrain CPR
// cards. The FRONT carries the Personal Number and name; the BACK carries the
// date of birth, gender and — crucially — the machine-readable zone (MRZ,
// three lines of fixed-width text ending in <<<), which encodes CPR number,
// DOB, gender and name far more reliably than the printed layout. Layouts
// vary between old and new cards, so the parser prefers the MRZ when present
// and falls back to labelled/heuristic text.
// OCR is best-effort: the parent always reviews, and the server re-validates
// the CPR-vs-DOB prefix on submit.

import { useState } from 'react';
import { Camera, CheckCircle2, AlertTriangle } from 'lucide-react';
import { API_BASE } from './registerApi';

// The OCR engine is loaded from a CDN at runtime (not an npm dependency):
// scanning already requires internet for the language data, and this keeps
// the app running even when node_modules hasn't been refreshed.
// /* @vite-ignore */ stops Vite from trying to resolve the URL at build time.
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js';
let tesseractPromise = null;
function loadTesseract() {
  if (!tesseractPromise) {
    tesseractPromise = import(/* @vite-ignore */ TESSERACT_CDN)
      .then((m) => m.default ?? m)
      .catch((e) => { tesseractPromise = null; throw e; });
  }
  return tesseractPromise;
}

/** Runs OCR on an image file, working across tesseract.js API variants. */
async function ocrImage(file, onProgress) {
  const T = await loadTesseract();
  const logger = (m) => {
    if (m.status === 'recognizing text') onProgress(Math.round((m.progress || 0) * 100));
  };
  if (typeof T.recognize === 'function') {
    const { data } = await T.recognize(file, 'eng', { logger });
    return data.text;
  }
  // createWorker API fallback
  const worker = await T.createWorker('eng', 1, { logger });
  try {
    const { data } = await worker.recognize(file);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

/** MRZ (TD1) parser. Bahrain CPR back has:
 *    IDBHR010308296<<<<<<<<<<<<<<<6
 *    0103277M1509234IND<<<<<<<<<<<6
 *    LEO<<KEVIN<<<<<<<<<<<<<<<<<<<<
 *  Line 2 starts with DOB as YYMMDD + check digit, then sex (M/F). */
export function parseMrz(raw) {
  const out = {};
  // Normalise: OCR often reads '<' as 'K', '«', 'ç' or drops spacing.
  const lines = (raw || '')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, '').replace(/[«]/g, '<').toUpperCase())
    .filter((l) => l.length >= 10 && ((l.match(/</g) || []).length >= 3 || /^ID[A-Z]{3}/.test(l)));
  if (!lines.length) return out;

  for (const l of lines) {
    // Line 1: IDBHR + 9-digit personal number
    let m = l.match(/^ID[A-Z]{3}(\d{8,9})/);
    if (m) out.cpr_number = m[1].length === 8 ? '0' + m[1] : m[1];

    // Line 2: YYMMDD + check + sex + YYMMDD expiry + nationality
    m = l.match(/^(\d{2})(\d{2})(\d{2})\d([MF])\d{6,7}[A-Z]{3}/);
    if (m) {
      const [, yy, mm, dd, sex] = m;
      if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31) {
        const nowYY = new Date().getFullYear() % 100;
        const century = Number(yy) <= nowYY ? 2000 : 1900;
        out.dob = `${century + Number(yy)}-${mm}-${dd}`;
        out.gender = sex;
      }
    }

    // Line 3: SURNAME<<GIVEN<NAMES<<<<
    if (!/\d/.test(l) && l.includes('<<')) {
      const [surname, given] = l.split('<<');
      const clean = (x) => (x || '').replace(/</g, ' ').trim();
      const name = `${clean(given)} ${clean(surname)}`.trim();
      if (name.length >= 3 && /^[A-Z ]+$/.test(name)) out.full_name = name;
    }
  }
  return out;
}

/** Pulls CPR / DOB / name / gender candidates out of raw OCR text.
 *  Prefers the MRZ; falls back to labelled text ('Personal Number',
 *  'Date of Birth') and layout heuristics. Card layouts vary by issue year. */
export function parseCprText(raw) {
  const mrz = parseMrz(raw);
  const text = (raw || '').replace(/[|]/g, ' ');
  const out = { ...mrz };

  // CPR fallback: prefer digits near 'Personal Number' / 'PN' label, then any
  // 8-9 digit run with a plausible YYMM prefix.
  if (!out.cpr_number) {
    let m = text.match(/(?:personal\s*number|PN)\s*[:\/]?\s*[^\d]{0,20}(\d{8,9})/i);
    if (!m) {
      const nums = [...text.matchAll(/\b(\d{8,9})\b/g)].map((x) => x[1]);
      const plausible = nums.find((n) => {
        const full = n.length === 8 ? '0' + n : n;
        const mm = Number(full.slice(2, 4));
        return mm >= 1 && mm <= 12;
      });
      if (plausible || nums[0]) out.cpr_number = plausible || nums[0];
    } else out.cpr_number = m[1];
    if (out.cpr_number?.length === 8) out.cpr_number = '0' + out.cpr_number;
  }

  // DOB fallback: ONLY a date near a 'Birth' label. Cards also print expiry
  // ('EXP 23/09/2015') and first-issue dates, so unlabelled dates are never
  // trusted — the MRZ is the reliable source.
  if (!out.dob) {
    const near = text.match(/birth[^\d]{0,50}(\d{2})[\/\-.](\d{2})[\/\-.](\d{4})/i);
    if (near) {
      const [, d, mo, y] = near;
      if (Number(mo) >= 1 && Number(mo) <= 12) out.dob = `${y}-${mo}-${d}`;
    }
  }

  // Gender fallback
  if (!out.gender) {
    if (/\bMALE\b/i.test(text) && !/\bFEMALE\b/i.test(text)) out.gender = 'M';
    else if (/\bFEMALE\b/i.test(text)) out.gender = 'F';
  }

  // Name fallback: line after 'Name' label, else longest latin-letters line
  if (!out.full_name) {
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const nameIdx = lines.findIndex((l) => /^name\b/i.test(l));
    const looksLatinName = (x) => /^[A-Za-z][A-Za-z .'-]{2,}$/.test((x || '').trim());
    let name = null;
    if (nameIdx !== -1) {
      const inline = lines[nameIdx].replace(/^name[:\s\/]*/i, '').trim();
      if (looksLatinName(inline)) name = inline;
      else {
        // labels are bilingual ('Name / الاسم') — take the next latin line
        name = [lines[nameIdx + 1], lines[nameIdx + 2]].find(looksLatinName) || null;
      }
    }
    if (!name || name.length < 3) {
      const candidates = lines.filter((l) =>
        /^[A-Z][A-Za-z .'-]{5,}$/.test(l) &&
        !/kingdom|bahrain|identity|card|number|birth|indian|nationality|male|female|license|issue|blood|signature/i.test(l));
      name = candidates.sort((a, b) => b.length - a.length)[0] || null;
    }
    if (name) out.full_name = name.replace(/\s{2,}/g, ' ');
  }

  return out;
}

function SideButton({ side, label, hint, busy, stage, done, onFile }) {
  return (
    <div className="flex-1">
      <label className={`flex items-center justify-center gap-2 rounded-lg py-3 text-sm font-semibold cursor-pointer transition-colors ${
        busy ? 'bg-navy-200 text-navy-500' : done ? 'bg-emerald-600 text-white' : 'bg-navy-700 text-white hover:bg-navy-800'}`}>
        <Camera size={15} />
        {busy ? (stage || 'Working…') : done ? `${label} ✓` : label}
        <input type="file" accept="image/*" capture="environment" className="hidden"
               disabled={busy} onChange={(e) => { onFile(side, e.target.files?.[0]); e.target.value = ''; }} />
      </label>
      <p className="text-[10px] text-navy-400 text-center mt-1">{hint}</p>
    </div>
  );
}

export default function CprScanner({ token, onResult }) {
  const [busySide, setBusySide] = useState(null);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [doneSides, setDoneSides] = useState({}); // { front: true, back: true }

  async function handleCapture(side, file) {
    if (!file) return;
    setBusySide(side); setError('');
    try {
      // 1. Upload the photo (front → cpr_scan_url, back → cpr_scan_back_url)
      setStage('Uploading…');
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/api/register/upload`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd,
      });
      const up = await res.json();
      if (!res.ok) throw new Error(up.error || 'Upload failed');

      // 2. OCR in the browser (engine loaded from CDN on first use)
      setStage('Reading… (first scan downloads the reader)');
      const text = await ocrImage(file, (pct) => setStage(`Reading… ${pct}%`));

      const fields = parseCprText(text);
      setDoneSides((d) => ({ ...d, [side]: true }));
      onResult({
        side,
        ...fields,
        [side === 'front' ? 'cpr_scan_url' : 'cpr_scan_back_url']: up.url,
        raw_text: text,
      });
    } catch (err) {
      setError(
        (err?.message?.includes('Failed to fetch') || err?.message?.includes('import'))
          ? 'Could not load the card reader (internet required). The photo was still saved — please type the details manually.'
          : (err.message || 'Could not read the card — you can still type the details and upload the photos below.'),
      );
    } finally {
      setBusySide(null); setStage('');
    }
  }

  return (
    <div className="rounded-xl border border-navy-200 bg-navy-50 p-3 space-y-2">
      <p className="text-xs font-semibold text-navy-700">Scan the CPR card with your camera</p>
      <div className="flex gap-2">
        <SideButton side="front" label="Front side" hint="Personal number & name"
          busy={busySide === 'front'} stage={stage} done={doneSides.front} onFile={handleCapture} />
        <SideButton side="back" label="Back side" hint="Date of birth & details"
          busy={busySide === 'back'} stage={stage} done={doneSides.back} onFile={handleCapture} />
      </div>
      {doneSides.front && doneSides.back && !error && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-700">
          <CheckCircle2 size={13} />
          Both sides scanned — details filled below. Please check them against the card before saving.
        </p>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle size={13} /> {error}
        </p>
      )}
      <p className="text-[11px] text-navy-400">
        Good light, card filling the frame. The date of birth is on the <b>back</b> of the card —
        please scan both sides. Both photos are saved as the official CPR record.
      </p>
    </div>
  );
}
