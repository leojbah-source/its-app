// src/components/DobPicker.jsx
// Locale-independent date-of-birth entry: three dropdowns (Day / Month / Year)
// with NAMED months, so it reads and behaves identically on every device —
// no MM/DD vs DD/MM confusion from the browser/OS locale. Value in and out is
// an ISO string "YYYY-MM-DD" (same as a native date input), so nothing else
// in the forms needs to change.
import { useMemo } from 'react';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const daysInMonth = (y, m) => (y && m ? new Date(Number(y), Number(m), 0).getDate() : 31);

export default function DobPicker({ value, onChange, minYear, maxYear, className = '' }) {
  const now = new Date();
  const maxY = maxYear || now.getFullYear();
  const minY = minYear || (now.getFullYear() - 22);
  const [y, m, d] = (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) ? value.split('-') : ['', '', ''];

  const years = useMemo(() => { const a = []; for (let yr = maxY; yr >= minY; yr--) a.push(yr); return a; }, [minY, maxY]);
  const days = useMemo(() => { const a = []; const n = daysInMonth(y, m); for (let i = 1; i <= n; i++) a.push(i); return a; }, [y, m]);

  function emit(nd, nm, ny) {
    if (nd && nm && ny) {
      const dd = Math.min(Number(nd), daysInMonth(ny, nm));
      onChange(`${ny}-${String(nm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
    } else {
      onChange('');
    }
  }
  const sel = 'rounded-lg border border-slate-300 px-2 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300 bg-white';
  const curD = d ? String(Number(d)) : '';
  const curM = m ? String(Number(m)) : '';

  return (
    <div className={`flex gap-2 ${className}`}>
      <select aria-label="Day" value={curD} onChange={(e) => emit(e.target.value, curM, y)} className={`${sel} w-[4.5rem]`}>
        <option value="">Day</option>
        {days.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <select aria-label="Month" value={curM} onChange={(e) => emit(curD, e.target.value, y)} className={`${sel} flex-1`}>
        <option value="">Month</option>
        {MONTHS.map((mn, i) => <option key={mn} value={i + 1}>{mn}</option>)}
      </select>
      <select aria-label="Year" value={y} onChange={(e) => emit(curD, curM, e.target.value)} className={`${sel} w-[5.5rem]`}>
        <option value="">Year</option>
        {years.map((yr) => <option key={yr} value={yr}>{yr}</option>)}
      </select>
    </div>
  );
}
