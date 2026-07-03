// src/pages/register/ParticipantDetail.jsx
// Main event selection + teacher names page for a participant.
//
// States:
//   Before reg_deadline:         full event add/remove + teacher names
//   After reg_deadline but
//     before teacher_deadline:   events read-only, teacher names editable
//   After teacher_deadline:      fully read-only

import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  CheckSquare, Square, Clock, AlertCircle, CheckCircle2, Save, BanknoteIcon,
} from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import { portalApi } from './registerApi';
import RegisterLayout from './RegisterLayout';
import PaymentSection from './PaymentSection';

// ── Small helpers ─────────────────────────────────────────────────────────────
function Spinner() {
  return (
    <div className="flex justify-center py-14">
      <div className="h-9 w-9 animate-spin rounded-full border-4 border-navy-200 border-t-navy-600" />
    </div>
  );
}

function Alert({ variant = 'info', children }) {
  const styles = {
    info:    'bg-blue-50 border-blue-200 text-blue-700',
    warn:    'bg-amber-50 border-amber-200 text-amber-700',
    danger:  'bg-red-50 border-red-200 text-red-700',
    success: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    muted:   'bg-slate-100 border-slate-300 text-slate-600',
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${styles[variant]}`}>
      {variant === 'warn' || variant === 'danger' ? <AlertCircle size={16} className="mt-0.5 shrink-0" /> :
       variant === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> :
       <Clock size={16} className="mt-0.5 shrink-0" />}
      <span>{children}</span>
    </div>
  );
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ── Event card ────────────────────────────────────────────────────────────────
function EventCard({ event, selected, canToggle, onToggle }) {
  return (
    <button
      onClick={canToggle ? onToggle : undefined}
      disabled={!canToggle && !selected}
      className={`w-full text-left rounded-xl border p-4 transition-all ${
        selected
          ? 'bg-navy-50 border-navy-300 shadow-sm'
          : canToggle
            ? 'bg-white border-slate-200 hover:border-navy-300 active:bg-slate-50'
            : 'bg-slate-50 border-slate-200 opacity-40 cursor-not-allowed'
      }`}
    >
      <div className="flex items-center gap-3">
        <div className={`shrink-0 ${selected ? 'text-navy-600' : 'text-slate-300'}`}>
          {selected ? <CheckSquare size={22} /> : <Square size={22} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-slate-800 text-sm">{event.event_name}</span>
            <span className="text-[10px] font-mono bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
              {event.event_code}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {event.category_name || '—'} · {event.event_kind}
          </p>
        </div>
      </div>
    </button>
  );
}

// ── Payment summary ───────────────────────────────────────────────────────────
// ── Teacher name row ──────────────────────────────────────────────────────────
function TeacherRow({ label, value, onChange, onSave, saving, readOnly }) {
  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={onChange}
        placeholder={label}
        readOnly={readOnly}
        className={`flex-1 rounded-lg border px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-400 ${
          readOnly ? 'bg-slate-50 text-slate-500 cursor-default' : 'border-slate-300 bg-white'
        }`}
      />
      {!readOnly && (
        <button
          onClick={onSave}
          disabled={saving || !value.trim()}
          className="rounded-lg bg-navy-700 px-3 py-2.5 text-white text-xs font-semibold disabled:opacity-40 hover:bg-navy-800 active:bg-navy-900 transition-colors flex items-center gap-1"
          aria-label={`Save ${label}`}
        >
          {saving ? (
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          ) : (
            <Save size={14} />
          )}
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ParticipantDetail() {
  const { id } = useParams();
  const { token } = useParentAuth();
  const navigate = useNavigate();

  const [participant, setParticipant] = useState(null);
  const [events, setEvents] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Event selection state
  // savedIds = what's in DB right now (non-withdrawn registrations)
  // selectedIds = what the user currently has checked (may differ)
  const [savedIds, setSavedIds] = useState(new Set());
  const [selectedIds, setSelectedIds] = useState(new Set());

  // Teacher names: { [eventId]: { dance_teacher: '', music_teacher: '', reg_id } }
  const [teachers, setTeachers] = useState({});
  const [teacherSaving, setTeacherSaving] = useState({}); // { `${eventId}_dance`: bool }
  const [teacherSaved, setTeacherSaved] = useState({});   // flash success

  // Events save state
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [removalReason, setRemovalReason] = useState('');

  // ── Load ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [cfg, part] = await Promise.all([
        portalApi.config(),
        portalApi.participantGet(token, id),
      ]);
      setConfig(cfg);
      setParticipant(part);

      const evs = await portalApi.events(part.age_group_id);
      setEvents(evs);

      const activeRegs = (part.registrations || []).filter(
        (r) => r.status !== 'withdrawn' && r.status !== 'swapped',
      );
      const ids = new Set(activeRegs.map((r) => r.event_id));
      setSavedIds(new Set(ids));
      setSelectedIds(new Set(ids));

      const tmap = {};
      activeRegs.forEach((r) => {
        tmap[r.event_id] = {
          reg_id: r.id,
          dance_teacher: r.dance_teacher || '',
          music_teacher: r.music_teacher || '',
        };
      });
      setTeachers(tmap);
    } catch (err) {
      setError(err.message || 'Failed to load participant data');
    } finally {
      setLoading(false);
    }
  }, [token, id]);

  useEffect(() => { load(); }, [load]);

  // ── Deadline flags ──────────────────────────────────────────────────────
  const regDeadlinePassed     = config?.reg_deadline          ? new Date() > new Date(config.reg_deadline)          : false;
  const teacherDeadlinePassed = config?.teacher_name_deadline ? new Date() > new Date(config.teacher_name_deadline) : false;
  const maxEvents = config?.max_individual_events ?? null;

  // ── Toggle event ────────────────────────────────────────────────────────
  function toggleEvent(eventId) {
    if (regDeadlinePassed) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        if (maxEvents !== null && next.size >= maxEvents) return prev; // cap
        next.add(eventId);
      }
      return next;
    });
  }

  const isDirty =
    [...selectedIds].some((eid) => !savedIds.has(eid)) ||
    [...savedIds].some((eid) => !selectedIds.has(eid));

  const pendingRemovals = [...savedIds].filter((eid) => !selectedIds.has(eid)).length;

  // ── Save event selection ────────────────────────────────────────────────
  async function handleSaveEvents() {
    if (!isDirty || saving) return;
    const add_event_ids    = [...selectedIds].filter((eid) => !savedIds.has(eid));
    const remove_event_ids = [...savedIds].filter((eid) => !selectedIds.has(eid));

    // Removals require a reason — it goes on the formal refund record.
    if (remove_event_ids.length > 0 && !removalReason.trim()) {
      setSaveError('Please enter a reason for removing events — this is recorded with your refund request.');
      return;
    }

    setSaving(true);
    setSaveError('');
    setSaveSuccess(false);
    try {
      await portalApi.eventsUpdate(token, id, {
        add_event_ids, remove_event_ids,
        removal_reason: remove_event_ids.length > 0 ? removalReason.trim() : undefined,
      });
      setSavedIds(new Set(selectedIds));
      setRemovalReason('');
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
      load(); // refresh to get fresh registration IDs for teacher names
    } catch (err) {
      setSaveError(err.message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ── Save teacher name ───────────────────────────────────────────────────
  async function handleSaveTeacher(eventId, teacherType) {
    const name = teachers[eventId]?.[`${teacherType}_teacher`]?.trim();
    if (!name) return;
    const key = `${eventId}_${teacherType}`;
    setTeacherSaving((prev) => ({ ...prev, [key]: true }));
    try {
      await portalApi.teacherUpdate(token, id, {
        event_id: eventId,
        teacher_type: teacherType,
        teacher_name: name,
      });
      setTeacherSaved((prev) => ({ ...prev, [key]: true }));
      setTimeout(() => setTeacherSaved((prev) => ({ ...prev, [key]: false })), 2500);
    } catch (err) {
      alert(`Could not save teacher name: ${err.message}`);
    } finally {
      setTeacherSaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  function setTeacherField(eventId, field, value) {
    setTeachers((prev) => ({
      ...prev,
      [eventId]: { ...(prev[eventId] || {}), [field]: value },
    }));
  }

  // ── Render guards ────────────────────────────────────────────────────────
  if (loading) return (
    <RegisterLayout showBack backTo="/register/dashboard">
      <Spinner />
    </RegisterLayout>
  );
  if (error) return (
    <RegisterLayout title="Error" showBack backTo="/register/dashboard">
      <Alert variant="danger">{error} — <button onClick={load} className="underline">Retry</button></Alert>
    </RegisterLayout>
  );

  const selectedCount  = selectedIds.size;
  const atMax          = maxEvents !== null && selectedCount >= maxEvents;

  // Active (saved) event IDs, for the teacher-names section
  const activeEventIds = [...savedIds];

  return (
    <RegisterLayout
      title={participant?.full_name}
      subtitle={[participant?.age_group_label || participant?.age_group_code, participant?.school_name]
        .filter(Boolean).join(' · ')}
      showBack
      backTo="/register/dashboard"
    >
      <div className="space-y-6">
        {/* ── Deadline pills ─────────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-2">
          {config?.reg_deadline && (
            <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full font-medium border ${
              regDeadlinePassed
                ? 'bg-slate-100 text-slate-500 border-slate-200'
                : 'bg-amber-50 text-amber-700 border-amber-200'
            }`}>
              <Clock size={11} />
              Reg. deadline: {fmtDate(config.reg_deadline)}{regDeadlinePassed ? ' (closed)' : ''}
            </span>
          )}
          {config?.teacher_name_deadline && (
            <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1 rounded-full font-medium border ${
              teacherDeadlinePassed
                ? 'bg-slate-100 text-slate-500 border-slate-200'
                : 'bg-blue-50 text-blue-700 border-blue-200'
            }`}>
              <Clock size={11} />
              Teacher names: {fmtDate(config.teacher_name_deadline)}{teacherDeadlinePassed ? ' (closed)' : ''}
            </span>
          )}
        </div>

        {/* ── Event selection ─────────────────────────────────────────────── */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-slate-800 text-base">Events</h2>
            <span className={`text-sm font-semibold rounded-full px-3 py-1 ${
              atMax ? 'bg-red-100 text-red-700' : 'bg-navy-100 text-navy-700'
            }`}>
              {selectedCount}{maxEvents ? ` / ${maxEvents}` : ''}
            </span>
          </div>

          {regDeadlinePassed ? (
            <Alert variant="muted">
              Registration is closed — event selection is locked.
            </Alert>
          ) : atMax && (
            <Alert variant="warn">
              Maximum {maxEvents} events reached. Deselect one to choose a different event.
            </Alert>
          )}

          {events.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-8">
              No events available for this age group.
            </p>
          ) : (
            <div className="space-y-2 mt-3">
              {events.map((ev) => {
                const isSelected = selectedIds.has(ev.id);
                const canToggle  = !regDeadlinePassed && (isSelected || !atMax);
                return (
                  <EventCard
                    key={ev.id}
                    event={ev}
                    selected={isSelected}
                    canToggle={canToggle}
                    onToggle={() => toggleEvent(ev.id)}
                  />
                );
              })}
            </div>
          )}

          {/* Save button — shown when there are unsaved changes */}
          {isDirty && !regDeadlinePassed && (
            <div className="mt-4 space-y-2">
              {pendingRemovals > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Reason for removing {pendingRemovals} event{pendingRemovals > 1 ? 's' : ''} (required — recorded with your refund request)
                  </label>
                  <textarea
                    value={removalReason}
                    onChange={(e) => setRemovalReason(e.target.value)}
                    rows={2}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-navy-500 focus:outline-none"
                    placeholder="e.g. schedule clash, child unavailable…"
                  />
                </div>
              )}
              {saveError && <Alert variant="danger">{saveError}</Alert>}
              <button
                onClick={handleSaveEvents}
                disabled={saving}
                className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 disabled:opacity-60 transition-colors"
              >
                {saving ? 'Saving…' : 'Save Event Selection'}
              </button>
            </div>
          )}

          {saveSuccess && (
            <Alert variant="success">Events saved successfully!</Alert>
          )}
        </section>

        {/* ── Fees & payment (live from server) ───────────────────────────── */}
        {activeEventIds.length > 0 && (
          <PaymentSection
            token={token}
            participantId={id}
            config={config}
            refreshKey={savedIds.size}
          />
        )}

        {/* ── Teacher names ────────────────────────────────────────────────── */}
        {activeEventIds.length > 0 && (
          <section>
            <h2 className="font-semibold text-slate-800 text-base mb-3">Teacher Names</h2>

            {teacherDeadlinePassed ? (
              <Alert variant="muted">Teacher name submission is closed.</Alert>
            ) : (
              <p className="text-xs text-slate-500 mb-3">
                Enter the name of the teacher who prepared your child for each event.
                Tap <strong>Save</strong> after each entry.
              </p>
            )}

            <div className="space-y-3">
              {activeEventIds.map((eventId) => {
                const ev = events.find((e) => e.id === eventId);
                if (!ev) return null;

                const t = teachers[eventId] || {};
                const cat = (ev.category_name || '').toLowerCase();
                const isDance = cat.includes('dance');
                const isMusic = cat.includes('music');
                // If category is unrecognized, show both fields
                const showDance = isDance || (!isDance && !isMusic);
                const showMusic = isMusic || (!isDance && !isMusic);

                return (
                  <div key={eventId} className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
                    <div>
                      <p className="font-medium text-sm text-slate-700">{ev.event_name}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {ev.category_name} · {ev.event_code}
                      </p>
                    </div>

                    {showDance && (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">
                          Dance teacher
                        </label>
                        <TeacherRow
                          label="Dance teacher name"
                          value={t.dance_teacher || ''}
                          onChange={(e) => setTeacherField(eventId, 'dance_teacher', e.target.value)}
                          onSave={() => handleSaveTeacher(eventId, 'dance')}
                          saving={teacherSaving[`${eventId}_dance`]}
                          readOnly={teacherDeadlinePassed}
                        />
                        {teacherSaved[`${eventId}_dance`] && (
                          <p className="text-xs text-emerald-600 mt-1">✓ Saved</p>
                        )}
                      </div>
                    )}

                    {showMusic && (
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">
                          Music teacher
                        </label>
                        <TeacherRow
                          label="Music teacher name"
                          value={t.music_teacher || ''}
                          onChange={(e) => setTeacherField(eventId, 'music_teacher', e.target.value)}
                          onSave={() => handleSaveTeacher(eventId, 'music')}
                          saving={teacherSaving[`${eventId}_music`]}
                          readOnly={teacherDeadlinePassed}
                        />
                        {teacherSaved[`${eventId}_music`] && (
                          <p className="text-xs text-emerald-600 mt-1">✓ Saved</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </RegisterLayout>
  );
}
