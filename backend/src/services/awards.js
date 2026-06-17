'use strict';

/**
 * services/awards.js
 * ---------------------------------------------------------------------------
 * KCA Indian Talent Scan — Award computation engine.
 *
 * Computes, for a given year: Group Championships, KCA Special Group
 * Championships, Kalathilakam/Kalaprathibha, Ratna Awards (per category),
 * School Awards, and Teacher Awards.
 *
 * Expected `db` interface (all methods return Promises):
 *
 *   db.getYearConfig(yearId)
 *     -> {
 *          kca_special_min_points: number,
 *          category_cap: number,              // max results counted per category per participant
 *          teacher_name_deadline: string|Date,
 *          rank_points: { '1':5, '2':3, '3':1 },
 *          grade_points: { A:3, B:2, C:1 },
 *          participation_bonus_pts: number
 *        }
 *
 *   db.getEventResultsForYear(yearId)
 *     -> [{
 *          participant_id, event_id, category, age_group, gender,
 *          is_team_event, prize_place, grade, rank_points, grade_points,
 *          participation_bonus_pts, total_points
 *        }]
 *        One row per (participant, event) result for the year.
 *
 *   db.getParticipants(yearId)
 *     -> [{ participant_id, name, age_group, gender, school_id,
 *           kca_member, kca_verified }]
 *
 *   db.getSchools(yearId) -> [{ school_id, name }]
 *
 *   db.getRegistrationsWithTeachers(yearId)
 *     -> [{ participant_id, event_id, dance_teacher, music_teacher, teacher_entered_at }]
 *
 *   db.getTeacherAliases()
 *     -> [{ raw_name, canonical_name }]
 *
 *   db.saveAwards(yearId, awards) -> void
 * ---------------------------------------------------------------------------
 */

/** Tiebreak chain: most 1sts -> most 2nds -> most 3rds -> team points -> flag */
function compareByTiebreakChain(a, b) {
  if (b.total_points !== a.total_points) return b.total_points - a.total_points;
  if (b.firsts !== a.firsts) return b.firsts - a.firsts;
  if (b.seconds !== a.seconds) return b.seconds - a.seconds;
  if (b.thirds !== a.thirds) return b.thirds - a.thirds;
  if (b.team_points !== a.team_points) return b.team_points - a.team_points;
  return 0; // still tied -> caller must flag for manual resolution
}

/**
 * Builds a per-participant aggregate summary from raw event_results rows.
 */
function buildParticipantSummaries(results, participants) {
  const summaries = new Map();
  const byParticipant = new Map(); // participant_id -> [results]

  for (const r of results) {
    if (!byParticipant.has(r.participant_id)) byParticipant.set(r.participant_id, []);
    byParticipant.get(r.participant_id).push(r);
  }

  for (const p of participants) {
    const rows = byParticipant.get(p.participant_id) || [];
    const firsts = rows.filter((r) => r.prize_place === 1).length;
    const seconds = rows.filter((r) => r.prize_place === 2).length;
    const thirds = rows.filter((r) => r.prize_place === 3).length;
    const distinctPrizeCategories = new Set(
      rows.filter((r) => r.prize_place != null).map((r) => r.category)
    );
    const hasTeamEvent = rows.some((r) => r.is_team_event);
    const hasTeamEventWithAOrB = rows.some(
      (r) => r.is_team_event && (r.grade === 'A' || r.grade === 'B')
    );
    const hasGradeA = rows.some((r) => r.grade === 'A');
    const teamPoints = rows
      .filter((r) => r.is_team_event)
      .reduce((acc, r) => acc + (r.total_points || 0), 0);
    const totalPoints = rows.reduce((acc, r) => acc + (r.total_points || 0), 0);

    summaries.set(p.participant_id, {
      participant_id: p.participant_id,
      name: p.name,
      age_group: p.age_group,
      gender: p.gender,
      school_id: p.school_id,
      kca_member: Boolean(p.kca_member),
      kca_verified: Boolean(p.kca_verified),
      rows,
      firsts,
      seconds,
      thirds,
      distinct_prize_categories: distinctPrizeCategories.size,
      has_team_event: hasTeamEvent,
      has_team_event_a_or_b: hasTeamEventWithAOrB,
      has_grade_a: hasGradeA,
      team_points: teamPoints,
      total_points: totalPoints,
    });
  }

  return summaries;
}

