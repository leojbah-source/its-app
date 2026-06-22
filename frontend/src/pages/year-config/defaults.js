function toDateString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val.substring(0, 10);
  if (val instanceof Date) return val.toISOString().substring(0, 10);
  return '';
}

export function defaultYearConfig(year) {
  return {
    year,
    event_start_date: '',
    event_end_date: '',
    age_groups: [
      { code: 'G1', label: 'Group 1', dob_from: '', dob_to: '' },
      { code: 'G2', label: 'Group 2', dob_from: '', dob_to: '' },
      { code: 'G3', label: 'Group 3', dob_from: '', dob_to: '' },
      { code: 'G4', label: 'Group 4', dob_from: '', dob_to: '' },
      { code: 'G5', label: 'Group 5', dob_from: '', dob_to: '' },
    ],
    grades: [
      { code: 'A', min_percent: 70, points: 3 },
      { code: 'B', min_percent: 60, points: 2 },
      { code: 'C', min_percent: 50, points: 1 },
    ],
    rank_points: { first: 5, second: 3, third: 1 },
    participation_bonus_pts: 1,
    divergence_threshold_pct: 20,
    tiebreaker_scale_max: 10,
    teacher_name_deadline: '',
    registrations_frozen: false,
    status: 'draft',
  assets: {
  its_logo:       { url: null, name: null },
  kca_logo:       { url: null, name: null },
  sponsor_logo:   { url: null, name: null },
  result_template:{ url: null, name: null },
},
};
}

export function mergeYearConfig(year, incoming) {
  const base = defaultYearConfig(year);
  if (!incoming) return base;

  return {
    ...base,
    year: incoming.year || year,

    // Dates — handle both string and Date object from pg driver
    event_start_date: toDateString(incoming.event_start_date),
    event_end_date:   toDateString(incoming.event_end_date),
    teacher_name_deadline: toDateString(incoming.teacher_name_deadline),

    // Scalars
    participation_bonus_pts:  incoming.participation_bonus_pts  ?? base.participation_bonus_pts,
    divergence_threshold_pct: incoming.divergence_threshold_pct ?? base.divergence_threshold_pct,
    tiebreaker_scale_max:     incoming.tiebreaker_scale_max     ?? base.tiebreaker_scale_max,

    // Status — DB stores initial_list_published boolean, not a status string
    status: incoming.initial_list_published ? 'published' : 'draft',

    // Frozen — inferred from reg_deadline being set in the past
    registrations_frozen: incoming.reg_deadline
      ? new Date(incoming.reg_deadline) <= new Date()
      : false,

    // Map flat DB grade columns → grades array
    grades: [
      {
        code: 'A',
        min_percent: Number(incoming.grade_a_pct ?? base.grades[0].min_percent),
        points:      Number(incoming.grade_a_pts ?? base.grades[0].points),
      },
      {
        code: 'B',
        min_percent: Number(incoming.grade_b_pct ?? base.grades[1].min_percent),
        points:      Number(incoming.grade_b_pts ?? base.grades[1].points),
      },
      {
        code: 'C',
        min_percent: Number(incoming.grade_c_pct ?? base.grades[2].min_percent),
        points: Number(incoming.grade_c_pts ?? base.grades[2].points),
      },
    ],

    // Map flat DB rank columns → rank_points object
    rank_points: {
      first:  Number(incoming.rank_pts_first  ?? base.rank_points.first),
      second: Number(incoming.rank_pts_second ?? base.rank_points.second),
      third:  Number(incoming.rank_pts_third  ?? base.rank_points.third),
    },

    // Age groups come from a separate API call — keep base if not in response
       age_groups: Array.isArray(incoming.age_groups) && incoming.age_groups.length
      ? incoming.age_groups.map(ag => ({
          ...ag,
          dob_from: toDateString(ag.dob_from),
          dob_to:   toDateString(ag.dob_to),
        }))
      : base.age_groups,
    // Map flat URL columns → assets object
    assets: {
  its_logo:       { url: incoming.its_logo_url        || null, name: null },
  kca_logo:       { url: incoming.kca_logo_url        || null, name: null },
  sponsor_logo:   { url: incoming.sponsor_logo_url    || null, name: null },
  result_template:{ url: incoming.result_template_url || null, name: null },
    },
  };
}