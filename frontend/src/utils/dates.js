// src/utils/dates.js
// Pick a sensible default date for day-of pickers: today when it's one of the
// scheduled dates, otherwise the next upcoming scheduled date, otherwise the
// last one. `dates` is a sorted array of 'YYYY-MM-DD' strings.
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function pickDefaultDate(dates) {
  if (!dates || !dates.length) return '';
  const t = todayStr();
  if (dates.includes(t)) return t;
  const upcoming = dates.find((d) => d >= t);
  return upcoming || dates[dates.length - 1];
}