/** Group-championship base eligibility (also reused, with extra checks, for Kalathilakam/Kalaprathibha). */
function isGroupChampionEligible(summary) {
  return (
    summary.firsts >= 1 &&
    summary.has_grade_a &&
    summary.distinct_prize_categories >= 3 &&
    summary.has_team_event
  );
}

function pickBest(candidates) {
  if (candidates.length === 0) return null;
  const sorted = candidates.slice().sort(compareByTiebreakChain);
  const winner = sorted[0];
  const stillTied =
    sorted.length > 1 && compareByTiebreakChain(sorted[0], sorted[1]) === 0;
  return { winner, stillTied, ranked: sorted };
}

/** 1. GROUP CHAMPIONSHIP — one per age group, gender-agnostic. */
function computeGroupChampionships(summariesByGroup) {
  const result = new Map(); // age_group -> { ranked candidate list }
  for (const [group, summaries] of summariesByGroup.entries()) {
    const eligible = summaries.filter(isGroupChampionEligible);
    const pick = pickBest(eligible);
    result.set(group, pick); // null if nobody eligible
  }
  return result;
}

/** 2. KCA SPECIAL GROUP CHAMPIONSHIP — only if the Group Champion is not a KCA member. */
function computeKcaSpecialChampionships(summariesByGroup, groupChampionships, kcaSpecialMinPoints) {
  const result = new Map();
  for (const [group, summaries] of summariesByGroup.entries()) {
    const champ = groupChampionships.get(group);
    const championIsMember = champ && champ.winner && champ.winner.kca_member;
    if (championIsMember) {
      result.set(group, null);
      continue;
    }
    const eligible = summaries.filter(
      (s) => s.kca_member && s.kca_verified && s.total_points >= kcaSpecialMinPoints
    );
    result.set(group, pickBest(eligible));
  }
  return result;
}

/**
 * Recomputes a category-capped total for a participant: only the top
 * `categoryCap` results (by total_points) within each category contribute.
 */
function categoryCappedTotal(summary, categoryCap) {
  const byCategory = new Map();
  for (const r of summary.rows) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  let total = 0;
  for (const rows of byCategory.values()) {
    const top = rows
      .slice()
      .sort((a, b) => (b.total_points || 0) - (a.total_points || 0))
      .slice(0, categoryCap);
    total += top.reduce((acc, r) => acc + (r.total_points || 0), 0);
  }
  return total;
}

/** 3. KALATHILAKAM (girl) & KALAPRATHIBHA (boy) — per age group, with category cap applied. */
function computeTitleWinners(summariesByGroup, categoryCap) {
  const result = new Map(); // age_group -> { kalathilakam, kalaprathibha }
  for (const [group, summaries] of summariesByGroup.entries()) {
    const eligible = summaries
      .filter(isGroupChampionEligible)
      .filter((s) => s.has_team_event_a_or_b)
      .map((s) => ({ ...s, total_points: categoryCappedTotal(s, categoryCap) }));

    const girls = eligible.filter((s) => s.gender === 'F');
    const boys = eligible.filter((s) => s.gender === 'M');

    result.set(group, {
      kalathilakam: pickBest(girls),
      kalaprathibha: pickBest(boys),
    });
  }
  return result;
}

/**
 * Applies the rule: "If a title winner also wins the Group Championship,
 * award the Group Championship to the next eligible candidate."
 * Mutates nothing; returns a new Map of resolved group championships.
 */
function reassignGroupChampionsClashingWithTitles(groupChampionships, titleWinners) {
  const resolved = new Map();
  for (const [group, champ] of groupChampionships.entries()) {
    const titles = titleWinners.get(group) || {};
    const titleWinnerIds = new Set(
      [titles.kalathilakam, titles.kalaprathibha]
        .filter((t) => t && t.winner)
        .map((t) => t.winner.participant_id)
    );

    if (!champ || !champ.winner || !titleWinnerIds.has(champ.winner.participant_id)) {
      resolved.set(group, champ);
      continue;
    }

    // step down the ranked list to the next candidate not holding a title
    const nextCandidate = (champ.ranked || []).find(
      (c) => !titleWinnerIds.has(c.participant_id)
    );
    if (!nextCandidate) {
      resolved.set(group, null);
    } else {
      const remaining = champ.ranked.filter((c) => c.participant_id !== champ.winner.participant_id);
      const stillTied =
        remaining.length > 1 &&
        compareByTiebreakChain(remaining[0], remaining[1]) === 0 &&
        remaining[0].participant_id === nextCandidate.participant_id;
      resolved.set(group, { winner: nextCandidate, stillTied, ranked: remaining });
    }
  }
  return resolved;
}

