'use strict';

/**
 * services/scheduler.js
 * ---------------------------------------------------------------------------
 * KCA Indian Talent Scan — Auto Schedule Draft generator (Rule #26).
 *
 * Produces a conflict-free, judge-efficient DRAFT schedule from Admin-supplied
 * venue/time configuration. This is explicitly a draft: it requires Chairman
 * review and Admin publish before it governs the event day. Nothing here
 * writes to any "live" schedule table — only to a draft table via
 * db.saveScheduleDraft.
 *
 * Pure business logic — no HTTP/Express/SQL here. All persistence/lookup is
 * delegated to an injected `db` object so the algorithm can be unit tested
 * with a plain mock.
 *
 * Expected `db` interface (all methods return Promises):
 *
 *   db.getActiveEventsForYear(yearId)
 *     -> [{ event_id, name, category, duration_minutes }]
 *        Only events that are active (not cancelled) for the year.
 *
 *   db.getEventParticipants(yearId)
 *     -> [{ event_id, participant_id }]
 *        One row per registered participant per event (team events should
 *        list every team member so individual conflicts are still caught).
 *
 *   db.saveScheduleDraft(yearId, draft) -> void
 *        draft = { status, scheduled, unplaced, generated_at }
 *
 * `config` shape (Admin input, not stored by this module):
 *   {
 *     startDate: 'YYYY-MM-DD',
 *     endDate: 'YYYY-MM-DD',
 *     dailySlots: [
 *       { date: 'YYYY-MM-DD', blocks: [ { start: 'HH:MM', end: 'HH:MM', venues: ['Main Hall', 'Stage B'] } ] }
 *     ],
 *     reportingBufferMinutes: 30
 *   }
 */

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(total) {
  const clamped = Math.max(0, Math.round(total));
  const h = Math.floor(clamped / 60) % 24;
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ---------------------------------------------------------------------------
// Scheduling state helpers
// ---------------------------------------------------------------------------

/**
 * True if every participant in `participantIds` has fewer than 2 events
 * already booked on `date`. The >2-events-per-day cap is venue/time
 * independent, so this is checked once per (event, date) before bothering
 * to search blocks/venues for that date at all.
 */
function canPlaceOnDate(date, participantIds, dailyCounts) {
  return participantIds.every((pid) => (dailyCounts[pid]?.[date] || 0) < 2);
}

/**
 * Orders a block's venues to prefer stages that already host the same
 * category that day (judge efficiency / clustering), falling back to the
 * Admin-supplied venue order as a stable tie-break.
 */
function orderVenuesByClusterPreference(venues, date, category, categoryVenueUse) {
  return venues
    .map((venue, idx) => ({
      venue,
      idx,
      clusterScore: categoryVenueUse[date]?.[venue]?.[category] || 0,
    }))
    .sort((a, b) => b.clusterScore - a.clusterScore || a.idx - b.idx)
    .map((v) => v.venue);
}

/**
 * Finds the earliest [start, start+duration] window inside `block` on
 * `venue`/`date` that conflicts with neither existing venue bookings nor any
 * existing booking for the event's participants. Advances the candidate
 * start time past whichever conflict it hits and retries, bounded by a
 * sanity iteration cap so a pathological set of bookings can't loop forever.
 *
 * Returns { start, end } in minutes-from-midnight, or null if no window fits
 * inside the block.
 */
function findPlacement({
  date,
  block,
  venue,
  durationMinutes,
  venueBookings,
  participantIds,
  participantBookings,
}) {
  const blockEnd = timeToMinutes(block.end);
  let candidateStart = timeToMinutes(block.start);
  const MAX_ITERATIONS = 200;

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    if (candidateStart + durationMinutes > blockEnd) return null;
    const candidateEnd = candidateStart + durationMinutes;

    const venueBusy = venueBookings[date]?.[venue] || [];
    const venueConflict = venueBusy.find((b) => overlaps(candidateStart, candidateEnd, b.start, b.end));
    if (venueConflict) {
      candidateStart = venueConflict.end;
      continue;
    }

    let participantConflict = null;
    for (const pid of participantIds) {
      const busy = participantBookings[pid]?.[date] || [];
      const hit = busy.find((b) => overlaps(candidateStart, candidateEnd, b.start, b.end));
      if (hit) {
        participantConflict = hit;
        break;
      }
    }
    if (participantConflict) {
      candidateStart = Math.max(candidateStart, participantConflict.end);
      continue;
    }

    return { start: candidateStart, end: candidateEnd };
  }
  return null;
}

