import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';

export default function GradingCard({ config, onChange, errors }) {
  const updateGrade = (index, field, value) => {
    const next = config.grades.map((g, i) => (i === index ? { ...g, [field]: value } : g));
    onChange({ ...config, grades: next });
  };

  const updateRankPoint = (key, value) => {
    onChange({ ...config, rank_points: { ...config.rank_points, [key]: value } });
  };

  return (
    <Card
      title="Grades, ranks & bonus points"
      description="Grade letters, rank points and the participation bonus are configurable every year."
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-sm font-medium text-navy-800">Grade boundaries</p>
          <div className="space-y-3">
            {config.grades.map((grade, i) => (
              <div key={grade.code} className="flex items-end gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-navy-50 text-sm font-semibold text-navy-700">
                  {grade.code}
                </span>
                <Input
                  label="Min %"
                  type="number"
                  min={0}
                  max={100}
                  value={grade.min_percent}
                  error={errors?.[`grades.${i}.min_percent`]}
                  onChange={(e) => updateGrade(i, 'min_percent', e.target.value)}
                  className="w-24"
                />
                <Input
                  label="Grade points"
                  type="number"
                  min={0}
                  value={grade.points}
                  onChange={(e) => updateGrade(i, 'points', e.target.value)}
                  className="w-28"
                />
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-navy-800">Rank points</p>
          <div className="flex flex-wrap gap-3">
            <Input
              label="1st place"
              type="number"
              min={0}
              value={config.rank_points.first}
              error={errors?.['rank_points.first']}
              onChange={(e) => updateRankPoint('first', e.target.value)}
              className="w-24"
            />
            <Input
              label="2nd place"
              type="number"
              min={0}
              value={config.rank_points.second}
              error={errors?.['rank_points.second']}
              onChange={(e) => updateRankPoint('second', e.target.value)}
              className="w-24"
            />
            <Input
              label="3rd place"
              type="number"
              min={0}
              value={config.rank_points.third}
              error={errors?.['rank_points.third']}
              onChange={(e) => updateRankPoint('third', e.target.value)}
              className="w-24"
            />
          </div>

          <div className="mt-5">
            <Input
              label="Participation bonus (default per event)"
              type="number"
              min={0}
              value={config.participation_bonus_pts}
              error={errors?.participation_bonus_pts}
              hint="Added to a participant's school-award total for taking part, regardless of rank."
              onChange={(e) => onChange({ ...config, participation_bonus_pts: e.target.value })}
              className="w-full max-w-xs"
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