/** 4. RATNA AWARDS — per category (e.g. Dance/Song/Arts/Literary), all groups combined. */
function computeRatnaAwards(results, participantsByid) {
  const byCategory = new Map();
  for (const r of results) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, new Map());
    const m = byCategory.get(r.category);
    if (!m.has(r.participant_id)) {
      m.set(r.participant_id, { participant_id: r.participant_id, total_points: 0, firsts: 0, seconds: 0, thirds: 0, team_points: 0 });
    }
    const acc = m.get(r.participant_id);
    acc.total_points += r.total_points || 0;
    if (r.prize_place === 1) acc.firsts += 1;
    if (r.prize_place === 2) acc.seconds += 1;
    if (r.prize_place === 3) acc.thirds += 1;
    if (r.is_team_event) acc.team_points += r.total_points || 0;
  }

  const awards = new Map();
  for (const [category, m] of byCategory.entries()) {
    const candidates = Array.from(m.values());
    const pick = pickBest(candidates);
    if (pick && pick.winner) {
      pick.winner = { ...pick.winner, ...(participantsByid.get(pick.winner.participant_id) || {}) };
    }
    awards.set(category, pick);
  }
  return awards;
}

/** 5. SCHOOL AWARDS — sum(rank_points + grade_points + participation_bonus_pts) per school. */
function computeSchoolAwards(results, schools, participants) {
  const schoolByParticipant = new Map(participants.map((p) => [p.participant_id, p.school_id]));
  const totals = new Map(schools.map((s) => [s.school_id, 0]));

  for (const r of results) {
    const schoolId = schoolByParticipant.get(r.participant_id);
    if (schoolId == null || !totals.has(schoolId)) continue;
    const points = (r.rank_points || 0) + (r.grade_points || 0) + (r.participation_bonus_pts || 0);
    totals.set(schoolId, totals.get(schoolId) + points);
  }

  return schools
    .map((s) => ({ school_id: s.school_id, name: s.name, total_points: totals.get(s.school_id) || 0 }))
    .sort((a, b) => b.total_points - a.total_points);
}

