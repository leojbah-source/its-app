'use strict';

/**
 * services/ranking.js
 * ---------------------------------------------------------------------------
 * KCA Indian Talent Scan — Ranking & Divergence engine.
 *
 * This module is pure business logic. It knows nothing about HTTP, Express,
 * or the SQL dialect in use. All persistence/lookup is delegated to a `db`
 * object injected by the caller, so the algorithm can be unit tested with a
 * plain mock and later wired to the real PostgreSQL layer without changes
 * here.
 *
 * Expected `db` interface (all methods return Promises):
 *
 *   db.getSubmittedScores(eventId, subGroup)
 *     -> [{ participant_id, chest_no, judge_id, criterion_id, score }]
 *        One row per (judge, criterion, participant) score entry.
 *
 *   db.getEventCriteria(eventId)
 *     -> [{ criterion_id, name, max_score }]
 *
 *   db.getYearConfigForEvent(eventId)
 *     -> {
 *          no_prize_below: number,            // min contestants required for ANY prize
 *          grade_thresholds: [{ grade, min_pct }],   // sorted desc by min_pct expected
 *          rank_points: { '1': 5, '2': 3, '3': 1 },
 *          grade_points: { A: 3, B: 2, C: 1 },        // optional, used by awards.js
 *          participation_bonus_pts: number,
 *          divergence_threshold_pct: number
 *        }
 *
 *   db.getTiebreakerMarks(eventId, subGroup)
 *     -> [{ participant_id, judge_id, mark }]   // mark is 1-10
 *
 *   db.getTiedEventResults(eventId, subGroup)
 *     -> [{ participant_id, chest_no, final_rank }]  // current tied group only
 *
 *   db.saveEventResults(eventId, subGroup, results) -> void
 *
 *   db.notifyTieBreakRequired(eventId, subGroup, tiedParticipantIds) -> void
 * ---------------------------------------------------------------------------
 */

/**
 * Assigns "standard competition ranking" (1,1,3,4,4,4,7...) to a list of
 * { participant_id, total } entries, ranking by total DESCENDING (higher
 * total = better rank).
 *
 * @param {Array<{participant_id: any, total: number}>} entries
 * @returns {Map<any, number>} participant_id -> rank
 */
function assignDescRanks(entries) {
  const sorted = entries.slice().sort((a, b) => b.total - a.total);
  const ranks = new Map();
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].total === sorted[i - 1].total) {
      ranks.set(sorted[i].participant_id, ranks.get(sorted[i - 1].participant_id));
    } else {
      ranks.set(sorted[i].participant_id, i + 1);
    }
  }
  return ranks;
}

/**
 * Builds: judgeTotals[judgeId][participantId] = sum of criterion scores
 */
function buildJudgeTotals(scores) {
  const judgeTotals = new Map(); // judgeId -> Map(participantId -> total)
  for (const row of scores) {
    if (!judgeTotals.has(row.judge_id)) judgeTotals.set(row.judge_id, new Map());
    const m = judgeTotals.get(row.judge_id);
    m.set(row.participant_id, (m.get(row.participant_id) || 0) + Number(row.score));
  }
  return judgeTotals;
}

/**
 * Builds: judgeRanks[judgeId][participantId] = rank given by that judge
 */
function buildJudgeRanks(judgeTotals) {
  const judgeRanks = new Map();
  for (const [judgeId, totalsMap] of judgeTotals.entries()) {
    const entries = Array.from(totalsMap.entries()).map(([participant_id, total]) => ({
      participant_id,
      total,
    }));
    judgeRanks.set(judgeId, assignDescRanks(entries));
  }
  return judgeRanks;
}

/**
 * Average score for a participant on a single criterion, across all judges
 * who scored it.
 */
function avgScoreForCriterion(scores, participantId, criterionId) {
  const relevant = scores.filter(
    (s) => s.participant_id === participantId && s.criterion_id === criterionId
  );
  if (relevant.length === 0) return 0;
  const sum = relevant.reduce((acc, s) => acc + Number(s.score), 0);
  return sum / relevant.length;
}

