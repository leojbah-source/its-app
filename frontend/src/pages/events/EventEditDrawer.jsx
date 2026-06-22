import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import Drawer from '../../components/ui/Drawer';
import Button from '../../components/ui/Button';
import Switch from '../../components/ui/Switch';
import { Badge } from '../../components/ui/Card';
import EventDetailsForm from './EventDetailsForm';
import CriteriaEditor from './CriteriaEditor';
import SlotsEditor from './SlotsEditor';
import { blankEvent } from './constants';
import { validateEvent } from './validate';

const BASE_TABS = [
  { key: 'details', label: 'Details' },
  { key: 'criteria', label: 'Criteria' },
];

export default function EventEditDrawer({ open, event, saving, categories = [], onClose, onSave }) {
  const [draft, setDraft] = useState(blankEvent());
  const [tab, setTab] = useState('details');
  const [attemptedSave, setAttemptedSave] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(event ? { ...blankEvent(), ...event } : blankEvent());
      setTab('details');
      setAttemptedSave(false);
    }
  }, [open, event]);

  const errors = validateEvent(draft);
  const hasErrors = Object.keys(errors).length > 0;

  const tabs = draft.time_slot_mode ? [...BASE_TABS, { key: 'slots', label: 'Slots' }] : BASE_TABS;

  const handleSave = () => {
    setAttemptedSave(true);
    if (hasErrors) return;
    onSave(draft);
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={event ? `Edit · ${event.event_name}` : 'New event'}
      subtitle={
        event
          ? `Code ${event.event_code}`
          : 'Add a new individual or team event to this year’s lineup'
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Discard
          </Button>
          <Button variant="primary" icon={Save} loading={saving} onClick={handleSave}>
            Save event
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="rounded-lg border border-slate-100 bg-slate-50 px-4 py-3">
          <Switch
            checked={draft.time_slot_mode}
            onChange={(checked) => {
              setDraft({ ...draft, time_slot_mode: checked });
              if (checked) setTab('slots');
            }}
            label="Time-slot mode"
            description="For high-volume events: lots are drawn per slot, chest numbers stay continuous across all slots."
          />
        </div>

        <div className="flex gap-1 border-b border-slate-200">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`relative px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.key ? 'text-navy-700' : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {t.label}
              {t.key === 'criteria' && (
                <Badge tone={errors.criteria ? 'danger' : 'success'} className="ml-2">
                  {errors.criteria ? '!' : '✓'}
                </Badge>
              )}
              {tab === t.key && (
                <span className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-gold-500" />
              )}
            </button>
          ))}
        </div>

        {attemptedSave && hasErrors && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {Object.values(errors)[0]}
          </div>
        )}

        {tab === 'details' && (
          <EventDetailsForm
            event={draft}
            onChange={setDraft}
            errors={attemptedSave ? errors : {}}
            categories={categories}
          />
        )}
        {tab === 'criteria' && (
          <CriteriaEditor
            criteria={draft.criteria}
            onChange={(criteria) => setDraft({ ...draft, criteria })}
          />
        )}
        {tab === 'slots' && draft.time_slot_mode && (
          <SlotsEditor
            slots={draft.slots}
            chestNoBase={draft.chest_no_base}
            onChangeSlots={(slots) => setDraft({ ...draft, slots })}
            onChangeBase={(chest_no_base) => setDraft({ ...draft, chest_no_base })}
          />
        )}
      </div>
    </Drawer>
  );
}
