// src/components/DobPicker.jsx
// Locale-independent date-of-birth entry: three dropdowns (Day / Month / Year)
// with NAMED months, so it reads and behaves identically on every device —
// no MM/DD vs DD/MM confusion from the browser/OS locale. Value in and out is
// an ISO string "YYYY-MM-DD" (same as a native date input), so nothing else
// in the forms needs to change.
//
// Each dropdown is backed by LOCAL state, so a partial selection (e.g. Day
// chosen before Month/Year) stays put. onChange fires an ISO string once all
// three are set, and an empty string while the date is still incomplete.
import { useState, useEffect, useMemo } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const daysInMonth = (y, m) => (m ? new Date(Number(y) || 2000, Number(m), 0).getDate() : 31);

function parse(v) {
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [yy, mm, dd] = v.split('-');
    return { d: String(Number(dd)), m: String(Number(mm)), y: yy };
  }
  return { d: '', m: '', y: '' };
}
function toIso(p) {
  if (p.d && p.m && p.y) {
    const dd = Math.min(Number(p.d), daysInMonth(p.y, p.m));
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  return '';
}

export default function DobPicker({ value, onChange, minYear, maxYear, className = '' }) {
  const now = new Date();
  const maxY = maxYear || now.getFullYear();
  const minY = minYear || (now.getFullYear() - 22);

  const [parts, setParts] = useState(() => parse(value));

  // Re-sync only when the parent pushes a value that differs from what we hold
  // (e.g. a CPR scan auto-fills the DOB, or an edit form loads an existing one).
  // A partial in-progress selection emits '' and never gets wiped by this.
  useEffect(() => {
    if ((value || '') !== toIso(parts)) setParts(parse(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const years = useMemo(() => { const a = []; for (let yr = maxY; yr >= minY; yr--) a.push(yr); return a; }, [minY, maxY]);
  const days = useMemo(() => { const a = []; const n = daysInMonth(parts.y, parts.m); for (let i = 1; i <= n; i++) a.push(i); return a; }, [parts.y, parts.m]);

  function change(next) {
    const merged = { ...parts, ...next };
    if (merged.d && merged.m) {
      const max = daysInMonth(merged.y, merged.m);
      if (Number(merged.d) > max) merged.d = String(max); // clamp e.g. 31 -> Feb
    }
    setParts(merged);
    onChange(toIso(merged));
  }

  const sel = 'min-w-0 rounded-lg border border-slate-300 px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300 bg-white';

  return (
    <div className={`flex gap-2 ${className}`}>
      <select aria-label="Day" value={parts.d} onChange={(e) => change({ d: e.target.value })} className={`${sel} basis-16 shrink`}>
        <option value="">Day</option>
        {days.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <select aria-label="Month" value={parts.m} onChange={(e) => change({ m: e.target.value })} className={`${sel} flex-1`}>
        <option value="">Month</option>
        {MONTHS.map((mn, i) => <option key={mn} value={i + 1}>{mn}</option>)}
      </select>
      <select aria-label="Year" value={parts.y} onChange={(e) => change({ y: e.target.value })} className={`${sel} basis-20 shrink`}>
        <option value="">Year</option>
        {years.map((yr) => <option key={yr} value={yr}>{yr}</option>)}
      </select>
    </div>
  );
}