function commitPlacement({
  event,
  date,
  venue,
  start,
  end,
  reportingBufferMinutes,
  venueBookings,
  participantBookings,
  dailyCounts,
  categoryVenueUse,
  participantIds,
}) {
  venueBookings[date] ??= {};
  venueBookings[date][venue] ??= [];
  venueBookings[date][venue].push({ start, end, event_id: event.event_id });

  categoryVenueUse[date] ??= {};
  categoryVenueUse[date][venue] ??= {};
  categoryVenueUse[date][venue][event.category] = (categoryVenueUse[date][venue][event.category] || 0) + 1;

  participantIds.forEach((pid) => {
    participantBookings[pid] ??= {};
    participantBookings[pid][date] ??= [];
    participantBookings[pid][date].push({ start, end });

    dailyCounts[pid] ??= {};
    dailyCounts[pid][date] = (dailyCounts[pid][date] || 0) + 1;
  });

  return {
    event_id: event.event_id,
    date,
    start_time: minutesToTime(start),
    end_time: minutesToTime(end),
    venue,
    reporting_time: minutesToTime(start - reportingBufferMinutes),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * generateScheduleDraft(yearId, config, db) -> { status, scheduled, unplaced }
 *
 * Greedy placement, longest events first:
 *   1. Find the earliest date/block/venue with no participant conflicts and
 *      no participant exceeding 2 events that day.
 *   2. Among equally-early options, prefer a venue already hosting the same
 *      category that day (judge efficiency / clustering).
 *   3. Events that cannot be placed anywhere in the configured window are
 *      returned in `unplaced` with a reason, rather than silently dropped.
 *
 * This function persists the draft via db.saveScheduleDraft but does NOT
 * publish anything — per Rule #26 / #13 the Chairman must review and Admin
 * must explicitly publish before this becomes the live schedule.
 */
async function generateScheduleDraft(yearId, config, db) {
  const events = await db.getActiveEventsForYear(yearId);
  const participantRows = await db.getEventParticipants(yearId);

  const participantsByEvent = {};
  participantRows.forEach((row) => {
    participantsByEvent[row.event_id] ??= [];
    participantsByEvent[row.event_id].push(row.participant_id);
  });

  const dailySlots = [...(config.dailySlots || [])]
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((day) => ({
      ...day,
      blocks: [...day.blocks].sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start)),
    }));

  const reportingBufferMinutes = config.reportingBufferMinutes ?? 30;

  // Longest events first; same-category events kept adjacent in the queue as
  // a mild nudge toward clustering; event_id breaks remaining ties so the
  // draft is deterministic given the same inputs.
  const queue = [...events].sort((a, b) => {
    if (b.duration_minutes !== a.duration_minutes) return b.duration_minutes - a.duration_minutes;
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return String(a.event_id).localeCompare(String(b.event_id));
  });

  const venueBookings = {}; // date -> venue -> [{start, end, event_id}]
  const participantBookings = {}; // participant_id -> date -> [{start, end}]
  const dailyCounts = {}; // participant_id -> date -> count
  const categoryVenueUse = {}; // date -> venue -> category -> count

  const scheduled = [];
  const unplaced = [];

  for (const event of queue) {
    const participantIds = participantsByEvent[event.event_id] || [];
    let placed = null;

    for (const day of dailySlots) {
      if (!canPlaceOnDate(day.date, participantIds, dailyCounts)) continue;

      for (const block of day.blocks) {
        const venueOrder = orderVenuesByClusterPreference(block.venues, day.date, event.category, categoryVenueUse);

        for (const venue of venueOrder) {
          const window = findPlacement({
            date: day.date,
            block,
            venue,
            durationMinutes: event.duration_minutes,
            venueBookings,
            participantIds,
            participantBookings,
          });

          if (window) {
            placed = commitPlacement({
              event,
              date: day.date,
              venue,
              start: window.start,
              end: window.end,
              reportingBufferMinutes,
              venueBookings,
              participantBookings,
              dailyCounts,
              categoryVenueUse,
              participantIds,
            });
            break;
          }
        }
        if (placed) break;
      }
      if (placed) break;
    }

    if (placed) {
      scheduled.push(placed);
    } else {
      unplaced.push({
        event_id: event.event_id,
        name: event.name,
        category: event.category,
        duration_minutes: event.duration_minutes,
        reason: 'NO_CONFLICT_FREE_SLOT_IN_CONFIGURED_WINDOW',
      });
    }
  }

  const draft = {
    status: unplaced.length === 0 ? 'OK' : 'PARTIAL',
    scheduled,
    unplaced,
    generated_at: new Date().toISOString(),
  };

  await db.saveScheduleDraft(yearId, draft);
  return draft;
}

module.exports = {
  generateScheduleDraft,
  _internal: {
    timeToMinutes,
    minutesToTime,
    overlaps,
    canPlaceOnDate,
    orderVenuesByClusterPreference,
    findPlacement,
  },
};
