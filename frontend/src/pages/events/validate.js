import { criteriaSum } from './constants';

export function validateEvent(event) {
  const errors = {};

  if (!event.event_code?.trim()) errors.event_code = 'Event code is required.';
  if (!event.event_name?.trim()) errors.event_name = 'Event name is required.';
  if (!event.category_id) errors.category_id = 'Category is required.';
  if (!event.age_groups?.length) errors.age_groups = 'Select at least one eligible age group.';

  const sum = criteriaSum(event.criteria);
  if (sum !== 100) {
    errors.criteria = `Criteria max scores must sum to exactly 100 (currently ${sum}).`;
  }
  if (event.criteria?.some((c) => !c.label.trim())) {
    errors.criteria = errors.criteria || 'Every criterion needs a label.';
  }

  if (event.time_slot_mode) {
    if (!event.slots?.length) {
      errors.slots = 'Add at least one slot, or turn off time-slot mode.';
    } else if (event.slots.some((s) => !Number(s.capacity))) {
      errors.slots = 'Every slot needs a capacity greater than 0.';
    }
  }

  return errors;
}