export const EVENT_CATEGORIES = [
  'Natya',
  'Sangeeta',
  'Sahitya',
  'Kala',
  'Add-on',
  'Team Event',
];

export const AGE_GROUP_CODES = ['G1', 'G2', 'G3', 'G4', 'G5'];

export const GENDER_SPLITS = [
  { value: 'common', label: 'Common (all)' },
  { value: 'boys',   label: 'Boys only' },
  { value: 'girls',  label: 'Girls only' },
  { value: 'none',   label: 'None / n-a' },
];

export function emptyCriterion(seed = 1) {
  return { id: `c${seed}-${Date.now()}`, label: '', max_score: 0 };
}

export function emptySlot(seed = 1) {
  return { id: `s${seed}-${Date.now()}`, label: `Slot ${seed}`, reporting_time: '', capacity: 0 };
}

export function blankEvent() {
  return {
    id: null,
    event_code: '',
    event_name: '',
    category_id: null,
    event_kind: 'individual',
    is_stage_event: false,
    gender_split: 'common',
    fee_amount: '',
    member_fee_amount: '',
    allotted_time_seconds: '',
    grace_period_seconds: 30,
    yellow_alert_seconds: 60,
    age_groups: [],
    age_group_durations: {},
    time_slot_mode: false,
    sort_order: null,
    criteria: [emptyCriterion(1)],
    slots: [],
  };
}

export function criteriaSum(criteria) {
  return (criteria || []).reduce((sum, c) => sum + (Number(c.max_score) || 0), 0);
}

export function computeSlotChestStarts(slots, base = 1) {
  let running = Number(base) || 1;
  return slots.map((slot) => {
    const start = running;
    running += Number(slot.capacity) || 0;
    return { ...slot, chest_no_start: start };
  });
}
