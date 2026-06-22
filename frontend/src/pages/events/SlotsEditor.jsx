import { Plus, Trash2, Hash } from 'lucide-react';
import { Input } from '../../components/ui/FormField';
import { Badge } from '../../components/ui/Card';
import Button from '../../components/ui/Button';
import { emptySlot, computeSlotChestStarts } from './constants';

export default function SlotsEditor({ slots, chestNoBase, onChangeSlots, onChangeBase }) {
  const withStarts = computeSlotChestStarts(slots, chestNoBase);
  const totalCapacity = slots.reduce((sum, s) => sum + (Number(s.capacity) || 0), 0);

  const updateSlot = (index, field, value) => {
    onChangeSlots(slots.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  const addSlot = () => {
    onChangeSlots([...slots, emptySlot(slots.length + 1)]);
  };

  const removeSlot = (index) => {
    onChangeSlots(slots.filter((_, i) => i !== index));
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-sm text-slate-500 max-w-md">
          Lots are drawn per slot on the day, but chest numbers stay continuous across every slot
          in this event — never assigned in advance.
        </p>
        <Input
          label="Chest number base"
          type="number"
          min={1}
          value={chestNoBase}
          onChange={(e) => onChangeBase(e.target.value)}
          hint="First chest number for slot 1"
          className="w-40"
        />
      </div>

      <div className="flex flex-col gap-3">
        {withStarts.map((slot, i) => (
          <div key={slot.id} className="flex items-end gap-3 rounded-lg border border-slate-100 bg-slate-50 p-3">
            <Input
              label="Slot label"
              value={slot.label}
              onChange={(e) => updateSlot(i, 'label', e.target.value)}
              className="w-32"
            />
            <Input
              label="Reporting time"
              type="time"
              value={slot.reporting_time}
              onChange={(e) => updateSlot(i, 'reporting_time', e.target.value)}
              className="w-36"
            />
            <Input
              label="Capacity"
              type="number"
              min={0}
              value={slot.capacity}
              onChange={(e) => updateSlot(i, 'capacity', e.target.value)}
              className="w-28"
            />
            <div className="mb-2.5 flex h-9 items-center gap-1.5 rounded-md bg-navy-50 px-3 text-sm font-medium text-navy-700">
              <Hash size={14} />
              Starts at {slot.chest_no_start}
            </div>
            <button
              type="button"
              onClick={() => removeSlot(i)}
              className="mb-2.5 rounded-md p-2 text-slate-400 hover:bg-red-50 hover:text-red-500"
              aria-label="Remove slot"
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" icon={Plus} onClick={addSlot}>
          Add slot
        </Button>
        <Badge tone="navy">Total capacity: {totalCapacity}</Badge>
      </div>
    </div>
  );
}
