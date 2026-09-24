// src/pages/Notices.jsx
// Post announcements to the public board (/pwa) AND send them out over WhatsApp —
// either to a criteria-based selection of parents or straight into a WhatsApp
// group. SuperAdmin/Admin/Chairman.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, Eye, EyeOff, Paperclip, FileText, Send, Users, MessageSquare } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { noticesApi, API_BASE } from '../api/client';

const asset = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : `${API_BASE}${u}`);
const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

export default function Notices() {
  const { token } = useAuth();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  // Broadcast
  const [lookups, setLookups] = useState({ ageGroups: [], events: [], schools: [] });
  const [groups, setGroups] = useState([]);
  const [sends, setSends] = useState([]);
  const [msg, setMsg] = useState('');
  const [mode, setMode] = useState('criteria'); // 'criteria' | 'group'
  const [groupId, setGroupId] = useState('');
  const [crit, setCrit] = useState({ age_group_ids: [], event_ids: [], school_ids: [], payment: '', cpr: '' });
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [gName, setGName] = useState('');
  const [gChat, setGChat] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setFlash('');
    try { setList(await noticesApi.list(token, 'active')); }
    catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token]);

  const loadAux = useCallback(async () => {
    try {
      const [lk, gr, sn] = await Promise.all([
        noticesApi.lookups(token), noticesApi.groups(token), noticesApi.sends(token),
      ]);
      setLookups(lk); setGroups(gr); setSends(sn);
    } catch (e) { /* non-fatal for the page */ }
  }, [token]);

  useEffect(() => { load(); loadAux(); }, [load, loadAux]);

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true); setFlash('');
    try {
      let attach = {};
      if (file) {
        const up = await noticesApi.uploadFile(token, file);
        attach = { attachment_url: up.url, attachment_type: up.type };
      }
      await noticesApi.create(token, { year_id: 'active', title, body, ...attach });
      setTitle(''); setBody(''); setFile(null); load();
    } catch (e) { setFlash(e.message); }
    finally { setBusy(false); }
  }
  async function toggle(n) {
    try { await noticesApi.update(token, n.id, { is_active: !n.is_active }); load(); }
    catch (e) { setFlash(e.message); }
  }
  async function remove(n) {
    if (!window.confirm(`Delete notice “${n.title}”?`)) return;
    try { await noticesApi.remove(token, n.id); load(); }
    catch (e) { setFlash(e.message); }
  }

  // ── Broadcast helpers ──────────────────────────────────────────────────────
  function useNotice(n) {
    setMsg(`${n.title}${n.body ? `\n\n${n.body}` : ''}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function toggleId(field, id) {
    setPreview(null);
    setCrit((c) => {
      const has = c[field].includes(id);
      return { ...c, [field]: has ? c[field].filter((x) => x !== id) : [...c[field], id] };
    });
  }
  function setCritField(field, val) { setPreview(null); setCrit((c) => ({ ...c, [field]: val })); }
  function resetCrit() { setPreview(null); setCrit({ age_group_ids: [], event_ids: [], school_ids: [], payment: '', cpr: '' }); }

  function audienceLabel() {
    const bits = [];
    if (crit.age_group_ids.length) bits.push(`${crit.age_group_ids.length} age group(s)`);
    if (crit.event_ids.length) bits.push(`${crit.event_ids.length} event(s)`);
    if (crit.school_ids.length) bits.push(`${crit.school_ids.length} school(s)`);
    if (crit.payment) bits.push(`${crit.payment}`);
    if (crit.cpr) bits.push(`CPR ${crit.cpr}`);
    return bits.length ? bits.join(', ') : 'All completed parents';
  }

  async function doPreview() {
    setPreviewing(true); setFlash('');
    try { setPreview(await noticesApi.audiencePreview(token, crit)); }
    catch (e) { setFlash(e.message); }
    finally { setPreviewing(false); }
  }

  async function doSend() {
    if (!msg.trim()) { setFlash('Enter a message first.'); return; }
    if (mode === 'group') {
      if (!groupId) { setFlash('Pick a WhatsApp group.'); return; }
      const g = groups.find((x) => String(x.id) === String(groupId));
      if (!window.confirm(`Send this message to the WhatsApp group “${g?.name}”?`)) return;
      setSending(true); setFlash('');
      try {
        await noticesApi.send(token, { message: msg, group_id: Number(groupId) });
        setFlash('Sent to the group.'); loadAux();
      } catch (e) { setFlash(e.message); }
      finally { setSending(false); }
      return;
    }
    // criteria
    const n = preview?.count ?? 0;
    if (n === 0) { setFlash('Preview the audience first — 0 parents match.'); return; }
    if (!window.confirm(`Send this WhatsApp message to ${n} parent(s) (${audienceLabel()})?\n\nSending is throttled and runs in the background.`)) return;
    setSending(true); setFlash('');
    try {
      await noticesApi.send(token, { message: msg, criteria: crit, audience_label: audienceLabel() });
      setFlash(`Queued for ${n} parent(s). Watch progress in the send log below.`);
      setPreview(null); loadAux();
    } catch (e) { setFlash(e.message); }
    finally { setSending(false); }
  }

  async function addGroup(e) {
    e.preventDefault();
    if (!gName.trim() || !gChat.trim()) return;
    try { await noticesApi.addGroup(token, gName.trim(), gChat.trim()); setGName(''); setGChat(''); loadAux(); }
    catch (e) { setFlash(e.message); }
  }
  async function delGroup(id) {
    if (!window.confirm('Remove this saved group?')) return;
    try { await noticesApi.removeGroup(token, id); loadAux(); }
    catch (e) { setFlash(e.message); }
  }

  return (
    <AdminLayout title="Notices" subtitle="Post to the public board and send announcements over WhatsApp.">
      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      {/* POST NOTICE */}
      <Card className="mb-4">
        <h2 className="mb-2 text-sm font-semibold text-navy-800">Post a notice to the board</h2>
        <form onSubmit={add} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Prize distribution at 5pm in VKL Hall" className={input} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Details (optional)</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Any extra detail…" className={input} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Attachment (optional) — PDF or JPEG/PNG, everyone can view</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-navy-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-navy-700 hover:file:bg-navy-100" />
            {file && <p className="mt-1 flex items-center gap-1 text-xs text-slate-500"><Paperclip size={12} /> {file.name} <button type="button" onClick={() => setFile(null)} className="text-red-500 hover:underline">remove</button></p>}
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={!title.trim()}>{busy ? 'Posting…' : 'Post notice'}</Button>
          </div>
        </form>
      </Card>

      {/* WHATSAPP BROADCAST */}
      <Card className="mb-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-navy-800"><MessageSquare size={16} /> Send on WhatsApp</h2>
        <p className="mb-3 text-xs text-slate-500">Message parents by selection, or post into a WhatsApp group. Bulk sending needs the paid Green API plan (the free tier reaches only 3 chats).</p>

        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={4} placeholder="Type the WhatsApp message… (tip: use the “Use in WhatsApp” button on a notice below to prefill)" className={`${input} mb-3`} />

        <div className="mb-3 flex rounded-md border border-slate-300 overflow-hidden w-fit text-sm font-medium">
          {[['criteria', 'By selection'], ['group', 'To a WhatsApp group']].map(([k, lb]) => (
            <button key={k} onClick={() => setMode(k)}
              className={`px-3 py-1.5 transition-colors ${mode === k ? 'bg-navy-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{lb}</button>
          ))}
        </div>

        {mode === 'criteria' ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Age groups</label>
                <div className="flex flex-wrap gap-1.5">
                  {lookups.ageGroups.length === 0 && <span className="text-xs text-slate-400">—</span>}
                  {lookups.ageGroups.map((g) => (
                    <button key={g.id} type="button" onClick={() => toggleId('age_group_ids', g.id)}
                      className={`rounded-full border px-2.5 py-1 text-xs ${crit.age_group_ids.includes(g.id) ? 'border-navy-600 bg-navy-600 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>
                      {g.code}{g.label ? ` · ${g.label}` : ''}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">Payment</label>
                  <select value={crit.payment} onChange={(e) => setCritField('payment', e.target.value)} className={input}>
                    <option value="">Any</option>
                    <option value="paid">Paid (confirmed)</option>
                    <option value="unpaid">Not paid</option>
                    <option value="pending">Pending</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">CPR check</label>
                  <select value={crit.cpr} onChange={(e) => setCritField('cpr', e.target.value)} className={input}>
                    <option value="">Any</option>
                    <option value="verified">Verified</option>
                    <option value="pending">Not verified</option>
                    <option value="issue">Issue flagged</option>
                  </select>
                </div>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Events ({crit.event_ids.length || 'any'})</label>
                <select multiple size={4} value={crit.event_ids.map(String)}
                  onChange={(e) => setCritField('event_ids', [...e.target.selectedOptions].map((o) => Number(o.value)))}
                  className={`${input} h-auto`}>
                  {lookups.events.map((ev) => <option key={ev.id} value={ev.id}>{ev.event_code} · {ev.event_name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Schools ({crit.school_ids.length || 'any'})</label>
                <select multiple size={4} value={crit.school_ids.map(String)}
                  onChange={(e) => setCritField('school_ids', [...e.target.selectedOptions].map((o) => Number(o.value)))}
                  className={`${input} h-auto`}>
                  {lookups.schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <p className="text-xs text-slate-400">Selected: <span className="font-medium text-slate-600">{audienceLabel()}</span> (filters combine; empty = everyone who completed registration). Ctrl/Cmd-click to pick several events or schools.</p>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" icon={Users} loading={previewing} onClick={doPreview}>Preview audience</Button>
              {crit.age_group_ids.length + crit.event_ids.length + crit.school_ids.length > 0 || crit.payment || crit.cpr ? (
                <button type="button" onClick={resetCrit} className="text-xs text-slate-500 hover:underline">clear filters</button>
              ) : null}
              {preview && (
                <span className="text-sm text-slate-700">
                  <b>{preview.count}</b> parent{preview.count === 1 ? '' : 's'} will receive this
                  {preview.sample?.length > 0 && <span className="text-slate-400"> — e.g. {preview.sample.map((s) => s.name).slice(0, 4).join(', ')}{preview.count > 4 ? '…' : ''}</span>}
                </span>
              )}
              <div className="flex-1" />
              <Button variant="primary" icon={Send} loading={sending} disabled={!msg.trim() || !(preview?.count > 0)} onClick={doSend}>Send WhatsApp</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1">
                <label className="mb-1 block text-xs font-medium text-slate-600">WhatsApp group</label>
                <select value={groupId} onChange={(e) => setGroupId(e.target.value)} className={input}>
                  <option value="">Select a saved group…</option>
                  {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <Button variant="primary" icon={Send} loading={sending} disabled={!msg.trim() || !groupId} onClick={doSend}>Post to group</Button>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="mb-2 text-xs font-medium text-slate-600">Saved groups</p>
              {groups.length === 0 ? <p className="mb-2 text-xs text-slate-400">No groups saved yet.</p> : (
                <ul className="mb-2 space-y-1">
                  {groups.map((g) => (
                    <li key={g.id} className="flex items-center gap-2 text-xs">
                      <span className="font-medium text-slate-700">{g.name}</span>
                      <span className="font-mono text-slate-400">{g.chat_id}</span>
                      <button onClick={() => delGroup(g.id)} className="text-slate-400 hover:text-red-600"><Trash2 size={13} /></button>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={addGroup} className="flex flex-wrap items-end gap-2">
                <input value={gName} onChange={(e) => setGName(e.target.value)} placeholder="Group name (e.g. ITS Parents 2026)" className={`${input} w-56`} />
                <input value={gChat} onChange={(e) => setGChat(e.target.value)} placeholder="Group ID (…@g.us)" className={`${input} w-56`} />
                <Button type="submit" variant="outline" icon={Plus} disabled={!gName.trim() || !gChat.trim()}>Add group</Button>
              </form>
              <p className="mt-1.5 text-[11px] text-slate-400">The group ID looks like <span className="font-mono">120363012345678901@g.us</span>. In Green API you get it from the group’s chat (getGroups / the chatId of a message from the group).</p>
            </div>
          </div>
        )}
      </Card>

      {/* SEND LOG */}
      {sends.length > 0 && (
        <Card className="mb-4">
          <h2 className="mb-2 text-sm font-semibold text-navy-800">Recent WhatsApp sends</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-xs uppercase text-slate-500"><tr>
                <th className="px-2 py-1 text-left">When</th><th className="px-2 py-1 text-left">Channel</th>
                <th className="px-2 py-1 text-left">Audience</th><th className="px-2 py-1 text-left">Message</th>
                <th className="px-2 py-1 text-right">Sent / Total</th><th className="px-2 py-1 text-center">Status</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {sends.map((s) => (
                  <tr key={s.id}>
                    <td className="px-2 py-1 whitespace-nowrap text-slate-500">{fmtDateTime(s.created_at)}</td>
                    <td className="px-2 py-1"><Badge tone={s.channel === 'wa_group' ? 'gold' : 'navy'}>{s.channel === 'wa_group' ? 'Group' : 'WhatsApp'}</Badge></td>
                    <td className="px-2 py-1 text-slate-600">{s.audience}</td>
                    <td className="px-2 py-1 max-w-[16rem] truncate text-slate-500" title={s.message}>{s.message}</td>
                    <td className="px-2 py-1 text-right text-slate-700">{s.sent}{s.failed ? ` (+${s.failed} failed)` : ''} / {s.total_recipients}</td>
                    <td className="px-2 py-1 text-center"><Badge tone={s.status === 'done' ? 'success' : 'gold'}>{s.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-2 flex justify-end"><Button variant="outline" icon={RefreshCw} onClick={loadAux}>Refresh log</Button></div>
        </Card>
      )}

      {/* NOTICES LIST */}
      <div className="mb-2 flex items-center gap-2">
        <Badge tone="navy">{list.length} notice{list.length === 1 ? '' : 's'}</Badge>
        <div className="flex-1" />
        <Button variant="outline" icon={RefreshCw} onClick={load}>Refresh</Button>
      </div>

      {loading ? <PageLoader label="Loading notices…" />
        : list.length === 0 ? <Card><p className="py-8 text-center text-sm text-slate-400">No notices yet. Post one above.</p></Card>
        : (
          <div className="space-y-2">
            {list.map((n) => (
              <Card key={n.id} className={n.is_active ? '' : 'opacity-60'}>
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-navy-800">{n.title}</span>
                      {n.is_active ? <Badge tone="success">visible</Badge> : <Badge tone="danger">hidden</Badge>}
                    </div>
                    {n.body && <p className="mt-1 text-sm text-slate-600 whitespace-pre-wrap">{n.body}</p>}
                    {n.attachment_url && (
                      <div className="mt-2">
                        {n.attachment_type === 'image'
                          ? <a href={asset(n.attachment_url)} target="_blank" rel="noreferrer"><img src={asset(n.attachment_url)} alt="attachment" className="max-h-32 rounded-md border border-slate-200" /></a>
                          : <a href={asset(n.attachment_url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-xs text-navy-700 hover:bg-slate-50"><FileText size={13} /> View PDF</a>}
                      </div>
                    )}
                    <p className="mt-1 text-[11px] text-slate-400">{new Date(n.posted_at).toLocaleString()}{n.posted_by_name ? ` · ${n.posted_by_name}` : ''}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button variant="outline" icon={MessageSquare} onClick={() => useNotice(n)}>Use in WhatsApp</Button>
                    <Button variant="outline" icon={n.is_active ? EyeOff : Eye} onClick={() => toggle(n)}>{n.is_active ? 'Hide' : 'Show'}</Button>
                    <Button variant="outline" icon={Trash2} onClick={() => remove(n)}>Delete</Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
    </AdminLayout>
  );
}
