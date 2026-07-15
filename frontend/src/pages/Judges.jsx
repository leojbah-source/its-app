// src/pages/Judges.jsx
// Judge PROFILES only — create/edit, brief + detailed (MC) bios, fields of
// expertise, blacklist (rule #10). Event assignment and briefing OTPs now live
// on the Schedule page (event level), where 3 judges are picked per event from
// those whose expertise matches the event's category.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Gavel, Ban, ShieldCheck, Trash2, Save } from 'lucide-react';
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

function ExpertisePicker({ categories, value, onChange }) {
  const toggle = (code) => {
    const has = value.includes(code);
    onChange(has ? value.filter((c) => c !== code) : [...value, code]);
  };
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-navy-800">Fields of expertise</label>
      <p className="mb-2 text-xs text-slate-500">Categories this judge can adjudicate — event assignment shows only judges whose expertise matches the event's category.</p>
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
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState('');

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
      const [j, cats] = await Promise.all([
        judgesApi.list(token),
        categoriesApi.list(token).catch(() => []),
      ]);
      setJudges(j); setCategories(cats);
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

  return (
    <AdminLayout title="Judges" subtitle="Judge profiles and fields of expertise. Assign judges to events (and send briefing OTPs) from the Schedule page.">
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
          <Card><EmptyState icon={Gavel} title="No judges yet" description={canManage ? 'Add your first judge, then assign them to events from the Schedule page.' : 'No judges have been added yet.'} /></Card>
        ) : (
          <Card className="overflow-hidden p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Judge</th>
                  <th className="px-4 py-2">Expertise</th>
                  <th className="px-4 py-2">Contact</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {judges.map((j) => (
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
                      {j.is_blacklisted ? <Badge tone="danger">Blacklisted</Badge> : <Badge tone="success">Active</Badge>}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        {canManage && <Button size="sm" variant="ghost" onClick={() => openEdit(j)}>Edit</Button>}
                        {canManage && (j.is_blacklisted
                          ? <Button size="sm" variant="ghost" icon={ShieldCheck} onClick={() => unblacklist(j)}>Unblock</Button>
                          : <Button size="sm" variant="ghost" icon={Ban} onClick={() => { setBlk(j); setBlkReason(''); }}>Blacklist</Button>)}
                        {canManage && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setDel(j)} title="Delete" />}
                      </div>
                    </td>
                  </tr>
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
          <Input label="Phone" hint="Used for the briefing login OTP (sent from the Schedule page)." value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
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
