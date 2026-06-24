// src/pages/registrations/RegistrationDrawer.jsx
// Slide-over drawer showing a single registration's details.
// Also allows admin to change status or update teacher names.

import { useState } from 'react';
import { X, User, School, Calendar, Tag } from 'lucide-react';
import Button from '../../components/ui/Button';
import { Badge } from '../../components/ui/Card';
import { registrationsApi } from '../../api/client';

const STATUS_TONE = {
  registered: 'navy',
  attended:   'success',
  absent:     'danger',
  withdrawn:  'slate',
  swapped:    'gold',
};

const STATUS_OPTIONS = ['registered', 'attended', 'absent', 'withdrawn'];

function Field({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm text-slate-800 font-medium">{value || '—'}</p>
    </div>
  );
}

export default function RegistrationDrawer({ registration, token, onClose, onUpdated }) {
  const [editMode,      setEditMode]      = useState(false);
  const [status,        setStatus]        = useState(registration?.status || '');
  const [danceTeacher,  setDanceTeacher]  = useState(registration?.dance_teacher || '');
  const [musicTeacher,  setMusicTeacher]  = useState(registration?.music_teacher || '');
  const [saving,        setSaving]        = useState(false);
  const [error,         setError]         = useState('');

  if (!registration) return null;

  const reg = registration;

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const updated = await registrationsApi.update(token, reg.id, {
        status:        status        || undefined,
        dance_teacher: danceTeacher  || undefined,
        music_teacher: musicTeacher  || undefined,
      });
      onUpdated(updated);
      setEditMode(false);
    } catch (err) {
      setError(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative z-50 flex h-full w-full max-w-md flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              {reg.participant_name}
            </h2>
            <p className="text-xs text-slate-500 font-mono">{reg.cpr_number}</p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-slate-100">
            <X size={20} className="text-slate-500" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">

          {/* Participant info */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3 flex items-center gap-2">
              <User size={12} /> Participant
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Gender" value={reg.gender} />
              <Field label="Age Group" value={reg.age_group_label
                ? `${reg.age_group_code} — ${reg.age_group_label}` : reg.age_group_code} />
              <Field label="School" value={reg.school_name} />
              <Field label="DOB" value={reg.dob
                ? new Date(reg.dob).toLocaleDateString() : null} />
            </div>
          </section>

          {/* Event info */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3 flex items-center gap-2">
              <Tag size={12} /> Event
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Event Code" value={reg.event_code} />
              <Field label="Event"      value={reg.event_name} />
              <Field label="Category"  value={reg.category_name} />
              <Field label="Type">
                {reg.event_kind && (
                  <Badge tone={reg.event_kind === 'team' ? 'gold' : 'navy'}>
                    {reg.event_kind === 'team' ? 'Team' : 'Individual'}
                  </Badge>
                )}
              </Field>
            </div>
          </section>

          {/* Status & Teachers */}
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-3 flex items-center gap-2">
              <Calendar size={12} /> Registration
            </h3>

            {editMode ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Status</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Dance Teacher</label>
                  <input
                    value={danceTeacher}
                    onChange={(e) => setDanceTeacher(e.target.value)}
                    placeholder="Name or NOT_APPLICABLE"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-600 mb-1">Music Teacher</label>
                  <input
                    value={musicTeacher}
                    onChange={(e) => setMusicTeacher(e.target.value)}
                    placeholder="Name or NOT_APPLICABLE"
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                {error && <p className="text-sm text-red-600">{error}</p>}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide">Status</p>
                  <Badge tone={STATUS_TONE[reg.status] || 'slate'}>
                    {reg.status ? reg.status.charAt(0).toUpperCase() + reg.status.slice(1) : '—'}
                  </Badge>
                </div>
                <Field label="Registered At" value={reg.registered_at
                  ? new Date(reg.registered_at).toLocaleDateString() : null} />
                <Field label="Dance Teacher" value={reg.dance_teacher} />
                <Field label="Music Teacher" value={reg.music_teacher} />
              </div>
            )}
          </section>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-200 px-6 py-4 flex justify-end gap-3">
          {editMode ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditMode(false)} disabled={saving}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                Save changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
              <Button variant="primary" size="sm" onClick={() => {
                setStatus(reg.status || '');
                setDanceTeacher(reg.dance_teacher || '');
                setMusicTeacher(reg.music_teacher || '');
                setError('');
                setEditMode(true);
              }}>
                Edit
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
