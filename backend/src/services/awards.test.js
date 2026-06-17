'use strict';

const { calculateAllAwards, _internal } = require('../services/awards');

const {
  buildParticipantSummaries,
  isGroupChampionEligible,
  computeGroupChampionships,
  computeKcaSpecialChampionships,
  computeTitleWinners,
  reassignGroupChampionsClashingWithTitles,
  computeRatnaAwards,
  computeSchoolAwards,
  computeTeacherAwards,
  categoryCappedTotal,
} = _internal;

function participant(overrides = {}) {
  return {
    participant_id: 'P1',
    name: 'Participant',
    age_group: 'G1',
    gender: 'F',
    school_id: 'S1',
    kca_member: false,
    kca_verified: false,
    ...overrides,
  };
}

function result(overrides = {}) {
  const r = {
    participant_id: 'P1',
    event_id: 'E1',
    category: 'Dance',
    age_group: 'G1',
    gender: 'F',
    is_team_event: false,
    prize_place: null,
    grade: null,
    rank_points: 0,
    grade_points: 0,
    participation_bonus_pts: 0,
    ...overrides,
  };
  r.total_points = r.rank_points + r.grade_points + r.participation_bonus_pts;
  return r;
}

describe('buildParticipantSummaries', () => {
  test('aggregates firsts/grades/categories/team-events/total points correctly', () => {
    const participants = [participant({ participant_id: 'PA' })];
    const results = [
      result({ participant_id: 'PA', category: 'Dance', prize_place: 1, grade: 'A', rank_points: 5, grade_points: 3, participation_bonus_pts: 2 }),
      result({ participant_id: 'PA', category: 'Song', prize_place: 2, grade: 'B', rank_points: 3, grade_points: 2, participation_bonus_pts: 2 }),
      result({ participant_id: 'PA', category: 'Arts', prize_place: 3, grade: 'A', rank_points: 1, grade_points: 3, participation_bonus_pts: 2 }),
      result({ participant_id: 'PA', category: 'Dance', is_team_event: true, grade: 'B', rank_points: 0, grade_points: 2, participation_bonus_pts: 2 }),
    ];

    const summaries = buildParticipantSummaries(results, participants);
    const pa = summaries.get('PA');

    expect(pa.firsts).toBe(1);
    expect(pa.seconds).toBe(1);
    expect(pa.thirds).toBe(1);
    expect(pa.distinct_prize_categories).toBe(3);
    expect(pa.has_team_event).toBe(true);
    expect(pa.has_grade_a).toBe(true);
    expect(pa.total_points).toBe(10 + 7 + 6 + 4);
  });
});

describe('isGroupChampionEligible', () => {
  test('requires >=1 first, >=1 grade A, >=3 distinct prize categories, >=1 team event', () => {
    const eligible = {
      firsts: 1,
      has_grade_a: true,
      distinct_prize_categories: 3,
      has_team_event: true,
    };
    expect(isGroupChampionEligible(eligible)).toBe(true);
    expect(isGroupChampionEligible({ ...eligible, firsts: 0 })).toBe(false);
    expect(isGroupChampionEligible({ ...eligible, has_grade_a: false })).toBe(false);
    expect(isGroupChampionEligible({ ...eligible, distinct_prize_categories: 2 })).toBe(false);
    expect(isGroupChampionEligible({ ...eligible, has_team_event: false })).toBe(false);
  });
});

