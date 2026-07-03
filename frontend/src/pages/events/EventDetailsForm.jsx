import { Input, Select, Textarea } from '../../components/ui/FormField';
import { AGE_GROUP_CODES, GENDER_SPLITS } from './constants';

export default function EventDetailsForm({ event, onChange, errors, categories = [] }) {
  const toggleAgeGroup = (code) => {
    const has = event.age_groups.includes(code);
    const next = has ? event.age_groups.filter((g) => g !== code) : [...event.age_groups, code];
    onChange({ ...event, age_groups: next });
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Event code"
          value={event.event_code}
          error={errors?.event_code}
          onChange={(e) => onChange({ ...event, event_code: e.target.value })}
          placeholder="e.g. NAT-G3-01"
          required
        />
        <Input
          label="Event name"
          value={event.event_name}
          error={errors?.event_name}
          onChange={(e) => onChange({ ...event, event_name: e.target.value })}
          placeholder="e.g. Solo Classical Dance"
          required
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          label="Category"
          value={event.category_id ?? ''}
          error={errors?.category_id}
          onChange={(e) => onChange({ ...event, category_id: Number(e.target.value) })}
        >
          <option value="">Select category…</option>
          {categories.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </Select>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-navy-800">Type</span>
          <div className="flex gap-2">
            {['individual', 'team'].map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => onChange({ ...event, event_kind: t })}
                className={`flex-1 rounded-md border px-3 py-2 text-sm font-medium capitalize transition-colors ${
                  event.event_kind === t
                    ? 'border-navy-600 bg-navy-50 text-navy-700'
                    : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Select
          label="Gender split"
          value={event.gender_split ?? 'common'}
          onChange={(e) => onChange({ ...event, gender_split: e.target.value })}
        >
          {GENDER_SPLITS.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </Select>
        <Input
          label="Fee (BD) — standard"
          type="number"
          min={0}
          step="0.001"
          value={event.fee_amount ?? ''}
          error={errors?.fee_amount}
          onChange={(e) => onChange({ ...event, fee_amount: e.target.value })}
          placeholder="e.g. 3"
        />
        <Input
          label="Fee (BD) — KCA member"
          type="number"
          min={0}
          step="0.001"
          value={event.member_fee_amount ?? ''}
          onChange={(e) => onChange({ ...event, member_fee_amount: e.target.value })}
          placeholder="blank = same as standard"
        />
      </div>

      <div>
        <span className="text-sm font-medium text-navy-800">Eligible age groups</span>
        <div className="mt-2 flex flex-wrap gap-2">
          {AGE_GROUP_CODES.map((code) => {
            const active = event.age_groups.includes(code);
            return (
              <button
                key={code}
                type="button"
                onClick={() => toggleAgeGroup(code)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
                  active ? 'border-gold-500 bg-gold-50 text-gold-700' : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                }`}
              >
                {code}
              </button>
            );
          })}
        </div>
        {errors?.age_groups && <p className="mt-1.5 text-xs font-medium text-red-600">{errors.age_groups}</p>}
      </div>

      {/* ── Performance timing (Addendum 1) ── */}
      <div>
        <span className="text-sm font-medium text-navy-800">Performance timing</span>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <Input
            label="Allotted time (seconds)"
            type="number"
            min={0}
            value={event.allotted_time_seconds ?? ''}
            onChange={(e) => onChange({ ...event, allotted_time_seconds: e.target.value })}
            hint={event.allotted_time_seconds ? `= ${Math.floor(event.allotted_time_seconds / 60)}m ${event.allotted_time_seconds % 60}s` : 'e.g. 600 = 10 minutes'}
          />
          <Input
            label="Grace period (seconds)"
            type="number"
            min={0}
            value={event.grace_period_seconds ?? ''}
            onChange={(e) => onChange({ ...event, grace_period_seconds: e.target.value })}
            hint="Extra time before a DQ flag. Default 30"
          />
          <Input
            label="Yellow alert (seconds before end)"
            type="number"
            min={0}
            value={event.yellow_alert_seconds ?? ''}
            onChange={(e) => onChange({ ...event, yellow_alert_seconds: e.target.value })}
            hint="Warning light cue. Default 60"
          />
        </div>

        {event.age_groups.length > 0 && (
          <div className="mt-3">
            <span className="text-xs font-medium text-slate-600">
              Duration override per age group (seconds) — leave blank to use the allotted time above
            </span>
            <div className="mt-2 grid gap-3 sm:grid-cols-5">
              {event.age_groups.map((code) => (
                <Input
                  key={code}
                  label={code}
                  type="number"
                  min={0}
                  value={event.age_group_durations?.[code] ?? ''}
                  onChange={(e) =>
                    onChange({
                      ...event,
                      age_group_durations: {
                        ...event.age_group_durations,
                        [code]: e.target.value,
                      },
                    })
                  }
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <input
          id="is_stage_event"
          type="checkbox"
          checked={!!event.is_stage_event}
          onChange={(e) => onChange({ ...event, is_stage_event: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300"
        />
        <label htmlFor="is_stage_event" className="text-sm font-medium text-navy-800">
          Stage event (requires stage/auditorium)
        </label>
      </div>
    </div>
  );
}