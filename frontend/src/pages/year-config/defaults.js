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
    reg_deadline: '',
    team_reg_deadline: '',
    event_year_label: '',
    sponsor_name: '',
    website_domain: '',
    kca_iban: '',
    benefit_pay_number: '',
    member_subscription_upto: '',
    max_individual_events: 12,
    category_cap: 6,
    kca_special_min_points: 30,
    min_entries_threshold: 5,
    split_threshold: 25,
    no_prize_below: 3,
    team_size_min: 5,
    team_size_max: 10,
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
    teacher_name_deadline: incoming.teacher_name_deadline ?? '',

    // Scalars
    participation_bonus_pts:  incoming.participation_bonus_pts  ?? base.participation_bonus_pts,
    divergence_threshold_pct: incoming.divergence_threshold_pct ?? base.divergence_threshold_pct,
    tiebreaker_scale_max:     incoming.tiebreaker_scale_max     ?? base.tiebreaker_scale_max,

    // §4.1 identity / payment / limits (blueprint: nothing hard-coded per year)
    event_year_label:       incoming.event_year_label       ?? base.event_year_label,
    sponsor_name:           incoming.sponsor_name           ?? base.sponsor_name,
    website_domain:         incoming.website_domain         ?? base.website_domain,
    kca_iban:               incoming.kca_iban               ?? base.kca_iban,
    benefit_pay_number:     incoming.benefit_pay_number     ?? base.benefit_pay_number,
    member_subscription_upto: incoming.member_subscription_upto ?? base.member_subscription_upto,
    reg_deadline:           incoming.reg_deadline           ?? base.reg_deadline,
    team_reg_deadline:      incoming.team_reg_deadline      ?? base.team_reg_deadline,
    max_individual_events:  incoming.max_individual_events  ?? base.max_individual_events,
    category_cap:           incoming.category_cap           ?? base.category_cap,
    kca_special_min_points: incoming.kca_special_min_points ?? base.kca_special_min_points,
    min_entries_threshold:  incoming.min_entries_threshold  ?? base.min_entries_threshold,
    split_threshold:        incoming.split_threshold        ?? base.split_threshold,
    no_prize_below:         incoming.no_prize_below         ?? base.no_prize_below,
    team_size_min:          incoming.team_size_min          ?? base.team_size_min,
    team_size_max:          incoming.team_size_max          ?? base.team_size_max,

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