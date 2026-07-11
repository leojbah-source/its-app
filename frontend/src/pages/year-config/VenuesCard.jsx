// src/pages/year-config/VenuesCard.jsx
// Facility / hall setup for scheduling (up to 4 venues). Each venue defines
// a stage flag, suitability (dance/music/arts/literary — none ticked = all),
// capacity (e.g. tables & chairs for drawing/painting), and per-weekday
// availability hours (unticked day = venue unavailable that day).

import { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Save } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import { useAuth } from '../../context/AuthContext';
import { venuesApi } from '../../api/client';

const DAYS = [
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'], ['mon', 'Monday'],
  ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
];
const TAGS = [
  ['dance', 'Dance'], ['music', 'Music / Song'], ['arts', 'Arts & Crafts'], ['literary', 'Literary'],
];
const inputCls = 'rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

const emptyVenue = () => ({
  name: '', has_stage: true, capacity: '', suitable_for: [], notes: '',
  weekday_hours: {},
});

export default function VenuesCard() {
  const { token } = useAuth();
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await venuesApi.list(token);
      setVenues(rows.map((v) => ({ ...v, capacity: v.capacity ?? '' })));
    } catch { /* shown on save */ }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  const up = (i, patch) => setVenues((l) => l.map((v, idx) => (idx === i ? { ...v, ...patch } : v)));

  const toggleTag = (i, tag) => up(i, {
    suitable_for: venues[i].suitable_for.includes(tag)
      ? venues[i].suitable_for.filter((t) => t !== tag)
      : [...venues[i].suitable_for, tag],
  });

  const setDay = (i, day, patch) => {
    const wh = { ...(venues[i].weekday_hours || {}) };
    if (patch === null) delete wh[day];
    else wh[day] = { start: '19:00', end: '22:00', ...(wh[day] || {}), ...patch };
    up(i, { weekday_hours: wh });
  };

  async function save() {
    setSaving(true);
    setMsg('');
    try {
      const payload = venues.map((v) => ({
        ...v, capacity: v.capacity === '' ? null : Number(v.capacity),
      }));
      await venuesApi.save(token, payload);
      setMsg('Venues saved.');
      load();
    } catch (err) { setMsg(err.message || 'Save failed'); }
    finally { setSaving(false); }
  }

  return (
    <Card
      title="Venues / facility setup"
      description="Up to 4 halls used by the auto-scheduler. Suitability, capacity and per-day availability decide where and when each event can be placed."
    >
      {loading ? <p className="text-sm text-slate-400">Loading…</p> : (
        <div className="space-y-5">
          {venues.map((v, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <input value={v.name} onChange={(e) => up(i, { name: e.target.value })}
                  placeholder={`Venue ${i + 1} name (e.g. VKL Hall)`} className={`${inputCls} flex-1 font-medium`} />
                <button onClick={() => setVenues((l) => l.filter((_, idx) => idx !== i))}
                  className="text-slate-400 hover:text-red-500"><Trash2 size={16} /></button>
              </div>

              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={v.has_stage}
                    onChange={(e) => up(i, { has_stage: e.target.checked })}
                    className="h-4 w-4 rounded border-slate-300" />
                  Has a stage
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  Capacity
                  <input type="number" min={1} value={v.capacity}
                    onChange={(e) => up(i, { capacity: e.target.value })}
                    placeholder="∞" className={`${inputCls} w-20`} />
                  <span className="text-xs text-slate-400">(e.g. tables/chairs for drawing)</span>
                </label>
              </div>

              <div>
                <span className="text-xs font-medium text-slate-600">
                  Suitable for (none ticked = all events)
                </span>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {TAGS.map(([tag, label]) => (
                    <button key={tag} onClick={() => toggleTag(i, tag)}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        v.suitable_for.includes(tag)
                          ? 'border-navy-600 bg-navy-50 text-navy-700'
                          : 'border-slate-300 text-slate-500 hover:bg-slate-50'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <span className="text-xs font-medium text-slate-600">
                  Availability (untick a day if the hall is not available — e.g. off Wed/Thu)
                </span>
                <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
                  {DAYS.map(([day, label]) => {
                    const h = (v.weekday_hours || {})[day];
                    return (
                      <div key={day} className="flex items-center gap-2 text-sm">
                        <label className="flex items-center gap-1.5 w-28 text-slate-700">
                          <input type="checkbox" checked={!!h}
                            onChange={(e) => setDay(i, day, e.target.checked ? {} : null)}
                            className="h-4 w-4 rounded border-slate-300" />
                          {label}
                        </label>
                        {h && (
                          <>
                            <input type="time" value={h.start || ''}
                              onChange={(e) => setDay(i, day, { start: e.target.value })} className={inputCls} />
                            <span className="text-slate-400 text-xs">to</span>
                            <input type="time" value={h.end || ''}
                              onChange={(e) => setDay(i, day, { end: e.target.value })} className={inputCls} />
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ))}

          {venues.length < 4 && (
            <button onClick={() => setVenues((l) => [...l, emptyVenue()])}
              className="w-full rounded-lg border border-dashed border-slate-300 py-2.5 text-sm text-slate-500 hover:border-navy-400 flex items-center justify-center gap-1.5">
              <Plus size={14} /> Add venue ({venues.length}/4)
            </button>
          )}

          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving}
              className="rounded-lg bg-navy-700 px-4 py-2 text-sm font-semibold text-white hover:bg-navy-800 disabled:opacity-60 flex items-center gap-1.5">
              <Save size={14} /> {saving ? 'Saving…' : 'Save venues'}
            </button>
            {msg && <span className="text-xs text-navy-700">{msg}</span>}
          </div>
        </div>
      )}
    </Card>
  );
}
