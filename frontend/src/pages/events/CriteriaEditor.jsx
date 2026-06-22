import { Plus, Trash2 } from 'lucide-react';
import { Input } from '../../components/ui/FormField';
import { Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { criteriaSum, emptyCriterion } from './constants';

const MAX_CRITERIA = 6;

export default function CriteriaEditor({ criteria, onChange }) {
  const sum = criteriaSum(criteria);
  const sumOk = sum === 100;

  const updateCriterion = (index, field, value) => {
    onChange(criteria.map((c, i) => (i === index ? { ...c, [field]: value } : c)));
  };

  const addCriterion = () => {
    if (criteria.length >= MAX_CRITERIA) return;
    onChange([...criteria, emptyCriterion(criteria.length + 1)]);
  };

  const removeCriterion = (index) => {
    if (criteria.length <= 1) return;
    onChange(criteria.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          Up to {MAX_CRITERIA} criteria per event. Each judge scores against these; the maximum
          scores must sum to exactly 100.
        </p>
        <Badge tone={sumOk ? 'success' : 'danger'} className="shrink-0 text-sm">
          Sum: {sum} / 100
        </Badge>
      </div>

      <div className="flex flex-col gap-3">
        {criteria.map((c, i) => (
          <div key={c.id} className="flex items-end gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
            <span className="mb-2.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-xs font-semibold text-navy-600 shadow-sm">
              {i + 1}
            </span>
            <Input
              label="Criterion"
              value={c.label}
              onChange={(e) => updateCriterion(i, 'label', e.target.value)}
              placeholder="e.g. Diction & clarity"
              className="flex-1"
            />
            <Input
              label="Max score"
              type="number"
              min={0}
              max={100}
              value={c.max_score}
              onChange={(e) => updateCriterion(i, 'max_score', e.target.value)}
              className="w-28"
            />
            <button
              type="button"
              onClick={() => removeCriterion(i)}
              disabled={criteria.length <= 1}
              className="mb-2.5 rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="Remove criterion"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <Button variant="outline" size="sm" icon={Plus} onClick={addCriterion} disabled={criteria.length >= MAX_CRITERIA} className="self-start">
        Add criterion
      </Button>
    </div>
  );
}