/** 6. TEACHER AWARDS — group by canonical teacher name, excluding NOT_APPLICABLE & late entries. */
function computeTeacherAwards(registrations, results, aliasRows, teacherNameDeadline) {
  const aliasMap = new Map((aliasRows || []).map((a) => [a.raw_name, a.canonical_name]));
  const resultByParticipantEvent = new Map(
    results.map((r) => [`${r.participant_id}::${r.event_id}`, r])
  );

  const canonicalize = (rawName) => aliasMap.get(rawName) || rawName;

  const isOnTime = (enteredAt) => {
    if (!teacherNameDeadline) return true;
    return new Date(enteredAt) <= new Date(teacherNameDeadline);
  };

  const teacherTotals = new Map(); // canonical_name -> { participants: Set, rank_points, grade_points }

  for (const reg of registrations) {
    if (!isOnTime(reg.teacher_entered_at)) continue;

    const rawNames = [reg.dance_teacher, reg.music_teacher].filter(
      (t) => t && t !== 'NOT_APPLICABLE'
    );
    if (rawNames.length === 0) continue;

    const result = resultByParticipantEvent.get(`${reg.participant_id}::${reg.event_id}`);

    for (const rawName of rawNames) {
      const canonical = canonicalize(rawName);
      if (!teacherTotals.has(canonical)) {
        teacherTotals.set(canonical, {
          canonical_name: canonical,
          participants: new Set(),
          rank_points: 0,
          grade_points: 0,
        });
      }
      const acc = teacherTotals.get(canonical);
      acc.participants.add(reg.participant_id);
      if (result) {
        acc.rank_points += result.rank_points || 0;
        acc.grade_points += result.grade_points || 0;
      }
    }
  }

  return Array.from(teacherTotals.values())
    .map((t) => ({
      canonical_name: t.canonical_name,
      participant_count: t.participants.size,
      rank_points: t.rank_points,
      grade_points: t.grade_points,
      total_points: t.rank_points + t.grade_points,
    }))
    .sort((a, b) => b.total_points - a.total_points);
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

/**
 * Computes the full award set for a year and persists it via db.saveAwards.
 *
 * @param {string|number} yearId
 * @param {object} db
 */
async function calculateAllAwards(yearId, db) {
  const [yearConfig, results, participants, schools, registrations, aliasRows] = await Promise.all([
    db.getYearConfig(yearId),
    db.getEventResultsForYear(yearId),
    db.getParticipants(yearId),
    db.getSchools(yearId),
    db.getRegistrationsWithTeachers(yearId),
    db.getTeacherAliases(),
  ]);

  const participantsByid = new Map(participants.map((p) => [p.participant_id, p]));
  const summaries = buildParticipantSummaries(results, participants);
  const summariesByGroup = groupBy(Array.from(summaries.values()), (s) => s.age_group);

  // 1. Group Championships
  const groupChampionshipsRaw = computeGroupChampionships(summariesByGroup);

  // 3. Title winners (computed before finalising group champs, per the
  //    "winner also wins Group Championship -> reassign" rule)
  const categoryCap = yearConfig.category_cap || Infinity;
  const titleWinners = computeTitleWinners(summariesByGroup, categoryCap);

  const groupChampionships = reassignGroupChampionsClashingWithTitles(
    groupChampionshipsRaw,
    titleWinners
  );

  // 2. KCA Special Group Championships (depends on final group champion identity)
  const kcaSpecialChampionships = computeKcaSpecialChampionships(
    summariesByGroup,
    groupChampionships,
    yearConfig.kca_special_min_points || 0
  );

  // 4. Ratna Awards
  const ratnaAwards = computeRatnaAwards(results, participantsByid);

  // 5. School Awards
  const schoolAwards = computeSchoolAwards(results, schools, participants);

  // 6. Teacher Awards
  const teacherAwards = computeTeacherAwards(
    registrations,
    results,
    aliasRows,
    yearConfig.teacher_name_deadline
  );

  const awards = {
    year_id: yearId,
    group_championships: Object.fromEntries(
      Array.from(groupChampionships.entries()).map(([group, pick]) => [
        group,
        pick && pick.winner ? { ...pick.winner, tie_flag: Boolean(pick.stillTied) } : null,
      ])
    ),
    kca_special_group_championships: Object.fromEntries(
      Array.from(kcaSpecialChampionships.entries()).map(([group, pick]) => [
        group,
        pick && pick.winner ? { ...pick.winner, tie_flag: Boolean(pick.stillTied) } : null,
      ])
    ),
    kalathilakam: Object.fromEntries(
      Array.from(titleWinners.entries()).map(([group, t]) => [
        group,
        t.kalathilakam && t.kalathilakam.winner
          ? { ...t.kalathilakam.winner, tie_flag: Boolean(t.kalathilakam.stillTied) }
          : null,
      ])
    ),
    kalaprathibha: Object.fromEntries(
      Array.from(titleWinners.entries()).map(([group, t]) => [
        group,
        t.kalaprathibha && t.kalaprathibha.winner
          ? { ...t.kalaprathibha.winner, tie_flag: Boolean(t.kalaprathibha.stillTied) }
          : null,
      ])
    ),
    ratna_awards: Object.fromEntries(
      Array.from(ratnaAwards.entries()).map(([category, pick]) => [
        category,
        pick && pick.winner ? { ...pick.winner, tie_flag: Boolean(pick.stillTied) } : null,
      ])
    ),
    school_awards: schoolAwards,
    teacher_awards: teacherAwards,
  };

  await db.saveAwards(yearId, awards);

  return awards;
}

module.exports = {
  calculateAllAwards,
  // exported for unit testing of internals
  _internal: {
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
    pickBest,
  },
};
