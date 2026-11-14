import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASPECTS,
  STOP_RANGES,
  WALK_MINUTES_OPTIONS,
  searchRadiusMetersForWalk,
  mergeCafesWithMatches,
  preferenceFitScore,
  matchSummary,
  aspectLabelsNoStopMatched,
  estimateLoopWalkSeconds,
  rankWalkOptions,
} from "../js/walk-preferences.js";

const START = { lat: 0, lng: 0 };
const METERS_PER_DEGREE = 111_195;
// A café `metersNorth` north and `metersEast` east of the start.
const cafeAt = (name, metersNorth, metersEast = 0, overrides = {}) => ({
  placeId: name,
  name,
  location: { lat: metersNorth / METERS_PER_DEGREE, lng: metersEast / METERS_PER_DEGREE },
  primaryType: "coffee_shop",
  rating: 4.2,
  ratingCount: 50,
  matchedAspectIds: [],
  ...overrides,
});
const names = (stops) => stops.map((stop) => stop.name).sort();

test("every aspect has an id, a label and a search phrase; ids are unique", () => {
  assert.equal(new Set(ASPECTS.map((aspect) => aspect.id)).size, ASPECTS.length);
  for (const aspect of ASPECTS) assert.ok(aspect.id && aspect.label && aspect.searchText.length > 5, aspect.id);
});

test("search radius grows with walking time and stays within sensible bounds", () => {
  const radii = WALK_MINUTES_OPTIONS.map(searchRadiusMetersForWalk);
  assert.deepEqual(radii, [405, 810, 1215, 1620]);
  assert.equal(searchRadiusMetersForWalk(1), 400, "never tiny");
  assert.equal(searchRadiusMetersForWalk(600), 2000, "never huge");
});

test("merge: no duplicates, matches recorded, far-away text results dropped", () => {
  const near = cafeAt("Near", 100);
  const both = cafeAt("Both", 200);
  const merged = mergeCafesWithMatches({
    start: START,
    radiusMeters: 800,
    nearbyCafes: [near, both],
    cafesByAspectId: {
      "cozy-quiet": [both, cafeAt("Cozy Only", 300), cafeAt("Too Far", 5000)],
      "coffee-flight": [both],
      "work-friendly": [cafeAt("Not Chosen", 100)], // searched earlier but not selected now
    },
    selectedAspectIds: ["cozy-quiet", "coffee-flight"],
  });
  assert.deepEqual(names(merged), ["Both", "Cozy Only", "Near"]);
  const byName = Object.fromEntries(merged.map((cafe) => [cafe.name, cafe.matchedAspectIds]));
  assert.deepEqual(byName.Near, []);
  assert.deepEqual(byName.Both, ["cozy-quiet", "coffee-flight"]);
  assert.deepEqual(byName["Cozy Only"], ["cozy-quiet"]);
  assert.deepEqual(near.matchedAspectIds, [], "input cafés are not modified");
});

test("merge: 'good coffee' also counts a café rated 4.5+ by 100+ people, but only if chosen", () => {
  const loved = cafeAt("Loved", 100, 0, { rating: 4.7, ratingCount: 300 });
  const fewReviews = cafeAt("Few Reviews", 100, 50, { rating: 4.9, ratingCount: 12 });
  const input = { start: START, radiusMeters: 800, nearbyCafes: [loved, fewReviews], cafesByAspectId: {} };
  const chosen = mergeCafesWithMatches({ ...input, selectedAspectIds: ["good-coffee"] });
  assert.deepEqual(chosen.find((cafe) => cafe.name === "Loved").matchedAspectIds, ["good-coffee"]);
  assert.deepEqual(chosen.find((cafe) => cafe.name === "Few Reviews").matchedAspectIds, []);
  const notChosen = mergeCafesWithMatches({ ...input, selectedAspectIds: [] });
  assert.deepEqual(notChosen.find((cafe) => cafe.name === "Loved").matchedAspectIds, []);
});

test("fit score: more matched aspects always beats a better coffee score", () => {
  const selected = ["cozy-quiet", "coffee-flight"];
  const twoMatches = cafeAt("Two", 0, 0, { matchedAspectIds: selected, primaryType: "cafe", rating: 4.0 });
  const oneMatchGreatCoffee = cafeAt("One Espresso Roasters", 0, 0, { matchedAspectIds: ["cozy-quiet"], rating: 5.0 });
  const noMatch = cafeAt("None", 0, 0, { matchedAspectIds: ["work-friendly"] }); // matched something not chosen
  assert.ok(preferenceFitScore(twoMatches, selected) > preferenceFitScore(oneMatchGreatCoffee, selected));
  assert.ok(preferenceFitScore(oneMatchGreatCoffee, selected) > preferenceFitScore(noMatch, selected));
  assert.ok(preferenceFitScore(noMatch, selected) < 1, "unchosen aspects add nothing");
});

test("match summary lists matched and unmatched chosen aspects by label", () => {
  const cafe = cafeAt("x", 0, 0, { matchedAspectIds: ["cozy-quiet"] });
  assert.deepEqual(matchSummary(cafe, ["coffee-flight", "cozy-quiet"]), { matchedLabels: ["Cozy & quiet"], unmatchedLabels: ["Coffee flight"] });
  assert.deepEqual(matchSummary(cafe, []), { matchedLabels: [], unmatchedLabels: [] });
});

