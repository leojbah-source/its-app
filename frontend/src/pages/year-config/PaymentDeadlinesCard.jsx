// src/pages/year-config/PaymentDeadlinesCard.jsx
// Blueprint §4.1: payment display details + the three registration deadlines.
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';

/** TIMESTAMPTZ → value usable by <input type="datetime-local"> (local time). */
function toLocalDT(val) {
  if (!val) return '';
  const d = new Date(val);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function PaymentDeadlinesCard({ config, onChange, errors }) {
  const text = (field) => ({
    value: config[field] ?? '',
    error: errors?.[field],
    onChange: (e) => onChange({ ...config, [field]: e.target.value }),
  });
  const dt = (field) => ({
    type: 'datetime-local',
    value: toLocalDT(config[field]),
    error: errors?.[field],
    onChange: (e) => onChange({ ...config, [field]: e.target.value || null }),
  });

  return (
    <Card
      title="Payments & deadlines"
      description="Shown on the parent payment page, and the cut-off dates that lock registration each year."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <Input
          label="KCA IBAN"
          hint="Displayed with bank-transfer instructions"
          placeholder="BHxx XXXX XXXX XXXX XXXX"
          {...text('kca_iban')}
        />
        <Input
          label="BenefitPay number"
          hint="Displayed with BenefitPay instructions"
          {...text('benefit_pay_number')}
        />
        <Input
          label="Individual registration deadline"
          hint="Date and time — event add/remove locks after this"
          {...dt('reg_deadline')}
        />
        <Input
          label="Team registration deadline"
          hint="Teams may register later than individuals"
          {...dt('team_reg_deadline')}
        />
        <Input
          label="Teacher name submission deadline"
          hint="Last date to enter/update teacher names before teacher awards"
          {...dt('teacher_name_deadline')}
        />
      </div>
    </Card>
  );
}
