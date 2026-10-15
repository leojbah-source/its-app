// Year Setup → upload the reviewed Initial Participants List PDF per age group.
// These populate the public "Initial Participants List" card (one link per group).
import { useEffect, useState } from 'react';
import { ListChecks, Upload, Check, Trash2 } from 'lucide-react';
import { Card } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { listsApi, yearConfigApi } from '../../api/client';
import { useAuth } from '../../context/AuthContext';

export default function BoardListsCard() {
  const { token } = useAuth();
  const [groups, setGroups] = useState([]);
  const [files, setFiles] = useState({});        // code -> { label, url }
  const [title, setTitle] = useState('Final Participants List');
  const [uploading, setUploading] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    listsApi.boardFiles(token)
      .then((d) => {
        setGroups(d.groups || []);
        if (d.title) setTitle(d.title);
        const m = {};
        (d.files || []).forEach((f) => { m[f.code] = { label: f.label, url: f.url }; });
        setFiles(m);
      })
      .catch((e) => setErr(e.message || 'Could not load the age groups.'));
  }, [token]);

  const labelFor = (g) => (g.label ? `${g.label} (${g.code})` : g.code);

  async function onUpload(g, file) {
    if (!file) return;
    setUploading(g.code); setErr(''); setMsg('');
    try {
      const r = await yearConfigApi.uploadAsset(token, 'list_file', file);
      setFiles((m) => ({ ...m, [g.code]: { label: labelFor(g), url: r.url } }));
    } catch (e) { setErr(e.message || 'Upload failed.'); }
    finally { setUploading(null); }
  }
  function clearOne(code) { setFiles((m) => { const n = { ...m }; delete n[code]; return n; }); }

  async function save() {
    setSaving(true); setErr(''); setMsg('');
    try {
      const arr = groups.filter((g) => files[g.code]?.url)
        .map((g) => ({ code: g.code, label: files[g.code].label || labelFor(g), url: files[g.code].url }));
      const r = await listsApi.saveBoardFiles(token, arr, title.trim() || 'Participants List');
      setMsg(`Saved — ${r.files.length} list${r.files.length === 1 ? '' : 's'} now shown on the PWA board.`);
    } catch (e) { setErr(e.message || 'Could not save.'); }
    finally { setSaving(false); }
  }

  return (
    <Card title="Participants List (PWA board)">
      <p className="mb-3 text-xs text-slate-500">
        Upload the reviewed participant-list PDF for each age group. They appear under the heading below on the
        public board, one tappable link per group. Download &amp; check them first from
        <b> Lists &rarr; Download final lists</b>. Leave a group empty to omit it; then click Save.
      </p>
      <label className="mb-3 block">
        <span className="mb-1 block text-xs font-medium text-slate-600">Heading shown on the public board</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80}
               placeholder="e.g. Final Participants List"
               className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
      </label>
      {err && <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</p>}
      {msg && <p className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{msg}</p>}
      <div className="space-y-2">
        {groups.length === 0 && <p className="text-xs text-slate-400">No age groups configured yet.</p>}
        {groups.map((g) => (
          <div key={g.code} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
            <span className="w-44 shrink-0 text-sm font-medium text-slate-700">{labelFor(g)}</span>
            {files[g.code]?.url ? (
              <>
                <a href={files[g.code].url} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><Check size={13} /> Uploaded — view</a>
                <button onClick={() => clearOne(g.code)}
                   className="ml-auto inline-flex items-center gap-1 text-xs text-slate-400 hover:text-red-500"><Trash2 size={12} /> Remove</button>
              </>
            ) : (
              <label className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-navy-700 hover:bg-slate-50">
                <Upload size={12} /> {uploading === g.code ? 'Uploading…' : 'Upload PDF'}
                <input type="file" accept=".pdf" className="hidden"
                       onChange={(e) => onUpload(g, e.target.files?.[0])} disabled={uploading === g.code} />
              </label>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3">
        <Button size="sm" variant="primary" icon={ListChecks} loading={saving} onClick={save}>Save to PWA board</Button>
      </div>
    </Card>
  );
}
