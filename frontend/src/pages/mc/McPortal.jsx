// src/pages/mc/McPortal.jsx
// MC portal (staff MC role). Assigned per (event + age group): the MC sees each
// assigned event · group as its own entry → MC SCRIPT (judges' bios + criteria +
// timing) and Participants (chest numbers WITH names, in chest order) for THAT
// group. When the Timer finishes a chest it shows a green ✓ + "call next" banner.
import { useEffect, useState, useCallback, useRef } from 'react';
import { Mic, LogOut, ChevronLeft, Users, ScrollText } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { mcApi } from '../../api/client';

const mmss = (s) => (s == null ? '—' : `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}`);
const selKey = (e) => `${e.event_id}:${e.age_group_id}`;

export default function McPortal() {
  const { token, user, logout } = useAuth();
  const [events, setEvents] = useState([]);
  const [sel, setSel] = useState(null);          // selected (event + group) row
  const [tab, setTab] = useState('script');
  const [script, setScript] = useState(null);
  const [groups, setGroups] = useState(null);    // grouped participants [{age_group, participants}]
  const [flash, setFlash] = useState('');
  const [doneBanner, setDoneBanner] = useState('');
  const prevDone = useRef(new Set());

  const mcGroup = sel?.age_group_code || null;

  useEffect(() => {
    mcApi.myEvents(token).then((evs) => { setEvents(evs); if (evs.length === 1) setSel(evs[0]); }).catch((e) => setFlash(e.message));
  }, [token]);

  const loadScript = useCallback(() => { if (sel) mcApi.script(token, sel.event_id).then(setScript).catch((e) => setFlash(e.message)); }, [token, sel]);
  const loadParticipants = useCallback(async () => {
    if (!sel) return;
    try {
      const gs = await mcApi.participants(token, sel.event_id);
      setGroups(gs);
      const g = gs.find((x) => x.age_group === mcGroup);
      const nowDone = new Set((g?.participants || []).filter((p) => p.done).map((p) => p.chest_number));
      const newly = [...nowDone].filter((c) => !prevDone.current.has(c));
      if (prevDone.current.size > 0 && newly.length > 0) setDoneBanner(`Chest ${newly.sort((a, b) => a - b).join(', ')} finished — call the next number.`);
      prevDone.current = nowDone;
    } catch (e) { setFlash(e.message); }
  }, [token, sel, mcGroup]);

  useEffect(() => { if (sel) { setScript(null); setGroups(null); setTab('script'); prevDone.current = new Set(); setDoneBanner(''); loadScript(); } }, [sel, loadScript]);
  useEffect(() => {
    if (tab !== 'participants' || !sel) return;
    loadParticipants();
    const iv = setInterval(loadParticipants, 5000);
    return () => clearInterval(iv);
  }, [tab, sel, loadParticipants]);

  const groupData = groups?.find((g) => g.age_group === mcGroup);

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="sticky top-0 z-20 flex items-center justify-between bg-navy-800 px-4 py-3 text-white">
        <div className="flex items-center gap-2"><Mic size={20} className="text-gold-400" /><span className="font-semibold">MC Portal</span></div>
        <div className="flex items-center gap-3 text-sm"><span className="text-navy-200">{user?.full_name || user?.name}</span>
          <button onClick={logout} className="inline-flex items-center gap-1 text-navy-100 hover:text-white"><LogOut size={16} /> Sign out</button></div>
      </header>

      <main className="mx-auto max-w-3xl p-4">
        {flash && <div className="mb-3 rounded-md border border-navy-200 bg-white px-3 py-2 text-sm text-navy-700">{flash}</div>}

        {!sel ? (
          <div className="space-y-2">
            <h1 className="mb-2 text-lg font-semibold text-navy-900">Your events</h1>
            {events.length === 0 && <p className="py-8 text-center text-sm text-slate-500">No event/age group assigned to you yet.</p>}
            {events.map((e) => (
              <button key={selKey(e)} onClick={() => setSel(e)} className="flex w-full items-center justify-between rounded-xl bg-white p-4 text-left shadow-sm hover:bg-slate-50">
                <div><div className="font-medium text-navy-800"><span className="font-mono text-xs text-navy-500 mr-1.5">{e.event_code}</span>{e.event_name}
                  {e.age_group_code && <span className="ml-2 rounded bg-navy-50 px-1.5 py-0.5 text-[10px] font-semibold text-navy-700">{e.age_group_code}</span>}</div>
                <div className="text-xs text-slate-500">{e.category_name}</div></div>
                <ChevronLeft className="rotate-180 text-slate-400" size={18} />
              </button>
            ))}
          </div>
        ) : (
          <div>
            {events.length > 1 && <button onClick={() => setSel(null)} className="mb-3 inline-flex items-center gap-1 text-sm text-navy-600 hover:underline"><ChevronLeft size={16} /> Events</button>}
            <div className="mb-3 rounded-xl bg-navy-700 p-3 text-white">
              <div className="text-xs uppercase tracking-wide text-navy-200">{sel.category_name}</div>
              <div className="font-semibold"><span className="font-mono text-sm text-navy-200 mr-1.5">{sel.event_code}</span>{sel.event_name}
                <span className="ml-2 rounded-full bg-gold-500 px-2 py-0.5 text-xs font-semibold">{sel.age_group_code}</span></div>
            </div>

            <div className="mb-3 flex gap-1 rounded-lg bg-white p-1 shadow-sm">
              <button onClick={() => setTab('script')} className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${tab === 'script' ? 'bg-navy-600 text-white' : 'text-slate-600'}`}><ScrollText size={15} className="mr-1 inline" /> MC Script</button>
              <button onClick={() => setTab('participants')} className={`flex-1 rounded-md px-3 py-2 text-sm font-medium ${tab === 'participants' ? 'bg-navy-600 text-white' : 'text-slate-600'}`}><Users size={15} className="mr-1 inline" /> Participants</button>
            </div>

            {tab === 'script' ? <Script data={script} /> : (
              !groups ? <p className="py-8 text-center text-sm text-slate-500">Loading…</p>
              : (
                <div>
                  {doneBanner && (
                    <div className="mb-3 flex items-center justify-between rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800">
                      <span>{doneBanner}</span>
                      <button onClick={() => setDoneBanner('')} className="text-xs text-green-700 hover:underline">Dismiss</button>
                    </div>
                  )}
                  {!groupData || groupData.participants.length === 0
                    ? <p className="rounded-lg bg-white p-4 text-sm text-slate-500 shadow-sm">No chest numbers assigned for {mcGroup} yet.</p>
                    : (
                      <div className="rounded-xl bg-white p-3 shadow-sm">
                        <div className="divide-y divide-slate-100">
                          {groupData.participants.map((p) => (
                            <div key={p.chest_number} className="flex items-center gap-3 px-1 py-2">
                              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-100 font-mono text-base font-bold text-navy-800">{p.chest_number}</span>
                              <span className={`text-base ${p.done ? 'text-slate-400 line-through' : 'text-slate-800'}`}>{p.name}</span>
                              {p.done && <span className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-green-600">✓ done</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}

function Script({ data }) {
  if (!data) return <p className="py-8 text-center text-sm text-slate-500">Loading script…</p>;
  const ev = data.event || {}; const sc = data.schedule || {};
  const criteria = [...(data.criteria || [])].sort((a, b) => a.sequence_order - b.sequence_order);
  return (
    <div className="space-y-3">
      <ScriptCard title="Welcome">
        <p>Ladies &amp; gentlemen and dear children — <b>good evening</b>. On behalf of KCA and the Organizing Committee, it is my pleasure to welcome you to {data.year?.event_year_label || 'the Indian Talent Scan'}. Today we conduct <b>{ev.event_name}</b>{ev.category_name ? ` (${ev.category_name})` : ''}{sc.venue ? ` at ${sc.venue}` : ''}.</p>
        <p className="mt-2 text-slate-500">Please encourage all participants, keep silence during performances, and keep phones on silent.</p>
      </ScriptCard>
      <ScriptCard title="Introducing our judges">
        {(data.judges || []).length === 0 ? <p className="text-slate-400">No judges assigned yet.</p> : (
          <div className="space-y-3">
            <p>We are honoured to have {data.judges.length} eminent {data.judges.length === 1 ? 'judge' : 'judges'} with us today:</p>
            {data.judges.map((j, i) => (
              <div key={i} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="font-semibold text-navy-800">{j.full_name}</div>
                <p className="mt-0.5 whitespace-pre-line text-sm text-slate-600">{j.detailed_bio || j.bio || 'Bio to be added.'}</p>
              </div>
            ))}
            <p className="text-slate-500">Please join me in giving them a warm welcome.</p>
          </div>
        )}
      </ScriptCard>
      <ScriptCard title="Judging criteria">
        <div className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {criteria.map((c, i) => (<div key={i} className="flex items-center justify-between px-3 py-2 text-sm"><span><b className="text-navy-700">C{i + 1}</b> {c.label}</span><span className="font-mono text-slate-500">{c.max_score}</span></div>))}
          {criteria.length === 0 && <p className="px-3 py-2 text-sm text-slate-400">No criteria set.</p>}
        </div>
      </ScriptCard>
      {ev.is_stage_event && <ScriptCard title="Timing"><p>Time allowed: <b>{mmss(ev.allotted_time_seconds)}</b>. Yellow light {mmss(ev.yellow_alert_seconds)} before the end; red light at time-up; grace {mmss(ev.grace_period_seconds)}.</p></ScriptCard>}
      {data.year?.sponsor_name && <ScriptCard title="Sponsors"><p>This event is made possible with the support of <b>{data.year.sponsor_name}</b> and our sponsors. Kindly support and patronize them.</p></ScriptCard>}
      <ScriptCard title="Let the contest begin"><p>Every one of you is talented and deserves to win — but remember, today's performance matters most. Give your very best. Now, <b>let the contest begin!</b></p></ScriptCard>
    </div>
  );
}

function ScriptCard({ title, children }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm">
      <h2 className="mb-1.5 text-sm font-semibold uppercase tracking-wide text-gold-600">{title}</h2>
      <div className="text-sm leading-relaxed text-slate-700">{children}</div>
    </div>
  );
}
