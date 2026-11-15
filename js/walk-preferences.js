// What the walker asked for, and which cafés and routes fit it best. Pure logic, unit-tested.
//
// How matching works (best effort, and shown to the user as such):
//   - Google has no "cozy" or "coffee flight" field. For each aspect the user picks, the app asks
//     Google's text search for that phrase near them. A café that shows up in that search "matches".
//   - Each café gets a fit score from how many chosen aspects it matches.
//   - The app tries every group of stops within the chosen stop range and keeps the groups with the
//     highest total fit whose walking loop fits the chosen time.

import { haversineDistanceMeters, loopLengthMeters, orderStopsForShortestLoop, AVERAGE_WALKING_SPEED_METERS_PER_SECOND } from "./route-planning.js";
import { coffeeFirstScore, normalizeName } from "./cafe-selection.js";

// `searchText` is what we ask Google's text search for. Edit freely; shorter, plainer phrases tend to work best.
export const ASPECTS = [
  { id: "good-coffee", label: "Good coffee", searchText: "specialty coffee roaster" },
  { id: "coffee-flight", label: "Coffee flight", searchText: "coffee flight tasting" },
  { id: "unique-space", label: "Unique space", searchText: "coffee shop with unique interior" },
  { id: "outdoor-seating", label: "Outdoor seating", searchText: "coffee shop with outdoor seating" },
  { id: "good-conversation", label: "Good conversation", searchText: "quiet coffee shop for conversation" },
  { id: "cozy-quiet", label: "Cozy & quiet", searchText: "cozy quiet coffee shop" },
  { id: "lively-buzzy", label: "Lively & buzzy", searchText: "lively busy coffee shop" },
  { id: "work-friendly", label: "Work-friendly", searchText: "coffee shop to work from with wifi" },
];

export const WALK_MINUTES_OPTIONS = [15, 30, 45, 60];
export const DEFAULT_WALK_MINUTES = 30;
export const STOP_RANGES = {
  "2-3": { minStops: 2, maxStops: 3 },
  "3-4": { minStops: 3, maxStops: 4 },
  "5-6": { minStops: 5, maxStops: 6 },
};
export const DEFAULT_STOP_RANGE_ID = "3-4";

// "Good coffee" also counts a café that is simply rated very highly by many people.
const GOOD_COFFEE_MINIMUM_RATING = 4.5;
const GOOD_COFFEE_MINIMUM_REVIEWS = 100;
// Streets aren't straight lines. Real walking routes are typically about this much longer.
export const STREET_DETOUR_FACTOR = 1.3;
const MINIMUM_SEARCH_RADIUS_METERS = 400;
const MAXIMUM_SEARCH_RADIUS_METERS = 2000;

// How far out to look: a loop that takes the whole time budget reaches roughly a third of its length from the start.
export function searchRadiusMetersForWalk(maxWalkMinutes) {
  const loopMeters = maxWalkMinutes * 60 * AVERAGE_WALKING_SPEED_METERS_PER_SECOND;
  return Math.round(Math.min(Math.max(loopMeters / 3, MINIMUM_SEARCH_RADIUS_METERS), MAXIMUM_SEARCH_RADIUS_METERS));
}

// Combines the plain nearby search with each aspect's text search into one list without duplicates.
// Every café gets `matchedAspectIds`: the chosen aspects whose search it appeared in.
// Text search treats the area as a hint, not a limit, so results beyond the radius are dropped here.
export function mergeCafesWithMatches({ start, radiusMeters, nearbyCafes, cafesByAspectId, selectedAspectIds }) {
  const cafesByPlaceId = new Map();
  const include = (cafe) => {
    if (!cafesByPlaceId.has(cafe.placeId)) cafesByPlaceId.set(cafe.placeId, { ...cafe, matchedAspectIds: [] });
    return cafesByPlaceId.get(cafe.placeId);
  };
  nearbyCafes.forEach(include);
  for (const aspectId of selectedAspectIds) {
    for (const cafe of cafesByAspectId[aspectId] ?? []) {
      if (haversineDistanceMeters(start, cafe.location) > radiusMeters) continue;
      const merged = include(cafe);
      if (!merged.matchedAspectIds.includes(aspectId)) merged.matchedAspectIds.push(aspectId);
    }
  }
  if (selectedAspectIds.includes("good-coffee")) {
    for (const cafe of cafesByPlaceId.values()) {
      const isHighlyRated = cafe.rating >= GOOD_COFFEE_MINIMUM_RATING && cafe.ratingCount >= GOOD_COFFEE_MINIMUM_REVIEWS;
      if (isHighlyRated && !cafe.matchedAspectIds.includes("good-coffee")) cafe.matchedAspectIds.push("good-coffee");
    }
  }
  return [...cafesByPlaceId.values()];
}

// Higher is better: 2 points per chosen aspect matched. The coffee-first score (0–7) is scaled to
// under 1 point, so it only decides between cafés that match the same number of aspects.
export function preferenceFitScore(cafe, selectedAspectIds) {
  const matchedCount = selectedAspectIds.filter((aspectId) => cafe.matchedAspectIds?.includes(aspectId)).length;
  return matchedCount * 2 + coffeeFirstScore(cafe) / 8;
}

