// src/pages/Notices.jsx
// Post announcements to the public board (/pwa). Active notices are visible to
// the public; inactive ones are hidden but kept. SuperAdmin/Admin/Chairman.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, Eye, EyeOff } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { noticesApi } from '../api/client';

export default function Notices() {
  const { token } = useAuth();
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [flash, setFlash] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setFlash('');
    try { setList(await noticesApi.list(token, 'active')); }
    catch (e) { setFlash(e.message); }
    finally { setLoading(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true); setFlash('');
    try {
      await noticesApi.create(token, { year_id: 'active', title, body });
      setTitle(''); setBody(''); load();
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

  const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  return (
    <AdminLayout title="Notices" subtitle="Announcements shown on the public board. Active = visible to everyone.">
      {flash && <div className="mb-3 rounded-md border border-navy-200 bg-navy-50 px-3 py-2 text-sm text-navy-700">{flash}</div>}

      <Card className="mb-4">
        <form onSubmit={add} className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Title</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Prize distribution at 5pm in VKL Hall" className={input} />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">Details (optional)</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} placeholder="Any extra detail…" className={input} />
          </div>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" icon={Plus} loading={busy} disabled={!title.trim()}>Post notice</Button>
          </div>
        </form>
      </Card>

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
                    <p className="mt-1 text-[11px] text-slate-400">{new Date(n.posted_at).toLocaleString()}{n.posted_by_name ? ` · ${n.posted_by_name}` : ''}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
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
