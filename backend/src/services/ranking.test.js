'use strict';

const { calculateEventResult, resolveExactTie, detectDivergence, _internal } = require('../services/ranking');

function makeDb({ scores, criteria, yearConfig, tiebreakerMarks, tiedResults }) {
  return {
    getSubmittedScores: jest.fn(async () => scores),
    getEventCriteria: jest.fn(async () => criteria),
    getYearConfigForEvent: jest.fn(async () => yearConfig),
    getTiebreakerMarks: jest.fn(async () => tiebreakerMarks || []),
    getTiedEventResults: jest.fn(async () => tiedResults || []),
    saveEventResults: jest.fn(async () => {}),
    notifyTieBreakRequired: jest.fn(async () => {}),
  };
}

const baseYearConfig = {
  no_prize_below: 1,
  grade_thresholds: [
    { grade: 'A', min_pct: 70 },
    { grade: 'B', min_pct: 50 },
    { grade: 'C', min_pct: 35 },
  ],
  rank_points: { '1': 5, '2': 3, '3': 1 },
  grade_points: { A: 3, B: 2, C: 1 },
  participation_bonus_pts: 2,
  divergence_threshold_pct: 20,
};

function scoreRow(participant_id, chest_no, judge_id, criterion_id, score) {
  return { participant_id, chest_no, judge_id, criterion_id, score };
}