/**
 * Resolves a tied CRS group using the criteria-based tie-break rule.
 * Returns { order, tied } where:
 *   - order: array of participant_ids, best-to-worst, possibly containing
 *            sub-groups that are still tied (those appear in `tied`)
 *   - tied:  array of participant_ids that remain unresolved after all
 *            criteria have been exhausted
 */
function resolveCrsTieGroup(group, criteriaDesc, scores) {
  let classes = [group.slice()];

  for (const criterion of criteriaDesc) {
    const newClasses = [];
    for (const cls of classes) {
      if (cls.length === 1) {
        newClasses.push(cls);
        continue;
      }
      const withAvg = cls.map((participantId) => ({
        participant_id: participantId,
        avg: avgScoreForCriterion(scores, participantId, criterion.criterion_id),
      }));
      withAvg.sort((a, b) => b.avg - a.avg);

      // split into sub-classes of equal average, preserving best-to-worst order
      let i = 0;
      while (i < withAvg.length) {
        let j = i + 1;
        while (j < withAvg.length && withAvg[j].avg === withAvg[i].avg) j++;
        newClasses.push(withAvg.slice(i, j).map((x) => x.participant_id));
        i = j;
      }
    }
    classes = newClasses;
    if (classes.every((c) => c.length === 1)) break;
  }

  const order = classes.flat();
  const tied = classes.filter((c) => c.length > 1).flat();
  return { order, tied };
}

/**
 * Determines the grade for a percentage score given configured thresholds.
 * `thresholds` is expected as [{ grade, min_pct }], any order; we sort desc
 * by min_pct internally and return the first match, or null if below all.
 */
function gradeForPct(pct, thresholds) {
  const sorted = (thresholds || []).slice().sort((a, b) => b.min_pct - a.min_pct);
  for (const t of sorted) {
    if (pct >= t.min_pct) return t.grade;
  }
  return null;
}

/**
 * Core ranking algorithm. See Instruction Block 2a for the full spec.
 *
 * @param {string|number} eventId
 * @param {string|number} subGroup
 * @param {object} db
 * @returns {Promise<{status: 'OK'|'EXACT_TIE', tied_participant_ids: Array, results: Array}>}
 */