describe('computeGroupChampionships', () => {
  test('picks the top eligible candidate per group, ignoring ineligible high scorers', () => {
    const eligibleWinner = {
      participant_id: 'PA',
      total_points: 50,
      firsts: 1,
      seconds: 0,
      thirds: 0,
      team_points: 5,
      firsts2: 0,
      ...isEligibleFlags(),
    };
    const eligibleRunnerUp = {
      participant_id: 'PB',
      total_points: 40,
      firsts: 1,
      seconds: 0,
      thirds: 0,
      team_points: 5,
      ...isEligibleFlags(),
    };
    const ineligibleHighScorer = {
      participant_id: 'PC',
      total_points: 100,
      firsts: 2,
      seconds: 2,
      thirds: 0,
      team_points: 0,
      distinct_prize_categories: 2, // fails the >=3 rule -> ineligible
      has_grade_a: true,
      has_team_event: true,
    };

    function isEligibleFlags() {
      return { distinct_prize_categories: 3, has_grade_a: true, has_team_event: true };
    }

    const summariesByGroup = new Map([
      ['G1', [eligibleWinner, eligibleRunnerUp, ineligibleHighScorer]],
    ]);

    const result = computeGroupChampionships(summariesByGroup);
    expect(result.get('G1').winner.participant_id).toBe('PA');
  });

  test('tiebreak: equal total_points resolved by most firsts', () => {
    const base = { distinct_prize_categories: 3, has_grade_a: true, has_team_event: true, total_points: 50, seconds: 0, thirds: 0, team_points: 0 };
    const a = { ...base, participant_id: 'PA', firsts: 2 };
    const b = { ...base, participant_id: 'PB', firsts: 1 };

    const summariesByGroup = new Map([['G1', [b, a]]]); // intentionally out of order
    const result = computeGroupChampionships(summariesByGroup);

    expect(result.get('G1').winner.participant_id).toBe('PA');
    expect(result.get('G1').stillTied).toBe(false);
  });

  test('no eligible candidate -> null for that group', () => {
    const summariesByGroup = new Map([['G2', [{ participant_id: 'PX', total_points: 999, firsts: 0, distinct_prize_categories: 0, has_grade_a: false, has_team_event: false }]]]);
    const result = computeGroupChampionships(summariesByGroup);
    expect(result.get('G2')).toBeNull();
  });
});

describe('computeKcaSpecialChampionships', () => {
  const minPoints = 50;

  test('awarded when Group Champion is NOT a KCA member', () => {
    const champ = { participant_id: 'PA', kca_member: false };
    const groupChampionships = new Map([['G1', { winner: champ, stillTied: false, ranked: [] }]]);
    const memberCandidate = { participant_id: 'PB', kca_member: true, kca_verified: true, total_points: 60, firsts: 1, seconds: 0, thirds: 0, team_points: 0 };
    const summariesByGroup = new Map([['G1', [memberCandidate]]]);

    const result = computeKcaSpecialChampionships(summariesByGroup, groupChampionships, minPoints);
    expect(result.get('G1').winner.participant_id).toBe('PB');
  });

  test('withheld when Group Champion IS already a KCA member', () => {
    const champ = { participant_id: 'PA', kca_member: true };
    const groupChampionships = new Map([['G1', { winner: champ, stillTied: false, ranked: [] }]]);
    const memberCandidate = { participant_id: 'PB', kca_member: true, kca_verified: true, total_points: 60, firsts: 1, seconds: 0, thirds: 0, team_points: 0 };
    const summariesByGroup = new Map([['G1', [memberCandidate]]]);

    const result = computeKcaSpecialChampionships(summariesByGroup, groupChampionships, minPoints);
    expect(result.get('G1')).toBeNull();
  });

  test('candidate below kca_special_min_points is not eligible', () => {
    const champ = { participant_id: 'PA', kca_member: false };
    const groupChampionships = new Map([['G1', { winner: champ, stillTied: false, ranked: [] }]]);
    const belowThreshold = { participant_id: 'PB', kca_member: true, kca_verified: true, total_points: 30, firsts: 0, seconds: 0, thirds: 0, team_points: 0 };
    const summariesByGroup = new Map([['G1', [belowThreshold]]]);

    const result = computeKcaSpecialChampionships(summariesByGroup, groupChampionships, minPoints);
    expect(result.get('G1')).toBeNull();
  });
});

describe('categoryCappedTotal', () => {
  test('only the top N results per category count toward the total', () => {
    const summary = {
      rows: [
        result({ category: 'Dance', rank_points: 5, grade_points: 0, participation_bonus_pts: 0 }), // 5
        result({ category: 'Dance', rank_points: 3, grade_points: 0, participation_bonus_pts: 0 }), // 3
        result({ category: 'Dance', rank_points: 1, grade_points: 0, participation_bonus_pts: 0 }), // 1 (should be dropped, cap=2)
        result({ category: 'Song', rank_points: 5, grade_points: 0, participation_bonus_pts: 0 }), // 5
      ],
    };
    expect(categoryCappedTotal(summary, 2)).toBe(5 + 3 + 5); // dance's lowest result dropped
  });
});

