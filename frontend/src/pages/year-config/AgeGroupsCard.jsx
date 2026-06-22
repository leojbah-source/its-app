import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';

export default function AgeGroupsCard({ ageGroups, onChange, errors }) {
  const updateGroup = (index, field, value) => {
    const next = ageGroups.map((g, i) => (i === index ? { ...g, [field]: value } : g));
    onChange(next);
  };

  return (
    <Card
      title="Age groups (G1–G5)"
      description="Date-of-birth ranges are redefined every year — nothing here is hard-coded."
    >
      <div className="overflow-x-auto scroll-thin">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-4 font-medium">Group</th>
              <th className="py-2 pr-4 font-medium">Label</th>
              <th className="py-2 pr-4 font-medium">DOB from</th>
              <th className="py-2 font-medium">DOB to</th>
            </tr>
          </thead>
          <tbody>
            {ageGroups.map((group, i) => (
              <tr key={group.code} className="border-b border-slate-100 last:border-0">
                <td className="py-2.5 pr-4 font-semibold text-navy-700">{group.code}</td>
                <td className="py-2.5 pr-4">
                  <Input
                    value={group.label}
                    onChange={(e) => updateGroup(i, 'label', e.target.value)}
                    placeholder="e.g. Group 1 (5–7 yrs)"
                  />
                </td>
                <td className="py-2.5 pr-4">
                  <Input
                    type="date"
                    value={group.dob_from}
                    onChange={(e) => updateGroup(i, 'dob_from', e.target.value)}
                  />
                </td>
                <td className="py-2.5">
                  <Input
                    type="date"
                    value={group.dob_to}
                    error={errors?.[`age_groups.${i}.dob_to`]}
                    onChange={(e) => updateGroup(i, 'dob_to', e.target.value)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
