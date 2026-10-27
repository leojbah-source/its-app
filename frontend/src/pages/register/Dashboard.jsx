// src/pages/register/Dashboard.jsx
// Parent home screen: shows deadline status, list of registered participants,
// and an Add Participant button (hidden once registration closes).

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, User, Users, CalendarDays, Clock, CheckCircle, ChevronRight, Radio } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import { portalApi } from './registerApi';
import RegisterLayout from './RegisterLayout';

// ── Deadline banner ───────────────────────────────────────────────────────────
function DeadlineBanner({ config }) {
  if (!config?.reg_deadline) return null;

  const deadline = new Date(config.reg_deadline);
  const now = new Date();
  const isPast = now > deadline;
  const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
  const formatted = deadline.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  if (isPast) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-slate-100 border border-slate-300 px-4 py-3 text-sm text-slate-600">
        <Clock size={16} className="shrink-0" />
        Registration closed on {formatted}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm border ${
      daysLeft <= 2 ? 'bg-red-50 border-red-200 text-red-700' :
      daysLeft <= 7 ? 'bg-amber-50 border-amber-200 text-amber-700' :
      'bg-emerald-50 border-emerald-200 text-emerald-700'
    }`}>
      <CalendarDays size={16} className="shrink-0" />
      <span>
        Registration deadline: <strong>{formatted}</strong>
        <span className="ml-1.5 font-medium">
          ({daysLeft} day{daysLeft !== 1 ? 's' : ''} left)
        </span>
      </span>
    </div>
  );
}

// ── Participant card ──────────────────────────────────────────────────────────
function ParticipantCard({ participant, maxEvents, onClick }) {
  const count = participant.active_event_count ?? 0;
  const full = maxEvents && count >= maxEvents;

  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-2xl bg-white border border-slate-200 shadow-sm hover:shadow-md hover:border-navy-300 active:scale-[0.99] transition-all p-5"
    >
      <div className="flex items-center gap-4">
        {/* Avatar */}
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-navy-100 shrink-0">
          <User size={22} className="text-navy-600" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-slate-900 text-base truncate">{participant.full_name}</p>
          <p className="text-sm text-slate-500 mt-0.5 truncate">
            {participant.age_group_label || participant.age_group_code || 'No group assigned'}
            {participant.school_name ? ` · ${participant.school_name}` : ''}
          </p>

          {/* Event count badge */}
          <div className="mt-2 flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              count > 0 ? 'bg-navy-100 text-navy-700' : 'bg-slate-100 text-slate-500'
            }`}>
              {count > 0 && <CheckCircle size={11} />}
              {count} event{count !== 1 ? 's' : ''}{maxEvents ? ` / ${maxEvents}` : ''}
            </span>
            {full && (
              <span className="text-xs text-amber-600 font-medium">Max reached</span>
            )}
          </div>
        </div>

        <ChevronRight size={18} className="text-slate-400 shrink-0" />
      </div>
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function Dashboard() {
  const { token, user } = useParentAuth();
  const navigate = useNavigate();
  const [participants, setParticipants] = useState([]);
  const [config, setConfig] = useState(null);
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cfg, parts, myTeams] = await Promise.all([
        portalApi.config(),
        portalApi.myParticipants(token),
        portalApi.myTeams(token).catch(() => []),
      ]);
      setConfig(cfg);
      setParticipants(parts);
      setTeams(Array.isArray(myTeams) ? myTeams : []);
    } catch (err) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const firstName = user?.full_name?.split(' ')[0] || 'there';
  const regOpen = config?.reg_deadline ? new Date() < new Date(config.reg_deadline) : true;
  // Team registration has its OWN (later) deadline — it must not be hidden when
  // individual registration closes. Falls back to open if no team deadline is set.
  const teamOpen = config?.team_reg_deadline ? new Date() < new Date(config.team_reg_deadline) : true;
  // Existing teams can be completed (members, CPR, payment) until the (later)
  // member deadline, even after NEW team registration has closed.
  const teamMemberDeadline = config?.team_member_deadline || config?.team_reg_deadline;
  const teamMemberOpen = teamMemberDeadline ? new Date() < new Date(teamMemberDeadline) : true;
  const hasTeams = teams.length > 0;

  return (
    <RegisterLayout title={`Hello, ${firstName}!`} subtitle="Manage your child's registrations">
      <div className="space-y-4">
        <DeadlineBanner config={config} />

        <button
          onClick={() => navigate('/live')}
          className="flex w-full items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-left hover:bg-amber-100 active:scale-[0.99] transition-all"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white"><Radio size={18} /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-navy-800">Live event progress</span>
            <span className="block text-[11px] text-slate-500">See where each group has reached on stage, by chest number</span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-amber-500" />
        </button>

        {loading ? (
          <div className="flex justify-center py-14">
            <div className="h-9 w-9 animate-spin rounded-full border-4 border-navy-200 border-t-navy-600" />
          </div>
        ) : error ? (
          <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}{' '}
            <button onClick={load} className="underline font-medium">Retry</button>
          </div>
        ) : participants.length === 0 ? (
          <div className="text-center py-14 text-slate-500">
            <User size={44} className="mx-auto mb-3 text-slate-300" />
            <p className="font-semibold text-slate-600 text-lg">No participants yet</p>
            <p className="text-sm mt-1.5">
              {regOpen
                ? 'Tap the button below to add your child.'
                : teamOpen
                  ? 'Individual registration has closed. You can still register team events below.'
                  : 'Registration has closed.'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {participants.map((p) => (
              <ParticipantCard
                key={p.id}
                participant={p}
                maxEvents={config?.max_individual_events}
                onClick={() => navigate(`/register/participant/${p.id}`)}
              />
            ))}
          </div>
        )}

        {/* Add participant — only while INDIVIDUAL registration is open */}
        {regOpen && (
          <button
            onClick={() => navigate('/register/add')}
            className="w-full flex items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-navy-300 py-5 text-navy-700 font-semibold hover:bg-navy-50 active:bg-navy-100 transition-colors"
          >
            <Plus size={20} />
            Add Participant
          </button>
        )}

        {/* Manage existing teams — available while the member deadline is open,
            even after NEW team registration has closed, so leaders can add the
            remaining members, upload CPR copies and pay. */}
        {hasTeams && (
          <button
            onClick={() => navigate('/register/team')}
            className="flex w-full items-center gap-3 rounded-2xl border border-navy-200 bg-navy-50 px-4 py-4 text-left hover:bg-navy-100 active:scale-[0.99] transition-all"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-navy-600 text-white"><Users size={20} /></span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-navy-800">Manage my team{teams.length > 1 ? 's' : ''} ({teams.length})</span>
              <span className="block text-[11px] text-slate-500">
                {teamMemberOpen
                  ? 'Add remaining members, upload CPR copies and pay the team fee'
                  : 'View your team details'}
              </span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-navy-500" />
          </button>
        )}

        {/* Team Event Entry — follows the SEPARATE team deadline, so it stays
            available after individual registration has closed. */}
        {teamOpen && (
          <>
          <button
            onClick={() => navigate('/register/team')}
            className="w-full rounded-2xl border-2 border-dashed border-navy-300 bg-navy-50 py-4 text-base font-semibold text-navy-700 hover:bg-navy-100 active:bg-navy-200 transition-colors"
          >
            Team Event Entry →
          </button>
          <p className="text-xs text-slate-400 text-center -mt-2">
            Register or manage teams here{regOpen ? ' · Individual events above' : ' (individual registration has closed)'}
          </p>
          </>
        )}
      </div>
    </RegisterLayout>
  );
}
