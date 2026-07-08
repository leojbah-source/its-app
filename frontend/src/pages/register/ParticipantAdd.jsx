// src/pages/register/ParticipantAdd.jsx
// Two-step page: CPR lookup → if not found, show full creation form.
// On success, navigates to the participant detail / event selection page.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, UserCheck, User } from 'lucide-react';
import { Upload } from 'lucide-react';
import { useParentAuth } from '../../context/ParentAuthContext';
import { portalApi, API_BASE } from './registerApi';
import RegisterLayout from './RegisterLayout';

export default function ParticipantAdd() {
  const { token } = useParentAuth();
  const navigate = useNavigate();

  // ── Step 1: CPR lookup ───────────────────────────────────────────────────
  const [cpr, setCpr] = useState('');
  const [lookupDone, setLookupDone] = useState(false);
  const [found, setFound] = useState(null); // null=not searched, object=found, false=not found
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');

  // ── Step 2: Creation form ────────────────────────────────────────────────
  const [schools, setSchools] = useState([]);
  const [form, setForm] = useState({
    cpr_number: '', full_name: '', dob: '', gender: '',
    school_id: '', cpr_scan_url: '', photo_url: '',
  });
  const [saveLoading, setSaveLoading] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [uploading, setUploading] = useState({}); // { cpr: bool, photo: bool }

  /** CPR = YYMM##### (a leading 0 may drop → 8 digits). Must match the DOB. */
  function cprDobError(cprVal, dobVal) {
    if (!cprVal || !dobVal) return '';
    const digits = String(cprVal).replace(/\D/g, '');
    if (digits.length !== 8 && digits.length !== 9)
      return 'CPR number must be 8 or 9 digits.';
    const full = digits.length === 8 ? '0' + digits : digits;
    const d = new Date(dobVal);
    const yy = String(d.getFullYear() % 100).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    if (full.slice(0, 2) !== yy || full.slice(2, 4) !== mm)
      return `The CPR should start with ${yy}${mm} (birth year + month) — please check the CPR number and date of birth.`;
    return '';
  }
  const cprMismatch = cprDobError(form.cpr_number, form.dob);

  async function handleFileUpload(kind, file) {
    if (!file) return;
    setUploading((u) => ({ ...u, [kind]: true }));
    setSaveError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE}/api/register/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Upload failed');
      setForm((f) => ({ ...f, [kind === 'cpr' ? 'cpr_scan_url' : 'photo_url']: d.url }));
    } catch (err) {
      setSaveError(err.message || 'Upload failed');
    } finally {
      setUploading((u) => ({ ...u, [kind]: false }));
    }
  }

  useEffect(() => {
    portalApi.schools().then(setSchools).catch(() => null);
  }, []);

  async function handleLookup(e) {
    e.preventDefault();
    const trimmed = cpr.trim();
    if (!trimmed) return;

    setLookupLoading(true);
    setLookupError('');
    setLookupDone(false);
    setFound(null);

    try {
      const data = await portalApi.participantLookup(token, trimmed);
      if (data.found) {
        setFound(data.participant);
      } else {
        setFound(false);
        setForm((f) => ({ ...f, cpr_number: trimmed }));
      }
      setLookupDone(true);
    } catch (err) {
      // 400/404 from server handled gracefully above; actual network errors shown
      if (err.status === 400 || err.status === 404) {
        setFound(false);
        setForm((f) => ({ ...f, cpr_number: trimmed }));
        setLookupDone(true);
      } else {
        setLookupError(err.message || 'Lookup failed. Please try again.');
      }
    } finally {
      setLookupLoading(false);
    }
  }

  function setField(k) {
    return (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (cprMismatch) { setSaveError(cprMismatch); return; }
    if (!form.cpr_scan_url) { setSaveError('Please upload a photo/scan of the CPR card.'); return; }
    if (!form.photo_url) { setSaveError("Please upload the participant's photo (used on result cards)."); return; }
    setSaveLoading(true);
    setSaveError('');
    try {
      const result = await portalApi.participantCreate(token, form);
      navigate(`/register/participant/${result.id}`, { replace: true });
    } catch (err) {
      setSaveError(err.message || 'Failed to create participant. Please try again.');
    } finally {
      setSaveLoading(false);
    }
  }

  const inputClass =
    'w-full rounded-xl border border-slate-300 px-4 py-3.5 text-base shadow-sm focus:outline-none focus:ring-2 focus:ring-navy-500 focus:border-transparent bg-white';

  return (
    <RegisterLayout title="Add Participant" showBack backTo="/register/dashboard">
      <div className="space-y-5">
        {/* ── CPR lookup card ──────────────────────────────────────────────── */}
        <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-3">
          <div>
            <h2 className="font-semibold text-slate-800">CPR Number</h2>
            <p className="text-sm text-slate-500 mt-0.5">
              Enter your child's CPR to check if they're already registered.
            </p>
          </div>
          <form onSubmit={handleLookup} className="flex gap-2">
            <input
              value={cpr}
              onChange={(e) => { setCpr(e.target.value); setLookupDone(false); setFound(null); }}
              placeholder="e.g. 010101234"
              inputMode="numeric"
              pattern="[0-9]+"
              className="flex-1 rounded-xl border border-slate-300 px-4 py-3.5 text-base focus:outline-none focus:ring-2 focus:ring-navy-500"
            />
            <button
              type="submit"
              disabled={lookupLoading || !cpr.trim()}
              className="flex items-center justify-center rounded-xl bg-navy-700 px-4 text-white disabled:opacity-50 hover:bg-navy-800 active:bg-navy-900 transition-colors"
              aria-label="Look up CPR"
            >
              {lookupLoading ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                <Search size={20} />
              )}
            </button>
          </form>
          {lookupError && <p className="text-sm text-red-600">{lookupError}</p>}
        </div>

        {/* ── Found: existing participant ──────────────────────────────────── */}
        {found && (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-5 space-y-4">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold">
              <UserCheck size={20} />
              Participant found
            </div>
            <div className="space-y-1.5 text-sm text-slate-700">
              <p><span className="font-medium text-slate-500">Name:</span> {found.full_name}</p>
              <p>
                <span className="font-medium text-slate-500">DOB:</span>{' '}
                {found.dob ? new Date(found.dob).toLocaleDateString('en-GB') : '—'}
              </p>
              <p>
                <span className="font-medium text-slate-500">Age Group:</span>{' '}
                {found.age_group_label || found.age_group_code || '—'}
              </p>
              <p><span className="font-medium text-slate-500">School:</span> {found.school_name || '—'}</p>
            </div>
            <button
              onClick={() => navigate(`/register/participant/${found.id}`)}
              className="w-full rounded-xl bg-emerald-600 py-4 text-white font-semibold hover:bg-emerald-700 active:bg-emerald-800 transition-colors"
            >
              Continue with this participant →
            </button>
          </div>
        )}

        {/* ── Not found: creation form ─────────────────────────────────────── */}
        {lookupDone && found === false && (
          <form onSubmit={handleCreate} className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4">
            <div className="flex items-center gap-2 text-slate-800 font-semibold">
              <User size={20} />
              New Participant Details
            </div>
            <p className="text-sm text-slate-500 -mt-2">
              No record found for this CPR. Please fill in the details below.
            </p>

            {/* Full name */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Full name <span className="text-red-500">*</span>
              </label>
              <input
                required
                value={form.full_name}
                onChange={setField('full_name')}
                className={inputClass}
                placeholder="As it appears on CPR card"
              />
            </div>

            {/* DOB + Gender row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Date of birth <span className="text-red-500">*</span>
                </label>
                <input
                  required
                  type="date"
                  value={form.dob}
                  onChange={setField('dob')}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Gender</label>
                <select
                  value={form.gender}
                  onChange={setField('gender')}
                  className={inputClass}
                >
                  <option value="">Select</option>
                  <option value="M">Male</option>
                  <option value="F">Female</option>
                </select>
              </div>
            </div>

            {/* School */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">School</label>
              <select
                value={form.school_id}
                onChange={setField('school_id')}
                className={inputClass}
              >
                <option value="">Select school</option>
                {schools.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            {/* Contact details come from the parent account — not re-entered */}
            <p className="text-xs text-slate-400">
              Contact details are taken from your account — no need to enter them again.
            </p>

            {/* CPR card scan (compulsory) */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                CPR card photo/scan <span className="text-red-500">*</span>
              </label>
              <label className={`flex items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4 text-sm font-medium cursor-pointer transition-colors ${
                form.cpr_scan_url ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-500 hover:border-navy-400'
              }`}>
                <Upload size={15} />
                {uploading.cpr ? 'Uploading…' : form.cpr_scan_url ? 'CPR scan uploaded ✓ (tap to replace)' : 'Upload CPR card (front) — png/jpg, max 5 MB'}
                <input type="file" accept="image/*" capture="environment" className="hidden"
                       onChange={(e) => handleFileUpload('cpr', e.target.files?.[0])} />
              </label>
              <p className="text-xs text-slate-400 mt-1">
                The original CPR is kept on record to verify the name, CPR number and date of birth.
              </p>
            </div>

            {/* Participant photo (for result cards) */}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Participant photo <span className="text-red-500">*</span>
              </label>
              <label className={`flex items-center justify-center gap-2 rounded-xl border-2 border-dashed px-3 py-4 text-sm font-medium cursor-pointer transition-colors ${
                form.photo_url ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 text-slate-500 hover:border-navy-400'
              }`}>
                <Upload size={15} />
                {uploading.photo ? 'Uploading…' : form.photo_url ? 'Photo uploaded ✓ (tap to replace)' : "Upload participant's photo — png/jpg, max 5 MB"}
                <input type="file" accept="image/*" className="hidden"
                       onChange={(e) => handleFileUpload('photo', e.target.files?.[0])} />
              </label>
              <p className="text-xs text-slate-400 mt-1">
                Used on winner result cards published after each event.
              </p>
            </div>

            {cprMismatch && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 text-sm text-amber-700">
                {cprMismatch}
              </div>
            )}

            {saveError && (
              <div className="rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {saveError}
              </div>
            )}

            <button
              type="submit"
              disabled={saveLoading}
              className="w-full rounded-xl bg-navy-700 py-4 text-base font-semibold text-white hover:bg-navy-800 active:bg-navy-900 disabled:opacity-60 transition-colors"
            >
              {saveLoading ? 'Saving…' : 'Save & Select Events →'}
            </button>
          </form>
        )}
      </div>
    </RegisterLayout>
  );
}
