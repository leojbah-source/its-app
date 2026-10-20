// src/pages/judging/JudgeInvitePublic.jsx
// Public, no-login judge-invitation generator. Reached via a shareable link
// that carries a secret key (?k=...). Fetches only non-sensitive branding +
// still-to-be-judged sessions from /api/public/judge-invite. The form, preview
// and download live in JudgeInviteBuilder (shared with the admin page).
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { publicApi } from '../../api/client';
import JudgeInviteBuilder from './JudgeInviteBuilder';

export default function JudgeInvitePublic() {
  const [sp] = useSearchParams();
  const key = sp.get('k') || '';
  const [rows, setRows] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!key) { setErr('This link is missing its key.'); setReady(true); return; }
    publicApi.judgeInvite(key)
      .then((d) => { setRows(d.sessions || []); setCfg(d.config || null); })
      .catch((e) => setErr(e.message || 'This link is not valid.'))
      .finally(() => setReady(true));
  }, [key]);

  if (ready && err && rows.length === 0 && !cfg) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
        <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
          <h1 className="mb-2 text-lg font-semibold text-navy-800">Judge Invitation</h1>
          <p className="text-sm text-slate-600">{err}</p>
          <p className="mt-3 text-xs text-slate-400">Please ask the Organizing Committee for the correct link.</p>
        </div>
      </div>
    );
  }

  return <JudgeInviteBuilder rows={rows} cfg={cfg} loadError={err} />;
}
