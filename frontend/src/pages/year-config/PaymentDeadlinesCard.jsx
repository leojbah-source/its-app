// src/pages/year-config/PaymentDeadlinesCard.jsx
// Blueprint §4.1: payment display details + the three registration deadlines.
import { Card } from '../../components/ui/Card';
import { Input } from '../../components/ui/FormField';

export default function PaymentDeadlinesCard({ config, onChange, errors }) {
  const text = (field) => ({
    value: config[field] ?? '',
    error: errors?.[field],
    onChange: (e) => onChange({ ...config, [field]: e.target.value }),
  });
  // Deadlines are whole-day cut-offs shown as a plain DATE picker. Bind the raw
  // 'YYYY-MM-DD' string directly (the first 10 chars of whatever the DB returns)
  // — do NOT round-trip through `new Date(...)`, which corrupts the value mid-type
  // and makes the field blank out while you enter the year. The end-of-day time is
  // added once, at save time (see YearConfig.persistConfig).
  const deadline = (field) => ({
    type: 'date',
    value: (config[field] || '').slice(0, 10),
    error: errors?.[field],
    onChange: (e) => onChange({ ...config, [field]: e.target.value }),
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
          label="KCA subscription paid up to (YYYY-MM)"
          hint="Members must be paid up to this month to get member rates"
          placeholder="e.g. 2026-10"
          {...text('member_subscription_upto')}
        />
        <Input
          label="Individual registration deadline"
          hint="Registration locks at the end of this day"
          {...deadline('reg_deadline')}
        />
        <Input
          label="Team registration deadline"
          hint="Teams may register later than individuals — locks at end of this day"
          {...deadline('team_reg_deadline')}
        />
        <Input
          label="Teacher name submission deadline"
          hint="Last day to enter or update teacher names before teacher awards"
          {...deadline('teacher_name_deadline')}
        />
      </div>
    </Card>
  );
}
