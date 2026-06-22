// Returns { errors, warnings } — errors block Publish/Save, warnings are advisory.
export function validateYearConfig(config) {
  const errors = {};
  const warnings = [];

  if (!config.year) errors.year = 'Year is required.';

  if (!config.event_start_date) errors.event_start_date = 'Required.';
  if (!config.event_end_date) errors.event_end_date = 'Required.';
  if (
    config.event_start_date &&
    config.event_end_date &&
    new Date(config.event_end_date) < new Date(config.event_start_date)
  ) {
    errors.event_end_date = 'End date cannot be before the start date.';
  }

  const pct = Number(config.divergence_threshold_pct);
  if (Number.isNaN(pct) || pct < 0 || pct > 100) {
    errors.divergence_threshold_pct = 'Enter a value between 0 and 100.';
  }

  const tiebreak = Number(config.tiebreaker_scale_max);
  if (Number.isNaN(tiebreak) || tiebreak < 1) {
    errors.tiebreaker_scale_max = 'Enter a positive scale (e.g. 10).';
  }

  ['first', 'second', 'third'].forEach((key) => {
    const v = Number(config.rank_points?.[key]);
    if (Number.isNaN(v) || v < 0) errors[`rank_points.${key}`] = 'Must be 0 or greater.';
  });

  if (Number(config.participation_bonus_pts) < 0) {
    errors.participation_bonus_pts = 'Must be 0 or greater.';
  }

  // Grade boundaries should be strictly descending: A > B > C
  const grades = config.grades || [];
  for (let i = 1; i < grades.length; i += 1) {
    if (Number(grades[i].min_percent) >= Number(grades[i - 1].min_percent)) {
      errors[`grades.${i}.min_percent`] = `Must be lower than ${grades[i - 1].code}'s threshold.`;
    }
  }

  // Age group DOB ranges: flag overlaps (warning, not blocking — Chairman may
  // intentionally allow a borderline overlap for late birthdays).
  const groups = (config.age_groups || []).filter((g) => g.dob_from && g.dob_to);
  for (let i = 0; i < groups.length; i += 1) {
    const a = groups[i];
    if (new Date(a.dob_from) > new Date(a.dob_to)) {
      errors[`age_groups.${i}.dob_to`] = `${a.code}: "to" date must be after "from" date.`;
    }
    for (let j = i + 1; j < groups.length; j += 1) {
      const b = groups[j];
      const overlap = new Date(a.dob_from) <= new Date(b.dob_to) && new Date(b.dob_from) <= new Date(a.dob_to);
      if (overlap) warnings.push(`${a.code} and ${b.code} have overlapping date-of-birth ranges.`);
    }
  }

  return { errors, warnings };
}
