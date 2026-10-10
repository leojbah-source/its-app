// src/pages/ImportRegistrations.jsx
// Admin screen to bulk-import walk-in registrations from the Excel template.
// Flow: download template → upload filled file → review validation report
// (nothing is saved yet) → Confirm import. Commit is idempotent and never
// disturbs existing live registrations.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload, FileSpreadsheet, Download, CheckCircle2, AlertTriangle,
         ArrowLeft, Loader2, Info } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { useAuth } from '../context/AuthContext';
import { registrationsApi, API_BASE } from '../api/client';
import Button from '../components/ui/Button';
import { Badge } from '../components/ui/Card';

const bd = (v) => Number(v || 0).toFixed(3);

const STATUS_TONE = { ok: 'success', warning: 'gold', skip: 'slate', error: 'danger',
  imported: 'success', failed: 'danger' };

export default function ImportRegistrations() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [report, setReport] = useState(null);   // { summary, rows }
  const [result, setResult] = useState(null);   // commit result

  const downloadTemplate = async () => {
    setErr(null);
    try {
      const res = await fetch(`${API_BASE}/api/admin/registrations/import/template`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Could not download the template');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'its-import-template.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setErr(e.message); }
  };

  const pick = (f) => { setFile(f); setReport(null); setResult(null); setErr(null); };

  const validate = async () => {
    if (!file) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await registrationsApi.importValidate(token, fd);
      setReport(r);
    } catch (e) { setErr(e.message || 'Validation failed'); }
    finally { setBusy(false); }
  };

  const commit = async () => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await registrationsApi.importCommit(token, fd);
      setResult(r);
    } catch (e) { setErr(e.message || 'Import failed'); }
    finally { setBusy(false); }
  };

  const s = report?.summary;

  return (
    <AdminLayout>
      <div className="flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate('/admin/registrations')}>
            Registrations
          </Button>
          <h1 className="text-xl font-semibold text-slate-800">Import walk-in registrations</h1>
        </div>

        {/* Step 1 — template + upload */}
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">1 · Prepare the file</p>
              <p className="text-xs text-slate-500 mt-0.5">
                Download the template, fill one row per child, then upload it. The template lists valid event codes and school names.
              </p>
            </div>
            <Button variant="outline" size="sm" icon={Download} onClick={downloadTemplate}>
              Download template
            </Button>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-100">
              <FileSpreadsheet size={16} />
              {file ? file.name : 'Choose filled .xlsx file'}
              <input
                type="file" className="hidden"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                onChange={(e) => pick(e.target.files?.[0] || null)}
              />
            </label>
            <Button variant="primary" size="sm" icon={Upload} disabled={!file || busy} onClick={validate}>
              {busy && !result ? 'Checking…' : 'Check file'}
            </Button>
          </div>
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
            <Info size={12} /> Checking only validates — nothing is saved until you press Import.
          </p>
        </div>

        {err && (
          <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{err}</div>
        )}

        {/* Step 2 — validation report */}
        {report && !result && (
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <p className="text-sm font-semibold text-slate-800">2 · Review</p>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone="success">{s.importable} ready</Badge>
                {s.warnings > 0 && <Badge tone="gold">{s.warnings} with warnings</Badge>}
                {s.skip > 0 && <Badge tone="slate">{s.skip} nothing new</Badge>}
                {s.errors > 0 && <Badge tone="danger">{s.errors} with errors</Badge>}
                <span className="text-slate-400">· {s.total} rows</span>
              </div>
            </div>

            <div className="overflow-x-auto scroll-thin rounded-lg border border-slate-200">
              <table className="w-full min-w-[820px] text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">Row</th>
                    <th className="px-3 py-2.5 font-medium">Child</th>
                    <th className="px-3 py-2.5 font-medium">Parent</th>
                    <th className="px-3 py-2.5 font-medium">Events</th>
                    <th className="px-3 py-2.5 font-medium">Fee</th>
                    <th className="px-3 py-2.5 font-medium">Status</th>
                    <th className="px-3 py-2.5 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {report.rows.map((r) => (
                    <tr key={r.row} className="align-top hover:bg-slate-50">
                      <td className="px-3 py-2 text-slate-400 text-xs">{r.row}</td>
                      <td className="px-3 py-2">
                        <span className="font-medium text-slate-800">{r.full_name || '—'}</span>
                        <span className="block text-[11px] font-mono text-slate-400">{r.cpr} · {r.gender || '?'} · {r.dob || 'no DOB'}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {r.parent_email || <span className="text-slate-400">office</span>}
                        <span className="block text-[10px] text-slate-400">
                          {r.parent_action === 'create' ? 'new account' : r.parent_action === 'reuse' ? 'existing account' : 'office account'}
                          {r.member_rate ? ' · member rate' : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1 max-w-[260px]">
                          {r.events.length === 0 ? <span className="text-xs text-slate-400">—</span> :
                            r.events.map((ev) => (
                            <span key={ev.code}
                              title={`${ev.event_name} — ${ev.action}`}
                              className={`rounded border px-1.5 py-0.5 text-[11px] font-mono ${
                                ev.action === 'skip' ? 'border-slate-200 bg-slate-50 text-slate-400 line-through'
                                  : 'border-navy-200 bg-navy-50 text-navy-700'}`}>
                              {ev.code}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-slate-600 text-xs whitespace-nowrap">
                        BD {bd(r.total_fee)}
                        {r.cash > 0 && <span className="block text-[10px] text-emerald-600">paid {bd(r.cash)}</span>}
                      </td>
                      <td className="px-3 py-2"><Badge tone={STATUS_TONE[r.status] || 'slate'}>{r.status}</Badge></td>
                      <td className="px-3 py-2 text-xs">
                        {r.errors.map((e, i) => <div key={`e${i}`} className="text-red-600">• {e}</div>)}
                        {r.warnings.map((w, i) => <div key={`w${i}`} className="text-amber-600">• {w}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => { setReport(null); setFile(null); }}>Start over</Button>
              <Button variant="primary" size="sm" icon={CheckCircle2} disabled={busy || s.importable === 0} onClick={commit}>
                {busy ? 'Importing…' : `Import ${s.importable} registration${s.importable !== 1 ? 's' : ''}`}
              </Button>
            </div>
            {s.importable === 0 && (
              <p className="mt-2 text-right text-xs text-slate-400">Nothing to import — fix the errors above and re-check.</p>
            )}
          </div>
        )}

        {/* Step 3 — result */}
        {result && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-5">
            <p className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
              <CheckCircle2 size={18} /> Import complete
            </p>
            <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-sm text-emerald-900 sm:grid-cols-3">
              <span>New participants: <b>{result.summary.created}</b></span>
              <span>Existing reused: <b>{result.summary.reused_participants}</b></span>
              <span>Events added: <b>{result.summary.events_added}</b></span>
              <span>Payments recorded: <b>{result.summary.payments_recorded}</b></span>
              <span>Parent accounts created: <b>{result.summary.parents_created}</b></span>
              {result.summary.failed > 0 && <span className="text-red-700">Failed rows: <b>{result.summary.failed}</b></span>}
            </div>
            {result.results.some((r) => r.status === 'failed') && (
              <div className="mt-3 rounded-md border border-red-200 bg-white px-3 py-2 text-xs text-red-700">
                {result.results.filter((r) => r.status === 'failed').map((r) => (
                  <div key={r.row}>Row {r.row} ({r.full_name}): {r.message}</div>
                ))}
              </div>
            )}
            <div className="mt-4 flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={() => navigate('/admin/registrations')}>Go to Registrations</Button>
              <Button variant="outline" size="sm" onClick={() => { setFile(null); setReport(null); setResult(null); }}>Import another file</Button>
            </div>
          </div>
        )}
      </div>
    </AdminLayout>
  );
}