test("aspects no stop matched are reported", () => {
  const stops = [cafeAt("a", 0, 0, { matchedAspectIds: ["cozy-quiet"] }), cafeAt("b", 0, 0)];
  assert.deepEqual(aspectLabelsNoStopMatched(stops, ["cozy-quiet", "coffee-flight"]), ["Coffee flight"]);
  assert.deepEqual(aspectLabelsNoStopMatched(stops, ["cozy-quiet"]), []);
});

test("ranking prefers cafés that match, within the stop range", () => {
  const matching = ["M1", "M2", "M3"].map((name, index) => cafeAt(name, 150, 100 * index, { matchedAspectIds: ["cozy-quiet"] }));
  const plain = ["P1", "P2", "P3", "P4"].map((name, index) => cafeAt(name, 50, 60 * index)); // closer, but no match
  const [best] = rankWalkOptions({ start: START, cafes: [...plain, ...matching], selectedAspectIds: ["cozy-quiet"], stopRange: STOP_RANGES["2-3"], maxWalkMinutes: 30 });
  assert.deepEqual(names(best.stops), ["M1", "M2", "M3"]);
  assert.equal(best.fitsTimeLimit, true);
});

test("ranking respects the walking time: a great match that is too far is left out", () => {
  const close = ["C1", "C2", "C3"].map((name, index) => cafeAt(name, 100, 80 * index));
  const farMatch = cafeAt("Far Match", 1500, 0, { matchedAspectIds: ["coffee-flight"] });
  const options = rankWalkOptions({ start: START, cafes: [...close, farMatch], selectedAspectIds: ["coffee-flight"], stopRange: STOP_RANGES["2-3"], maxWalkMinutes: 15 });
  assert.ok(!names(options[0].stops).includes("Far Match"));
  assert.ok(options[0].estimatedWalkSeconds <= 15 * 60);
  assert.ok(options.every((option, index) => index === 0 || !option.fitsTimeLimit || option.fitScore <= options[index - 1].fitScore || !options[index - 1].fitsTimeLimit));
});

test("ranking: when nothing fits the time, the shortest walk comes first and is flagged", () => {
  const far = ["F1", "F2", "F3"].map((name, index) => cafeAt(name, 2000 + 300 * index, 0));
  const options = rankWalkOptions({ start: START, cafes: far, selectedAspectIds: [], stopRange: STOP_RANGES["2-3"], maxWalkMinutes: 15 });
  assert.equal(options[0].fitsTimeLimit, false);
  assert.deepEqual(names(options[0].stops), ["F1", "F2"], "the two nearest, the shortest possible loop");
  for (let index = 1; index < options.length; index++) assert.ok(options[index].estimatedWalkSeconds >= options[index - 1].estimatedWalkSeconds);
});

test("ranking: fewer cafés than the range asks for still gives a walk", () => {
  const options = rankWalkOptions({ start: START, cafes: [cafeAt("Only", 100), cafeAt("Two", 200)], selectedAspectIds: [], stopRange: STOP_RANGES["5-6"], maxWalkMinutes: 60 });
  assert.equal(options.length, 1);
  assert.equal(options[0].stops.length, 2);
  assert.deepEqual(rankWalkOptions({ start: START, cafes: [], selectedAspectIds: [], stopRange: STOP_RANGES["3-4"], maxWalkMinutes: 30 }), []);
});

test("ranking: with no ratings or types (basic data), the walk still uses the top of the stop range", () => {
  const bare = Array.from({ length: 6 }, (_, index) => cafeAt(`Bare ${index}`, 100, 70 * index, { primaryType: null, rating: null, ratingCount: null }));
  const [best] = rankWalkOptions({ start: START, cafes: bare, selectedAspectIds: [], stopRange: STOP_RANGES["3-4"], maxWalkMinutes: 30 });
  assert.equal(best.stops.length, 4);
});

test("ranking returns several different walks for 'New route', each in shortest-loop order", () => {
  const cafes = Array.from({ length: 12 }, (_, index) => cafeAt(`Café ${index}`, 100 + 40 * (index % 4), 60 * index));
  const options = rankWalkOptions({ start: START, cafes, selectedAspectIds: [], stopRange: STOP_RANGES["3-4"], maxWalkMinutes: 60 });
  assert.equal(options.length, 5);
  assert.equal(new Set(options.map((option) => names(option.stops).join("|"))).size, 5, "all different groups");
  for (const option of options) {
    assert.ok(option.stops.length >= 3 && option.stops.length <= 4);
    assert.equal(option.estimatedWalkSeconds, estimateLoopWalkSeconds(START, option.stops));
  }
});

test("ranking stays fast for the biggest case (5–6 stops from many cafés)", () => {
  const cafes = Array.from({ length: 40 }, (_, index) => cafeAt(`Café ${index}`, 50 + 37 * (index % 7), 45 * (index % 9)));
  const startedAt = performance.now();
  const options = rankWalkOptions({ start: START, cafes, selectedAspectIds: ["cozy-quiet"], stopRange: STOP_RANGES["5-6"], maxWalkMinutes: 60 });
  const elapsedMs = performance.now() - startedAt;
  assert.ok(options.length > 0);
  assert.ok(elapsedMs < 1500, `took ${Math.round(elapsedMs)} ms`);
});
