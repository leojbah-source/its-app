// src/pages/judging/JudgeInvite.jsx
// Admin page for the judge-invitation generator. Loads the schedule + branding
// with the signed-in user's token, hides completed sessions, and shows the
// shareable no-login link for the people finalising judges. The form, preview
// and download live in JudgeInviteBuilder (shared with the public page).
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { judgesApi, yearConfigApi } from '../../api/client';
import JudgeInviteBuilder from './JudgeInviteBuilder';

// A session is "completed" (hidden) once results are published for it or its
// date has passed — same rule the public endpoint applies server-side.
function notCompleted(r) {
  if (r.results_published) return false;
  if (r.event_date) {
    const d = new Date(r.event_date); const today = new Date(); today.setHours(0, 0, 0, 0);
    if (!isNaN(d) && d < today) return false;
  }
  return true;
}

export default function JudgeInvite() {
  const { token } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    judgesApi.eventAssignments(token).then((d) => setRows((d || []).filter(notCompleted))).catch((e) => setErr(e.message));
    yearConfigApi.get(token).then(setCfg).catch(() => {});
  }, [token]);

  const shareLink = cfg?.invite_tool_key
    ? `${window.location.origin}/invite/judges?k=${cfg.invite_tool_key}`
    : '';

  return (
    <JudgeInviteBuilder
      rows={rows}
      cfg={cfg}
      onBack={() => navigate('/admin/judging/judges')}
      shareLink={shareLink}
      loadError={err}
    />
  );
}