describe('calculateEventResult', () => {
  test('clear winner: correct 1st/2nd/3rd', async () => {
    const criteria = [{ criterion_id: 'c1', name: 'Overall', max_score: 100 }];
    const scores = [];
    const totals = { P1: 90, P2: 80, P3: 70 };
    const chest = { P1: 101, P2: 102, P3: 103 };
    for (const judge of ['J1', 'J2', 'J3']) {
      for (const p of ['P1', 'P2', 'P3']) {
        scores.push(scoreRow(p, chest[p], judge, 'c1', totals[p]));
      }
    }
    const db = makeDb({ scores, criteria, yearConfig: baseYearConfig });

    const { status, results } = await calculateEventResult('E1', 'SG1', db);

    expect(status).toBe('OK');
    const byId = Object.fromEntries(results.map((r) => [r.participant_id, r]));
    expect(byId.P1.final_rank).toBe(1);
    expect(byId.P2.final_rank).toBe(2);
    expect(byId.P3.final_rank).toBe(3);
    expect(byId.P1.prize_place).toBe(1);
    expect(byId.P2.prize_place).toBe(2);
    expect(byId.P3.prize_place).toBe(3);
    expect(db.saveEventResults).toHaveBeenCalledTimes(1);
  });

  test('CRS tie resolved by criterion 1 -> correct winner', async () => {
    const criteria = [
      { criterion_id: 'c1', name: 'Technique', max_score: 60 },
      { criterion_id: 'c2', name: 'Presentation', max_score: 40 },
    ];
    // Engineered so CRS(P1) === CRS(P2) === 4, CRS(P3) = 9,
    // and P1 has a higher average than P2 on c1 (the higher max_score criterion).
    const scores = [
      // Judge 1 -> totals P1=90, P2=80, P3=70
      scoreRow('P1', 1, 'J1', 'c1', 55),
      scoreRow('P1', 1, 'J1', 'c2', 35),
      scoreRow('P2', 2, 'J1', 'c1', 45),
      scoreRow('P2', 2, 'J1', 'c2', 35),
      scoreRow('P3', 3, 'J1', 'c1', 40),
      scoreRow('P3', 3, 'J1', 'c2', 30),
      // Judge 2 -> totals P1=80, P2=90, P3=70
      scoreRow('P1', 1, 'J2', 'c1', 45),
      scoreRow('P1', 1, 'J2', 'c2', 35),
      scoreRow('P2', 2, 'J2', 'c1', 55),
      scoreRow('P2', 2, 'J2', 'c2', 35),
      scoreRow('P3', 3, 'J2', 'c1', 40),
      scoreRow('P3', 3, 'J2', 'c2', 30),
      // Judge 3 -> totals P1=85, P2=85 (tie at top), P3=60
      scoreRow('P1', 1, 'J3', 'c1', 50),
      scoreRow('P1', 1, 'J3', 'c2', 35),
      scoreRow('P2', 2, 'J3', 'c1', 45),
      scoreRow('P2', 2, 'J3', 'c2', 40),
      scoreRow('P3', 3, 'J3', 'c1', 30),
      scoreRow('P3', 3, 'J3', 'c2', 30),
    ];
    const db = makeDb({ scores, criteria, yearConfig: baseYearConfig });

    const { status, results } = await calculateEventResult('E1', 'SG1', db);

    const byId = Object.fromEntries(results.map((r) => [r.participant_id, r]));
    expect(byId.P1.crs).toBe(4);
    expect(byId.P2.crs).toBe(4);
    expect(status).toBe('OK'); // resolved via criteria, not an exact tie
    expect(byId.P1.final_rank).toBe(1);
    expect(byId.P2.final_rank).toBe(2);
    expect(byId.P1.tie_flag).toBe(false);
    expect(byId.P2.tie_flag).toBe(false);
  });

  test('CRS tie, all criteria equal -> EXACT_TIE status', async () => {
    const criteria = [
      { criterion_id: 'c1', name: 'Technique', max_score: 60 },
      { criterion_id: 'c2', name: 'Presentation', max_score: 40 },
    ];
    // P1 and P2 have completely identical scores from every judge -> CRS tie
    // that cannot be broken by any criterion average.
    const scores = [];
    for (const judge of ['J1', 'J2', 'J3']) {
      scores.push(scoreRow('P1', 1, judge, 'c1', 50));
      scores.push(scoreRow('P1', 1, judge, 'c2', 30));
      scores.push(scoreRow('P2', 2, judge, 'c1', 50));
      scores.push(scoreRow('P2', 2, judge, 'c2', 30));
      scores.push(scoreRow('P3', 3, judge, 'c1', 20));
      scores.push(scoreRow('P3', 3, judge, 'c2', 10));
    }
    const db = makeDb({ scores, criteria, yearConfig: baseYearConfig });

    const { status, tied_participant_ids, results } = await calculateEventResult('E1', 'SG1', db);

    expect(status).toBe('EXACT_TIE');
    expect(new Set(tied_participant_ids)).toEqual(new Set(['P1', 'P2']));
    const byId = Object.fromEntries(results.map((r) => [r.participant_id, r]));
    expect(byId.P1.final_rank).toBeNull();
    expect(byId.P2.final_rank).toBeNull();
    expect(byId.P1.tie_flag).toBe(true);
    expect(byId.P2.tie_flag).toBe(true);
    expect(db.notifyTieBreakRequired).toHaveBeenCalledWith('E1', 'SG1', expect.arrayContaining(['P1', 'P2']));
  });

  test('only 2 contestants -> prize_place is NULL even for the winner', async () => {
    const criteria = [{ criterion_id: 'c1', name: 'Overall', max_score: 100 }];
    const scores = [
      scoreRow('P1', 1, 'J1', 'c1', 90),
      scoreRow('P2', 2, 'J1', 'c1', 80),
      scoreRow('P1', 1, 'J2', 'c1', 90),
      scoreRow('P2', 2, 'J2', 'c1', 80),
      scoreRow('P1', 1, 'J3', 'c1', 90),
      scoreRow('P2', 2, 'J3', 'c1', 80),
    ];
    const yearConfig = { ...baseYearConfig, no_prize_below: 3 };
    const db = makeDb({ scores, criteria, yearConfig });

    const { results } = await calculateEventResult('E1', 'SG1', db);
    const byId = Object.fromEntries(results.map((r) => [r.participant_id, r]));

    expect(byId.P1.final_rank).toBe(1);
    expect(byId.P1.prize_place).toBeNull();
    expect(byId.P2.prize_place).toBeNull();
  });

  test('participation bonus is added to every participant total_points', async () => {
    const criteria = [{ criterion_id: 'c1', name: 'Overall', max_score: 100 }];
    const scores = [
      scoreRow('P1', 1, 'J1', 'c1', 90),
      scoreRow('P2', 2, 'J1', 'c1', 10),
      scoreRow('P1', 1, 'J2', 'c1', 90),
      scoreRow('P2', 2, 'J2', 'c1', 10),
      scoreRow('P1', 1, 'J3', 'c1', 90),
      scoreRow('P2', 2, 'J3', 'c1', 10),
    ];
    const yearConfig = { ...baseYearConfig, participation_bonus_pts: 7 };
    const db = makeDb({ scores, criteria, yearConfig });

    const { results } = await calculateEventResult('E1', 'SG1', db);
    for (const r of results) {
      expect(r.participation_bonus_pts).toBe(7);
      expect(r.total_points).toBeGreaterThanOrEqual(7);
    }
  });
});

