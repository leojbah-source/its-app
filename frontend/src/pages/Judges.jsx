// src/pages/Judges.jsx
// Judges management: profiles (brief + detailed/MC bio, fields of expertise),
// blacklist (rule #10), manual OTP at briefing (rule #12), and assigning ~3
// judges per event off the published schedule (earliest date first). Contact
// fields render only for SuperAdmin/Chairman (rule #11).
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Gavel, Ban, ShieldCheck, KeyRound, Trash2, UserPlus, X, Save } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import Drawer from '../components/ui/Drawer';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import { Input, Textarea } from '../components/ui/FormField';
import { PageLoader, ErrorBanner, EmptyState } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { judgesApi, categoriesApi } from '../api/client';

const MANAGE_ROLES = ['SuperAdmin', 'Chairman'];
const blank = () => ({ full_name: '', bio: '', detailed_bio: '', expertise: [], phone: '', whatsapp: '', email: '' });

function AssignPanel({ judge, schedEvents, token, canManage, onChanged }) {
  const [rows, setRows] = useState([]);
  const [eventId, setEventId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try { setRows(await judgesApi.assignments(token, judge.id)); } catch { /* ignore */ }
  }, [token, judge.id]);
  useEffect(() => { load(); }, [load]);

  async function assign() {
    if (!eventId) return;
    setBusy(true); setMsg('');
    try {
      const r = await judgesApi.assign(token, { judge_id: judge.id, event_id: Number(eventId) });
      setMsg(r.note || 'Assigned.'); setEventId(''); await load(); onChanged();
    } catch (err) {
      if (err.data?.requiresChairmanConfirmation) {
        if (!canManage) setMsg('Judge is blacklisted — only Chairman/SuperAdmin can assign.');
        else if (window.confirm(`${err.data.warning}\n\nConfirm assignment?`)) {
          try {
            const r = await judgesApi.assign(token, { judge_id: judge.id, event_id: Number(eventId), chairman_confirmed: true });
            setMsg(r.note || 'Assigned.'); setEventId(''); await load(); onChanged();
          } catch (e2) { setMsg(e2.message); }
        }
      } else setMsg(err.message);
    } finally { setBusy(false); }
  }

  async function remove(assignmentId) {
    try { await judgesApi.unassign(token, assignmentId); await load(); onChanged(); }
    catch (err) { setMsg(err.message); }
  }

  const assignedEventIds = new Set(rows.map((r) => r.event_id));
  const options = schedEvents.filter((e) => !assignedEventIds.has(e.event_id));

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <p className="mb-2 text-xs font-semibold text-slate-600">Event assignments ({rows.length})</p>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {rows.length === 0 && <span className="text-xs text-slate-400">No events yet.</span>}
        {rows.map((r) => (
          <span key={r.assignment_id} className="inline-flex items-center gap-1 rounded-full bg-white border border-slate-200 px-2 py-0.5 text-xs">
            {r.event_code} · {r.event_name}
            <button onClick={() => remove(r.assignment_id)} className="text-slate-400 hover:text-red-600" title="Unassign"><X size={12} /></button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={eventId} onChange={(e) => setEventId(e.target.value)}
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm max-w-md">
          <option value="">
            {schedEvents.length ? 'Add from schedule (earliest first)…' : 'No schedule yet — generate/publish it first'}
          </option>
          {options.map((e) => (
            <option key={e.event_id} value={e.event_id}>
              {e.earliest_date} · {e.event_code} · {e.event_name}{e.published ? '' : ' (draft)'}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" icon={UserPlus} loading={busy} disabled={!eventId} onClick={assign}>Assign</Button>
        {msg && <span className="text-xs text-slate-600">{msg}</span>}
      </div>
    </div>
  );
}

function ExpertisePicker({ categories, value, onChange }) {
  const toggle = (code) => {
    const has = value.includes(code);
    onChange(has ? value.filter((c) => c !== code) : [...value, code]);
  };
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-navy-800">Fields of expertise</label>
      <p className="mb-2 text-xs text-slate-500">Categories this judge can adjudicate — used to find judges for an event later.</p>
      <div className="flex flex-wrap gap-1.5">
        {categories.map((c) => {
          const on = value.includes(c.code);
          return (
            <button key={c.id} type="button" onClick={() => toggle(c.code)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                on ? 'border-navy-600 bg-navy-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}>
              {c.name}
            </button>
          );
        })}
        {categories.length === 0 && <span className="text-xs text-slate-400">No categories configured.</span>}
      </div>
    </div>
  );
}

export default function Judges() {
  const { token, user } = useAuth();
  const canManage = MANAGE_ROLES.includes(user?.role);

  const [judges, setJudges] = useState([]);
  const [schedEvents, setSchedEvents] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');
  const [expanded, setExpanded] = useState(null);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [draft, setDraft] = useState(blank());
  const [editingId, setEditingId] = useState(null);
  const [saving, setSaving] = useState(false);

  const [blk, setBlk] = useState(null);
  const [blkReason, setBlkReason] = useState('');
  const [del, setDel] = useState(null);

  const catName = (code) => categories.find((c) => c.code === code)?.name || code;

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [j, se, cats] = await Promise.all([
        judgesApi.list(token),
        judgesApi.scheduleEvents(token).catch(() => []),
        categoriesApi.list(token).catch(() => []),
      ]);
      setJudges(j); setSchedEvents(se); setCategories(cats);
    } catch (err) { setError(err.message || 'Failed to load judges'); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  function openNew() { setDraft(blank()); setEditingId(null); setDrawerOpen(true); }
  function openEdit(j) {
    setDraft({
      full_name: j.full_name || '', bio: j.bio || '', detailed_bio: j.detailed_bio || '',
      expertise: Array.isArray(j.expertise) ? j.expertise : [],
      phone: j.phone || '', whatsapp: j.whatsapp || '', email: j.email || '',
    });
    setEditingId(j.id); setDrawerOpen(true);
  }
  async function save() {
    if (!draft.full_name.trim()) { setFlash('Full name is required.'); return; }
    setSaving(true);
    try {
      if (editingId) await judgesApi.update(token, editingId, draft);
      else await judgesApi.create(token, draft);
      setDrawerOpen(false); setFlash(editingId ? 'Judge updated.' : 'Judge added.'); load();
    } catch (err) { setFlash(err.message); }
    finally { setSaving(false); }
  }

  async function doBlacklist() {
    try { await judgesApi.blacklist(token, blk.id, blkReason); setBlk(null); setBlkReason(''); setFlash('Judge blacklisted.'); load(); }
    catch (err) { setFlash(err.message); }
  }
  async function unblacklist(j) {
    try { await judgesApi.unblacklist(token, j.id); setFlash('Blacklist lifted.'); load(); }
    catch (err) { setFlash(err.message); }
  }
  async function doDelete() {
    try { await judgesApi.remove(token, del.id); setDel(null); setFlash('Judge deleted.'); load(); }
    catch (err) { setDel(null); setFlash(err.message); }
  }
  async function sendOtp(j) {
    try { await judgesApi.sendOtp(token, j.id); setFlash(`OTP sent to ${j.full_name}.`); load(); }
    catch (err) { setFlash(err.message); }
  }

  return (
    <AdminLayout title="Judges" subtitle="Profiles, expertise, briefing OTPs, and event assignments — 3 judges per event.">
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="text-sm text-slate-500">{judges.length} judge(s)</div>
        <div className="flex gap-2">
          <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
          {canManage && <Button variant="primary" icon={Plus} onClick={openNew}>Add judge</Button>}
        </div>
      </div>

      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {loading ? <PageLoader label="Loading judges…" />
        : error ? <ErrorBanner message={error} onRetry={load} />
        : judges.length === 0 ? (
          <Card><EmptyState icon={Gavel} title="No judges yet" description={canManage ? 'Add your first judge to begin assigning them to events.' : 'No judges have been added yet.'} /></Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Judge</th>
                  <th className="px-4 py-2">Expertise</th>
                  <th className="px-4 py-2">Contact</th>
                  <th className="px-4 py-2">Events</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {judges.map((j) => (
                  <>
                    <tr key={j.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-navy-800">{j.full_name}</div>
                        {j.bio && <div className="text-xs text-slate-500 max-w-xs">{j.bio}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {(j.expertise || []).length === 0 && <span className="text-xs text-slate-400">—</span>}
                          {(j.expertise || []).map((code) => (
                            <span key={code} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{catName(code)}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-600">
                        {j.phone || j.whatsapp || j.email ? (
                          <>
                            {j.phone && <div>{j.phone}</div>}
                            {j.email && <div>{j.email}</div>}
                          </>
                        ) : j.has_contact ? <span className="text-slate-400 italic">restricted</span>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button onClick={() => setExpanded(expanded === j.id ? null : j.id)}
                          className="text-xs font-medium text-navy-600 underline">
                          {j.assignment_count} event(s)
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        {j.is_blacklisted ? <Badge tone="danger">Blacklisted</Badge> : <Badge tone="success">Active</Badge>}
                        {j.otp_sent_at && <div className="mt-1 text-[10px] text-slate-400">OTP sent</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => sendOtp(j)} title="Send login OTP">OTP</Button>
                          {canManage && <Button size="sm" variant="ghost" onClick={() => openEdit(j)}>Edit</Button>}
                          {canManage && (j.is_blacklisted
                            ? <Button size="sm" variant="ghost" icon={ShieldCheck} onClick={() => unblacklist(j)}>Unblock</Button>
                            : <Button size="sm" variant="ghost" icon={Ban} onClick={() => { setBlk(j); setBlkReason(''); }}>Blacklist</Button>)}
                          {canManage && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDel(j)} title="Delete" />}
                        </div>
                      </td>
                    </tr>
                    {expanded === j.id && (
                      <tr key={`${j.id}-exp`}>
                        <td colSpan={6} className="px-4 pb-3">
                          <AssignPanel judge={j} schedEvents={schedEvents} token={token} canManage={canManage} onChanged={load} />
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </Card>
        )}

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)}
        title={editingId ? 'Edit judge' : 'New judge'}
        subtitle="Contact details are visible only to SuperAdmin and Chairman."
        footer={<>
          <Button variant="outline" onClick={() => setDrawerOpen(false)}>Discard</Button>
          <Button variant="primary" icon={Save} loading={saving} onClick={save}>Save judge</Button>
        </>}>
        <div className="flex flex-col gap-4">
          <Input label="Full name" required value={draft.full_name} onChange={(e) => setDraft({ ...draft, full_name: e.target.value })} />
          <Textarea label="Brief bio" hint="Short blurb for public judge lists." value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} />
          <Textarea label="Detailed bio (MC introduction)" hint="Read aloud by the MCs to introduce the judge; the MC script pulls this for the 3 judges on an event." value={draft.detailed_bio} onChange={(e) => setDraft({ ...draft, detailed_bio: e.target.value })} />
          <ExpertisePicker categories={categories} value={draft.expertise} onChange={(expertise) => setDraft({ ...draft, expertise })} />
          <Input label="Phone" hint="Used for the briefing login OTP." value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
          <Input label="WhatsApp" value={draft.whatsapp} onChange={(e) => setDraft({ ...draft, whatsapp: e.target.value })} />
          <Input label="Email" type="email" value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
        </div>
      </Drawer>

      <ConfirmDialog open={!!blk} title={`Blacklist ${blk?.full_name || ''}?`}
        description="Blacklisted judges can only be assigned to events with Chairman confirmation (rule #10)."
        confirmLabel="Blacklist" variant="danger"
        onCancel={() => setBlk(null)} onConfirm={doBlacklist}>
        <Textarea label="Reason (required)" value={blkReason} onChange={(e) => setBlkReason(e.target.value)} />
      </ConfirmDialog>

      <ConfirmDialog open={!!del} title={`Delete ${del?.full_name || ''}?`}
        description="This permanently removes the judge. Judges with event assignments cannot be deleted — blacklist them instead."
        confirmLabel="Delete" variant="danger"
        onCancel={() => setDel(null)} onConfirm={doDelete} />
    </AdminLayout>
  );
}
