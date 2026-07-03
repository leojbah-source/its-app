// src/pages/year-config/LimitsCard.jsx
// Blueprint §4.1: registration caps, award thresholds and team size limits.
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';

export default function LimitsCard({ config, onChange, errors }) {
  const num = (field) => ({
    type: 'number',
    min: 0,
    value: config[field] ?? '',
    error: errors?.[field],
    onChange: (e) => onChange({ ...config, [field]: e.target.value }),
  });

  return (
    <Card
      title="Registration limits & award thresholds"
      description="Caps and thresholds that govern registration, split/merge decisions and awards. All values are per-year variables."
    >
      <div className="grid gap-6 sm:grid-cols-3">
        <Input
          label="Max individual events per participant"
          hint="Blueprint default: 12"
          {...num('max_individual_events')}
        />
        <Input
          label="Category cap (Kalathilakam / Kalaprathibha)"
          hint="Top N results per category counted. Default: 6"
          {...num('category_cap')}
        />
        <Input
          label="KCA Special Championship min points"
          hint="Default: 30"
          {...num('kca_special_min_points')}
        />
        <Input
          label="Min entries threshold"
          hint="Below this an event is merged or cancelled. Default: 5"
          {...num('min_entries_threshold')}
        />
        <Input
          label="Split threshold"
          hint="Above this a sub-group split is recommended"
          {...num('split_threshold')}
        />
        <Input
          label="No-prize threshold"
          hint="Min contestants before prizes are awarded. Default: 3"
          {...num('no_prize_below')}
        />
        <Input
          label="Team size — minimum"
          hint="Default: 5 (enforced at final team submission)"
          {...num('team_size_min')}
        />
        <Input
          label="Team size — maximum"
          hint="Default: 10"
          {...num('team_size_max')}
        />
      </div>
    </Card>
  );
}