describe('grade thresholds', () => {
  const thresholds = [
    { grade: 'A', min_pct: 70 },
    { grade: 'B', min_pct: 50 },
    { grade: 'C', min_pct: 35 },
  ];

  test('70% -> A', () => {
    expect(_internal.gradeForPct(70, thresholds)).toBe('A');
  });

  test('69.9% -> B', () => {
    expect(_internal.gradeForPct(69.9, thresholds)).toBe('B');
  });
});

describe('detectDivergence', () => {
  test('25 participants, 20% pct (threshold=5): span of 8 triggers an alert', () => {
    const results = [
      {
        participant_id: 'P1',
        chest_no: 11,
        final_rank: 1,
        prize_place: 1,
        judge_ranks: { J1: 1, J2: 1, J3: 9 },
        divergence_flag: false,
        divergence_notes: null,
      },
    ];

    const alerts = detectDivergence(results, 25, 20);

    expect(alerts).toHaveLength(1);
    expect(alerts[0].chest_no).toBe(11);
    expect(alerts[0].threshold_used).toBe(5);
    expect(results[0].divergence_flag).toBe(true);
  });

  test('10 participants, 20% pct (threshold=2): span of 2 does NOT trigger an alert', () => {
    const results = [
      {
        participant_id: 'P1',
        chest_no: 21,
        final_rank: 1,
        prize_place: 1,
        judge_ranks: { J1: 1, J2: 2, J3: 3 },
        divergence_flag: false,
        divergence_notes: null,
      },
    ];

    const alerts = detectDivergence(results, 10, 20);

    expect(alerts).toHaveLength(0);
    expect(results[0].divergence_flag).toBe(false);
  });
});

describe('resolveExactTie', () => {
  test('re-ranks a tied group using summed tiebreaker marks, higher wins', async () => {
    const tiedResults = [
      { participant_id: 'P1', chest_no: 1, final_rank: 1 },
      { participant_id: 'P2', chest_no: 2, final_rank: 1 },
    ];
    const tiebreakerMarks = [
      { participant_id: 'P1', judge_id: 'J1', mark: 7 },
      { participant_id: 'P1', judge_id: 'J2', mark: 8 },
      { participant_id: 'P1', judge_id: 'J3', mark: 6 },
      { participant_id: 'P2', judge_id: 'J1', mark: 9 },
      { participant_id: 'P2', judge_id: 'J2', mark: 9 },
      { participant_id: 'P2', judge_id: 'J3', mark: 9 },
    ];
    const db = makeDb({ scores: [], criteria: [], yearConfig: baseYearConfig, tiebreakerMarks, tiedResults });

    const resolved = await resolveExactTie('E1', 'SG1', db);

    expect(resolved[0].participant_id).toBe('P2'); // 27 total marks
    expect(resolved[0].final_rank).toBe(1);
    expect(resolved[1].participant_id).toBe('P1'); // 21 total marks
    expect(resolved[1].final_rank).toBe(2);
    expect(db.saveEventResults).toHaveBeenCalledTimes(1);
  });
});