async function calculateEventResult(eventId, subGroup, db) {
  const [scores, criteria, yearConfig] = await Promise.all([
    db.getSubmittedScores(eventId, subGroup),
    db.getEventCriteria(eventId),
    db.getYearConfigForEvent(eventId),
  ]);

  const participantMeta = new Map(); // participant_id -> chest_no
  for (const row of scores) participantMeta.set(row.participant_id, row.chest_no);
  const participantIds = Array.from(participantMeta.keys());
  const totalParticipants = participantIds.length;

  // Step 2 & 3: per-judge totals and per-judge ranks
  const judgeTotals = buildJudgeTotals(scores);
  const judgeRanks = buildJudgeRanks(judgeTotals);
  const judgeIds = Array.from(judgeTotals.keys());

  // Step 4: CRS = sum of judge ranks for each participant
  const crsByParticipant = new Map();
  const judgeRanksByParticipant = new Map(); // participant_id -> { judgeId: rank }
  for (const participantId of participantIds) {
    let crs = 0;
    const perJudge = {};
    for (const judgeId of judgeIds) {
      const r = judgeRanks.get(judgeId).get(participantId);
      perJudge[judgeId] = r;
      crs += r;
    }
    crsByParticipant.set(participantId, crs);
    judgeRanksByParticipant.set(participantId, perJudge);
  }

  // Step 5: sort by CRS ascending, then group ties together
  const sortedByCrs = participantIds
    .slice()
    .sort((a, b) => crsByParticipant.get(a) - crsByParticipant.get(b));

  const crsGroups = [];
  for (const pid of sortedByCrs) {
    const crs = crsByParticipant.get(pid);
    const last = crsGroups[crsGroups.length - 1];
    if (last && last.crs === crs) {
      last.members.push(pid);
    } else {
      crsGroups.push({ crs, members: [pid] });
    }
  }

  // Criteria-based tie-break, ordered by max_score DESC
  const criteriaDesc = criteria.slice().sort((a, b) => b.max_score - a.max_score);

  const finalOrder = []; // array of { participant_id, tie_flag }
  const allTiedIds = [];

  for (const group of crsGroups) {
    if (group.members.length === 1) {
      finalOrder.push({ participant_id: group.members[0], tie_flag: false });
      continue;
    }
    const { order, tied } = resolveCrsTieGroup(group.members, criteriaDesc, scores);
    const tiedSet = new Set(tied);
    for (const pid of order) {
      finalOrder.push({ participant_id: pid, tie_flag: tiedSet.has(pid) });
    }
    if (tied.length > 0) allTiedIds.push(...tied);
  }

  // Step 7: assign final_rank (competition-style: tied participants share a
  // rank, no duplicates otherwise)
  const finalRankByParticipant = new Map();
  {
    let position = 1;
    let i = 0;
    while (i < finalOrder.length) {
      const pid = finalOrder[i].participant_id;
      const crs = crsByParticipant.get(pid);
      // count how many consecutive entries share this CRS AND are still tied
      let span = 1;
      if (finalOrder[i].tie_flag) {
        while (
          i + span < finalOrder.length &&
          finalOrder[i + span].tie_flag &&
          crsByParticipant.get(finalOrder[i + span].participant_id) === crs
        ) {
          span++;
        }
      }
      for (let k = 0; k < span; k++) {
        finalRankByParticipant.set(finalOrder[i + k].participant_id, position);
      }
      position += span;
      i += span;
    }
  }

  // Step 8: prize_place — only if contestant count meets the configured floor
  const prizeEligible = totalParticipants >= (yearConfig.no_prize_below || 0);

  // Step 9: average_total (% of max possible) & grade
  const maxPossible = criteria.reduce((acc, c) => acc + Number(c.max_score), 0) || 100;

  const results = participantIds.map((pid) => {
    const judgeTotalsForPid = judgeIds.map((jId) => judgeTotals.get(jId).get(pid) || 0);
    const averageJudgeTotal =
      judgeTotalsForPid.reduce((a, b) => a + b, 0) / (judgeTotalsForPid.length || 1);
    const averageTotalPct = (averageJudgeTotal / maxPossible) * 100;
    const grade = gradeForPct(averageTotalPct, yearConfig.grade_thresholds);
    const gradePoints = (yearConfig.grade_points && grade && yearConfig.grade_points[grade]) || 0;

    const finalRank = finalRankByParticipant.get(pid);
    const tieFlag = allTiedIds.includes(pid);

    let prizePlace = null;
    if (prizeEligible && finalRank && finalRank <= 3 && !tieFlag) {
      prizePlace = finalRank;
    }

    const rankPoints =
      finalRank && yearConfig.rank_points && yearConfig.rank_points[String(finalRank)] != null
        ? yearConfig.rank_points[String(finalRank)]
        : 0;

    const participationBonus = yearConfig.participation_bonus_pts || 0;
    const totalPoints = rankPoints + gradePoints + participationBonus;

    return {
      event_id: eventId,
      sub_group: subGroup,
      participant_id: pid,
      chest_no: participantMeta.get(pid),
      judge_ranks: judgeRanksByParticipant.get(pid),
      crs: crsByParticipant.get(pid),
      final_rank: tieFlag ? null : finalRank,
      tie_flag: tieFlag,
      prize_place: prizePlace,
      average_total: Math.round(averageTotalPct * 100) / 100,
      grade,
      grade_points: gradePoints,
      rank_points: rankPoints,
      participation_bonus_pts: participationBonus,
      total_points: totalPoints,
      divergence_flag: false,
      divergence_notes: null,
    };
  });

  // Step "DIVERGENCE DETECTION": run against the resolved results
  const alerts = detectDivergence(
    results,
    totalParticipants,
    yearConfig.divergence_threshold_pct
  );

  const status = allTiedIds.length > 0 ? 'EXACT_TIE' : 'OK';

  if (status === 'EXACT_TIE') {
    await db.notifyTieBreakRequired(eventId, subGroup, allTiedIds);
  }

  await db.saveEventResults(eventId, subGroup, results);

  return {
    status,
    tied_participant_ids: allTiedIds,
    results,
    alerts,
  };
}