// For showing "why this café": labels of the chosen aspects it matched and didn't.
export function matchSummary(cafe, selectedAspectIds) {
  const chosenAspects = ASPECTS.filter((aspect) => selectedAspectIds.includes(aspect.id));
  return {
    matchedLabels: chosenAspects.filter((aspect) => cafe.matchedAspectIds?.includes(aspect.id)).map((aspect) => aspect.label),
    unmatchedLabels: chosenAspects.filter((aspect) => !cafe.matchedAspectIds?.includes(aspect.id)).map((aspect) => aspect.label),
  };
}

// Chosen aspects that no stop in the walk matched, so the app can say so plainly.
export function aspectLabelsNoStopMatched(stops, selectedAspectIds) {
  return ASPECTS
    .filter((aspect) => selectedAspectIds.includes(aspect.id))
    .filter((aspect) => !stops.some((stop) => stop.matchedAspectIds?.includes(aspect.id)))
    .map((aspect) => aspect.label);
}

export function estimateLoopWalkSeconds(start, orderedStops) {
  return (loopLengthMeters(start, orderedStops) * STREET_DETOUR_FACTOR) / AVERAGE_WALKING_SPEED_METERS_PER_SECOND;
}

// A walk shouldn't visit three branches of the same coffee company. From a list sorted best first,
// keeps only the first café of each name (ignoring capitals and punctuation), so the best-fitting,
// then nearest, branch wins. Cafés without a usable name are all kept.
export function keepOneCafePerName(cafesBestFirst) {
  const namesSeen = new Set();
  return cafesBestFirst.filter((cafe) => {
    const name = normalizeName(cafe.name);
    if (name === "") return true;
    if (namesSeen.has(name)) return false;
    namesSeen.add(name);
    return true;
  });
}

// Every way to choose `groupSize` items from `items`, keeping their order.
function* combinationsOf(items, groupSize, startIndex = 0, chosen = []) {
  if (chosen.length === groupSize) {
    yield chosen;
    return;
  }
  for (let index = startIndex; index <= items.length - (groupSize - chosen.length); index++) {
    yield* combinationsOf(items, groupSize, index + 1, [...chosen, items[index]]);
  }
}

// Returns the best walks, best first: [{ stops (in walking order), fitScore, estimatedWalkSeconds, fitsTimeLimit }].
// "New route" steps through this list, so no new Google searches are needed.
//
// Ranking: walks that fit the time limit come first, ordered by total fit, then more stops, then shorter walk.
// (Total fit already favours more stops, because every extra café adds a little. The explicit "more
// stops" step keeps that true when Google gives us no ratings or types and every score is zero.)
// If nothing fits, the shortest walks come first (the closest we can get), labelled as over the limit.
export function rankWalkOptions({ start, cafes, selectedAspectIds, stopRange, maxWalkMinutes, maxOptions = 5 }) {
  // Trying every group gets slow with many cafés, so only the best-fitting ones are considered.
  // Bigger groups have far more orderings, so they get a smaller pool.
  const candidateLimit = stopRange.maxStops >= 5 ? 8 : 10;
  const bestFirst = [...cafes].sort((first, second) =>
    preferenceFitScore(second, selectedAspectIds) - preferenceFitScore(first, selectedAspectIds) ||
    haversineDistanceMeters(start, first.location) - haversineDistanceMeters(start, second.location));
  const candidates = keepOneCafePerName(bestFirst).slice(0, candidateLimit);
  if (candidates.length === 0) return [];

  // With too few cafés for the chosen range, use as many as there are.
  const largestGroup = Math.min(stopRange.maxStops, candidates.length);
  const smallestGroup = Math.min(stopRange.minStops, largestGroup);
  const timeLimitSeconds = maxWalkMinutes * 60;

  const options = [];
  for (let groupSize = smallestGroup; groupSize <= largestGroup; groupSize++) {
    for (const group of combinationsOf(candidates, groupSize)) {
      const stops = orderStopsForShortestLoop(start, group);
      const estimatedWalkSeconds = estimateLoopWalkSeconds(start, stops);
      options.push({
        stops,
        fitScore: group.reduce((total, cafe) => total + preferenceFitScore(cafe, selectedAspectIds), 0),
        estimatedWalkSeconds,
        fitsTimeLimit: estimatedWalkSeconds <= timeLimitSeconds,
      });
    }
  }

  const anyFits = options.some((option) => option.fitsTimeLimit);
  options.sort((first, second) => {
    if (anyFits && first.fitsTimeLimit !== second.fitsTimeLimit) return first.fitsTimeLimit ? -1 : 1;
    if (anyFits && first.fitsTimeLimit) {
      return second.fitScore - first.fitScore ||
        second.stops.length - first.stops.length ||
        first.estimatedWalkSeconds - second.estimatedWalkSeconds;
    }
    return first.estimatedWalkSeconds - second.estimatedWalkSeconds || second.fitScore - first.fitScore;
  });
  return options.slice(0, maxOptions);
}
