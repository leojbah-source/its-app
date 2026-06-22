import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';

export default function DivergenceCard({ config, onChange, errors, totalParticipantsSample = 25 }) {
  const pct = Number(config.divergence_threshold_pct) || 0;
  const sampleThreshold = Math.round((totalParticipantsSample * pct) / 100);

  return (
    <Card
      title="Divergence & tiebreaker"
      description="Controls when the system flags a judging divergence alert and how exact ties are broken."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <Input
            label="Divergence threshold (%)"
            type="number"
            min={0}
            max={100}
            value={config.divergence_threshold_pct}
            error={errors?.divergence_threshold_pct}
            onChange={(e) => onChange({ ...config, divergence_threshold_pct: e.target.value })}
          />
          <p className="mt-2 text-xs text-slate-500">
            Divergence % — e.g. 20% on 25 participants = 5-position threshold.
          </p>
          <p className="mt-1 text-xs text-navy-500">
            Live example: on an event with {totalParticipantsSample} participants, the absolute
            threshold would be <span className="font-semibold">{sampleThreshold} position(s)</span>.
          </p>
        </div>

        <div>
          <Input
            label="Tiebreaker scale (max)"
            type="number"
            min={1}
            value={config.tiebreaker_scale_max}
            error={errors?.tiebreaker_scale_max}
            hint="Each judge scores tied participants on a 1–N scale during an exact-tie session."
            onChange={(e) => onChange({ ...config, tiebreaker_scale_max: e.target.value })}
          />
        </div>
      </div>
    </Card>
  );
}
