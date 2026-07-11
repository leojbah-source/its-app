// src/pages/Lists.jsx
// Post-registration lists: printable event-wise lists (grouped by age group),
// per-participant lists for distribution/confirmation, and the final roster.
// Printing opens a clean window with the year header + logos and calls print().

import { useEffect, useState, useCallback } from 'react';
import { Printer, RefreshCw, Megaphone } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader, ErrorBanner } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { listsApi } from '../api/client';

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** Opens a print window with a standard header (year label + logos). */
function openPrint(year, title, bodyHtml) {
  const w = window.open('', '_blank');
  if (!w) return alert('Please allow pop-ups to print.');
  w.document.write(`<!doctype html><html><head><title>${esc(title)}</title>
<style>
  body { font-family: Arial, sans-serif; color: #1e293b; margin: 24px; }
  .hdr { display: flex; align-items: center; justify-content: space-between;
         border-bottom: 3px solid #1e3a5f; padding-bottom: 10px; margin-bottom: 6px; }
  .hdr img { max-height: 54px; }
  h1 { font-size: 17px; color: #1e3a5f; margin: 0; }
  h2 { font-size: 14px; margin: 18px 0 6px; color: #1e3a5f;
       border-bottom: 1px solid #cbd5e1; padding-bottom: 3px; page-break-after: avoid; }
  .sub { font-size: 11px; color: #64748b; margin-bottom: 14px; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin-bottom: 10px; }
  th { text-align: left; background: #f1f5f9; }
  th, td { border: 1px solid #cbd5e1; padding: 4px 8px; }
  .block { page-break-inside: avoid; }
  .sign { margin-top: 8px; font-size: 11px; color: #64748b; }
  @media print { .noprint { display: none; } }
</style></head><body>
<div class="hdr">
  ${year?.kca_logo_url ? `<img src="${esc(year.kca_logo_url)}" alt="KCA" />` : '<div style="width:54px"></div>'}
  <div style="text-align:center">
    ${year?.its_logo_url ? `<img src="${esc(year.its_logo_url)}" alt="ITS" style="max-height:56px;display:block;margin:0 auto 4px" />` : ''}
    <h1>${esc(year?.event_year_label || 'KCA Indian Talent Scan')}</h1>
    <div class="sub">${esc(title)} · printed ${new Date().toLocaleString('en-GB')}</div>
  </div>
  ${year?.sponsor_logo_url ? `<img src="${esc(year.sponsor_logo_url)}" alt="Sponsor" />` : '<div style="width:54px"></div>'}
</div>
${bodyHtml}
<script>window.onload = () => setTimeout(() => window.print(), 300);</script>
</body></html>`);
  w.document.close();
}