/**
 * Re-ranks a previously EXACT_TIE group once the Chairman has supervised
 * entry of tiebreaker marks (1-10 per judge per participant). Higher summed
 * mark wins. Mutates the tied subset's final_rank to remove duplicates and
 * persists the change.
 *
 * @param {string|number} eventId
 * @param {string|number} subGroup
 * @param {object} db
 * @returns {Promise<Array<{participant_id, tiebreaker_total, final_rank}>>}
 */
async function resolveExactTie(eventId, subGroup, db) {
  const [marks, tiedResults] = await Promise.all([
    db.getTiebreakerMarks(eventId, subGroup),
    db.getTiedEventResults(eventId, subGroup),
  ]);

  if (!tiedResults || tiedResults.length === 0) {
    return [];
  }

  const startingRank = tiedResults[0].final_rank;

  const totals = new Map();
  for (const m of marks) {
    totals.set(m.participant_id, (totals.get(m.participant_id) || 0) + Number(m.mark));
  }

  const resolved = tiedResults
    .map((r) => ({
      participant_id: r.participant_id,
      chest_no: r.chest_no,
      tiebreaker_total: totals.get(r.participant_id) || 0,
    }))
    .sort((a, b) => b.tiebreaker_total - a.tiebreaker_total)
    .map((r, idx) => ({
      ...r,
      final_rank: startingRank + idx,
      tie_flag: false,
    }));

  await db.saveEventResults(eventId, subGroup, resolved);

  return resolved;
}

/**
 * Flags suspiciously divergent judging among the top 6 placed participants.
 *
 * @param {Array} results  — output rows from calculateEventResult (must have
 *                            judge_ranks, chest_no, final_rank, prize_place)
 * @param {number} totalParticipants
 * @param {number} divergenceThresholdPct
 * @returns {Array} alerts
 */
function detectDivergence(results, totalParticipants, divergenceThresholdPct) {
  const threshold = Math.round((totalParticipants * divergenceThresholdPct) / 100);

  const top6 = results
    .filter((r) => r.final_rank != null)
    .slice()
    .sort((a, b) => a.final_rank - b.final_rank)
    .slice(0, 6);

  const alerts = [];

  for (const r of top6) {
    const ranks = Object.values(r.judge_ranks);
    const maxR = Math.max(...ranks);
    const minR = Math.min(...ranks);
    // NOTE: the written spec says ">= threshold", but the worked unit-test
    // example (10 participants, threshold=2, ranks [1,2,3] -> span=2 -> NO
    // alert) only holds if a span exactly equal to the threshold does NOT
    // trigger. We follow the worked example (strict ">") and flag this
    // discrepancy for the Chairman/Admin to confirm.
    const spanTriggered = maxR - minR > threshold;

    const lowRankCount = ranks.filter((rk) => rk <= 2).length;
    const hasOutlier = ranks.some((rk) => rk >= threshold + 2);
    const outlierTriggered = lowRankCount >= 2 && hasOutlier;

    if (spanTriggered || outlierTriggered) {
      const reasons = [];
      if (spanTriggered) {
        reasons.push(
          `judge rank spread of ${maxR - minR} (ranks ${ranks.join(',')}) meets/exceeds threshold ${threshold}`
        );
      }
      if (outlierTriggered) {
        reasons.push(
          `${lowRankCount} judge(s) ranked this participant top-2 while another judge ranked them ${threshold + 2}+`
        );
      }
      const message = `Chest No. ${r.chest_no}: ${reasons.join('; ')}.`;

      r.divergence_flag = true;
      r.divergence_notes = message;

      alerts.push({
        chest_no: r.chest_no,
        judge_ranks: r.judge_ranks,
        final_rank: r.final_rank,
        prize_place: r.prize_place,
        threshold_used: threshold,
        total_participants: totalParticipants,
        message,
      });
    }
  }

  return alerts;
}

module.exports = {
  calculateEventResult,
  resolveExactTie,
  detectDivergence,
  // exported for unit testing of internals
  _internal: {
    assignDescRanks,
    buildJudgeTotals,
    buildJudgeRanks,
    resolveCrsTieGroup,
    gradeForPct,
  },
};