describe('computeTitleWinners + reassignGroupChampionsClashingWithTitles', () => {
  test('Kalathilakam winner who is also the Group Champion bumps the championship to the next eligible candidate', () => {
    const champFlags = { distinct_prize_categories: 3, has_grade_a: true, has_team_event: true, has_team_event_a_or_b: true, seconds: 0, thirds: 0, team_points: 0, rows: [] };
    const titleWinner = { ...champFlags, participant_id: 'PA', gender: 'F', total_points: 80, firsts: 2 };
    const runnerUp = { ...champFlags, participant_id: 'PB', gender: 'F', total_points: 60, firsts: 1 };

    const summariesByGroup = new Map([['G1', [titleWinner, runnerUp]]]);

    const groupChampionshipsRaw = computeGroupChampionships(summariesByGroup);
    expect(groupChampionshipsRaw.get('G1').winner.participant_id).toBe('PA'); // PA wins both, before reassignment

    const titleWinners = computeTitleWinners(summariesByGroup, Infinity);
    expect(titleWinners.get('G1').kalathilakam.winner.participant_id).toBe('PA');

    const resolved = reassignGroupChampionsClashingWithTitles(groupChampionshipsRaw, titleWinners);
    expect(resolved.get('G1').winner.participant_id).toBe('PB'); // bumped to runner-up
  });
});

describe('computeRatnaAwards', () => {
  test('picks the top participant per category across all groups', () => {
    const participantsByid = new Map([
      ['PA', { name: 'Alice' }],
      ['PB', { name: 'Bob' }],
    ]);
    const results = [
      result({ participant_id: 'PA', category: 'Dance', rank_points: 5, grade_points: 3, prize_place: 1 }),
      result({ participant_id: 'PB', category: 'Dance', rank_points: 3, grade_points: 2, prize_place: 2 }),
      result({ participant_id: 'PA', category: 'Song', rank_points: 1, grade_points: 1, prize_place: 3 }),
      result({ participant_id: 'PB', category: 'Song', rank_points: 5, grade_points: 3, prize_place: 1 }),
    ];

    const awards = computeRatnaAwards(results, participantsByid);
    expect(awards.get('Dance').winner.participant_id).toBe('PA');
    expect(awards.get('Song').winner.participant_id).toBe('PB');
    expect(awards.get('Dance').winner.name).toBe('Alice');
  });
});

describe('computeSchoolAwards', () => {
  test('sums rank_points + grade_points + participation_bonus_pts per school', () => {
    const schools = [{ school_id: 'S1', name: 'St. Mary' }, { school_id: 'S2', name: 'Holy Family' }];
    const participants = [
      participant({ participant_id: 'PA', school_id: 'S1' }),
      participant({ participant_id: 'PB', school_id: 'S1' }),
      participant({ participant_id: 'PC', school_id: 'S2' }),
    ];
    const results = [
      result({ participant_id: 'PA', rank_points: 5, grade_points: 3, participation_bonus_pts: 2 }), // 10
      result({ participant_id: 'PB', rank_points: 3, grade_points: 2, participation_bonus_pts: 2 }), // 7
      result({ participant_id: 'PC', rank_points: 1, grade_points: 1, participation_bonus_pts: 2 }), // 4
    ];

    const awards = computeSchoolAwards(results, schools, participants);
    const byId = Object.fromEntries(awards.map((a) => [a.school_id, a.total_points]));
    expect(byId.S1).toBe(17);
    expect(byId.S2).toBe(4);
    expect(awards[0].school_id).toBe('S1'); // sorted desc
  });
});