export default function Lists() {
  const { token } = useAuth();
  const [tab, setTab] = useState('by-event');
  const [byEvent, setByEvent] = useState(null);
  const [byParticipant, setByParticipant] = useState(null);
  const [finalList, setFinalList] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [flash, setFlash] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [ev, pa, fi] = await Promise.all([
        listsApi.byEvent(token), listsApi.byParticipant(token), listsApi.final(token),
      ]);
      setByEvent(ev); setByParticipant(pa); setFinalList(fi);
    } catch (err) {
      setError(err.message || 'Failed to load lists');
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const year = byEvent?.year;

  // ── Print builders ──────────────────────────────────────────────────────
  function printByEvent() {
    // Restructure: Age group (ascending) → event names (alphabetical) →
    // participant names (alphabetical). No CPR numbers or schools.
    const byGroup = new Map(); // group → Map(eventName → {code, names[]})
    for (const ev of byEvent.events) {
      for (const en of ev.entries) {
        const g = en.age_group_code || '—';
        const label = en.age_group_label || '';
        if (!byGroup.has(g)) byGroup.set(g, { label, events: new Map() });
        const grp = byGroup.get(g);
        if (!grp.events.has(ev.event_name))
          grp.events.set(ev.event_name, { code: ev.event_code, names: [] });
        grp.events.get(ev.event_name).names.push(en.name);
      }
    }
    const body = [...byGroup.keys()].sort().map((g) => {
      const grp = byGroup.get(g);
      const eventsHtml = [...grp.events.keys()].sort().map((evName) => {
        const e = grp.events.get(evName);
        const names = [...e.names].sort((a, b) => a.localeCompare(b));
        return `<div class="block">
          <h2 style="font-size:13px;border:none;margin:12px 0 4px">${esc(evName)}
            <span style="font-weight:normal;font-size:10px;color:#64748b"> (${esc(e.code)}) · ${names.length} entr${names.length === 1 ? 'y' : 'ies'}</span></h2>
          <table><thead><tr><th style="width:34px">#</th><th>Name</th></tr></thead>
          <tbody>${names.map((n, i) => `<tr><td>${i + 1}</td><td>${esc(n)}</td></tr>`).join('')}</tbody></table>
        </div>`;
      }).join('');
      return `<div><h2 style="font-size:16px;background:#f1f5f9;padding:6px 10px">
        ${esc(g)}${grp.label ? ` — ${esc(grp.label)}` : ''}</h2>${eventsHtml}</div>`;
    }).join('');
    openPrint(year, 'Initial Lists — by Age Group & Event', body);
  }

  function printByParticipant() {
    const body = byParticipant.participants.map((p) => `
      <div class="block">
        <h2>${esc(p.full_name)}
          <span style="font-weight:normal;font-size:11px;color:#64748b">
            · ${esc(p.age_group_label || p.age_group_code || '')}</span></h2>
        <table><thead><tr><th style="width:80px">Code</th><th>Event</th><th>Category</th></tr></thead>
        <tbody>${p.events.map((e) =>
          `<tr><td>${esc(e.event_code)}</td><td>${esc(e.event_name)}</td><td>${esc(e.category_name || '')}</td></tr>`).join('')}
        </tbody></table>
        <div class="sign">Parent/guardian signature (details confirmed): ____________________________</div>
      </div>`).join('');
    openPrint(year, 'Initial Lists — by Participant (for confirmation)', body);
  }

  function printFinal() {
    const t = finalList.totals;
    const body = `
      <p style="font-size:12px">Participants: <b>${t.participants}</b> · Event entries: <b>${t.entries}</b> ·
        ${Object.entries(t.by_group).map(([g, n]) => `${esc(g)}: <b>${n}</b>`).join(' · ')}</p>
      <table><thead><tr>
        <th style="width:28px">#</th><th style="width:200px">Name</th>
        <th style="width:60px">Group</th><th style="width:44px">Events</th><th>Registered events</th></tr></thead>
      <tbody>${finalList.participants.map((p, i) =>
        `<tr><td>${i + 1}</td><td>${esc(p.full_name)}</td>
         <td>${esc(p.age_group_code || '')}</td><td>${p.event_count}</td>
         <td style="padding:0"><table style="margin:0;border:none">${(p.events || []).map((e) =>
           `<tr><td style="border:none;border-bottom:1px solid #e2e8f0;width:70px">${esc(e.event_code)}</td>
            <td style="border:none;border-bottom:1px solid #e2e8f0">${esc(e.event_name)}</td></tr>`).join('')}
         </table></td></tr>`).join('')}
      </tbody></table>`;
    openPrint(year, 'FINAL LIST of Participants', body);
  }

  async function publishInitial() {
    setPublishing(true);
    setFlash('');
    try {
      const r = await listsApi.publishInitial(token);
      setFlash(`Initial list published ${new Date(r.initial_list_published_at).toLocaleString('en-GB')}.`);
      load();
    } catch (err) { setFlash(err.message); }
    finally { setPublishing(false); }
  }

  const TABS = [
    ['by-event', 'By Event & Age Group'],
    ['by-participant', 'By Participant'],
    ['final', 'Final List'],
  ];

  return (
    <AdminLayout
      title="Lists"
      subtitle="Initial registration lists for printing and distribution, and the final participant roster."
      actions={
        <>
          <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
          <Button variant="outline" icon={Megaphone} onClick={publishInitial} loading={publishing}>
            {year?.initial_list_published ? 'Re-publish initial list' : 'Publish initial list'}
          </Button>
          <Button
            variant="gold"
            icon={Printer}
            onClick={() => tab === 'by-event' ? printByEvent()
              : tab === 'by-participant' ? printByParticipant() : printFinal()}
            disabled={loading || !!error}
          >
            Print this list
          </Button>
        </>
      }
    >
      {flash && (
        <p className="mb-4 rounded-lg bg-navy-50 border border-navy-200 px-4 py-2 text-sm text-navy-700">{flash}</p>
      )}
      {year?.initial_list_published && (
        <p className="mb-4 text-xs text-emerald-700">
          Initial list published on {new Date(year.initial_list_published_at).toLocaleString('en-GB')}.
        </p>
      )}

      <div className="mb-4 flex rounded-lg border border-slate-300 overflow-hidden w-fit text-sm font-medium">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 transition-colors ${
              tab === k ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
            {label}
          </button>
        ))}
      </div>

      <Card>
        {loading ? <PageLoader label="Loading lists…" />
          : error ? <ErrorBanner message={error} onRetry={load} />
          : tab === 'by-event' ? (
            <div className="divide-y divide-slate-100">
              {byEvent.events.map((ev) => (
                <div key={ev.event_id} className="py-3 flex items-center justify-between">
                  <div>
                    <span className="font-mono text-xs text-navy-700 mr-2">{ev.event_code}</span>
                    <span className="font-medium text-sm text-slate-800">{ev.event_name}</span>
                    <span className="ml-2 text-xs text-slate-400">{ev.category_name}</span>
                  </div>
                  <Badge tone={ev.entries.length ? 'navy' : 'slate'}>{ev.entries.length} entries</Badge>
                </div>
              ))}
              {byEvent.events.length === 0 && <p className="text-sm text-slate-400 py-6 text-center">No entries yet.</p>}
            </div>
          ) : tab === 'by-participant' ? (
            <div className="divide-y divide-slate-100">
              {byParticipant.participants.map((p) => (
                <div key={p.participant_id} className="py-3 flex items-center justify-between">
                  <div>
                    <span className="font-medium text-sm text-slate-800">{p.full_name}</span>
                    <span className="ml-2 text-xs text-slate-400 font-mono">{p.cpr_number}</span>
                    <span className="ml-2 text-xs text-slate-400">{p.age_group_code} · {p.school_name || '—'}</span>
                  </div>
                  <Badge tone="navy">{p.events.length} events</Badge>
                </div>
              ))}
            </div>
          ) : finalList && (
            <div>
              <p className="text-sm text-slate-600 mb-3">
                <b>{finalList.totals.participants}</b> participants · <b>{finalList.totals.entries}</b> event entries ·{' '}
                {Object.entries(finalList.totals.by_group).map(([g, n]) => `${g}: ${n}`).join(' · ')}
              </p>
              <div className="divide-y divide-slate-100">
                {finalList.participants.map((p, i) => (
                  <div key={p.id} className="py-2 text-sm flex items-center justify-between">
                    <span>
                      <span className="text-slate-400 mr-2">{i + 1}.</span>
                      <span className="font-medium text-slate-800">{p.full_name}</span>
                      <span className="ml-2 text-xs text-slate-400">{p.age_group_code} · {p.event_codes}</span>
                    </span>
                    <Badge tone="navy">{p.event_count}</Badge>
                  </div>
                ))}
              </div>
            </div>
          )}
      </Card>
    </AdminLayout>
  );
}