describe('computeTeacherAwards', () => {
  const deadline = '2026-01-15';

  test('excludes NOT_APPLICABLE and late entries, resolves aliases, sums points', () => {
    const aliasRows = [{ raw_name: 'Mrs Thomas', canonical_name: 'Mary Thomas' }];
    const registrations = [
      { participant_id: 'PA', event_id: 'E1', dance_teacher: 'Mary Thomas', music_teacher: null, teacher_entered_at: '2026-01-01' },
      { participant_id: 'PB', event_id: 'E2', dance_teacher: 'Mrs Thomas', music_teacher: null, teacher_entered_at: '2026-01-10' }, // alias of Mary Thomas
      { participant_id: 'PC', event_id: 'E3', dance_teacher: 'NOT_APPLICABLE', music_teacher: null, teacher_entered_at: '2026-01-01' }, // excluded
      { participant_id: 'PD', event_id: 'E4', dance_teacher: 'Late Teacher', music_teacher: null, teacher_entered_at: '2026-02-01' }, // after deadline, excluded
    ];
    const results = [
      result({ participant_id: 'PA', event_id: 'E1', rank_points: 5, grade_points: 3 }),
      result({ participant_id: 'PB', event_id: 'E2', rank_points: 3, grade_points: 2 }),
      result({ participant_id: 'PC', event_id: 'E3', rank_points: 1, grade_points: 1 }),
      result({ participant_id: 'PD', event_id: 'E4', rank_points: 5, grade_points: 3 }),
    ];

    const awards = computeTeacherAwards(registrations, results, aliasRows, deadline);

    expect(awards).toHaveLength(1); // only Mary Thomas qualifies
    const mary = awards[0];
    expect(mary.canonical_name).toBe('Mary Thomas');
    expect(mary.participant_count).toBe(2); // PA + PB
    expect(mary.rank_points).toBe(8); // 5 + 3
    expect(mary.grade_points).toBe(5); // 3 + 2
  });
});

describe('calculateAllAwards (end-to-end wiring)', () => {
  test('computes and persists a full award set without throwing', async () => {
    const yearConfig = {
      kca_special_min_points: 50,
      category_cap: 3,
      teacher_name_deadline: '2026-01-15',
      rank_points: { '1': 5, '2': 3, '3': 1 },
      grade_points: { A: 3, B: 2, C: 1 },
      participation_bonus_pts: 2,
    };

    const participants = [
      participant({ participant_id: 'PA', age_group: 'G1', gender: 'F', school_id: 'S1', kca_member: false }),
      participant({ participant_id: 'PB', age_group: 'G1', gender: 'M', school_id: 'S2', kca_member: true, kca_verified: true }),
    ];

    const results = [
      result({ participant_id: 'PA', event_id: 'E1', category: 'Dance', prize_place: 1, grade: 'A', rank_points: 5, grade_points: 3, participation_bonus_pts: 2 }),
      result({ participant_id: 'PA', event_id: 'E2', category: 'Song', prize_place: 2, grade: 'B', rank_points: 3, grade_points: 2, participation_bonus_pts: 2 }),
      result({ participant_id: 'PA', event_id: 'E3', category: 'Arts', prize_place: 3, grade: 'A', rank_points: 1, grade_points: 3, participation_bonus_pts: 2 }),
      // Team event graded 'C' on purpose: this satisfies the Group Championship's
      // ">=1 team event" requirement WITHOUT also qualifying PA for Kalathilakam
      // (which needs an A/B grade from a team event). That clash + reassignment
      // path is already covered explicitly in the dedicated test above; this
      // end-to-end test is only checking that the full pipeline wires together.
      result({ participant_id: 'PA', event_id: 'E4', category: 'Dance', is_team_event: true, grade: 'C', rank_points: 0, grade_points: 1, participation_bonus_pts: 2 }),
    ];

    const schools = [{ school_id: 'S1', name: 'St. Mary' }, { school_id: 'S2', name: 'Holy Family' }];
    const registrations = [
      { participant_id: 'PA', event_id: 'E1', dance_teacher: 'Mary Thomas', music_teacher: null, teacher_entered_at: '2026-01-01' },
    ];

    const db = {
      getYearConfig: jest.fn(async () => yearConfig),
      getEventResultsForYear: jest.fn(async () => results),
      getParticipants: jest.fn(async () => participants),
      getSchools: jest.fn(async () => schools),
      getRegistrationsWithTeachers: jest.fn(async () => registrations),
      getTeacherAliases: jest.fn(async () => []),
      saveAwards: jest.fn(async () => {}),
    };

    const awards = await calculateAllAwards('Y2026', db);

    expect(db.saveAwards).toHaveBeenCalledTimes(1);
    expect(awards.group_championships.G1.participant_id).toBe('PA');
    expect(awards.school_awards.find((s) => s.school_id === 'S1').total_points).toBeGreaterThan(0);
  });
});
