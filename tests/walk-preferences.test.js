import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASPECTS,
  STOP_RANGES,
  WALK_MINUTES_OPTIONS,
  searchRadiusMetersForWalk,
  mergeCafesWithMatches,
  topMatchesForPreference,
  MATCHES_PER_PREFERENCE,
  preferenceFitScore,
  matchSummary,
  aspectLabelsNoStopMatched,
  estimateLoopWalkSeconds,
  rankWalkOptions,
  isWalkOverTimeAllowance,
  WALK_TIME_GRACE_MINUTES,
  keepOneCafePerName,
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

test("only Google's first five qualifying results match a preference", () => {
  assert.equal(MATCHES_PER_PREFERENCE, 5);
  const results = Array.from({ length: 8 }, (_, index) => cafeAt(`Result ${index + 1}`, 100 + 10 * index));
  const matches = topMatchesForPreference(results, { start: START, radiusMeters: 800 });
  assert.deepEqual(matches.map((cafe) => cafe.name), ["Result 1", "Result 2", "Result 3", "Result 4", "Result 5"]);
});

test("places that could never be a stop don't use up one of the five", () => {
  const results = [
    cafeAt("Starbucks", 100),                                  // a chain
    cafeAt("Too Far Roasters", 5000),                          // beyond walking range
    cafeAt("Hudson Bagels", 120, 0, { primaryType: "cafe" }),  // not coffee-first
    cafeAt("Barely Rated", 130, 0, { rating: 3.2 }),           // below the quality floor
    cafeAt("Twin Coffee", 140),
    cafeAt("Twin Coffee", 150),                                // a second branch of the same café
    ...Array.from({ length: 6 }, (_, index) => cafeAt(`Good ${index + 1}`, 160 + 10 * index)),
  ];
  const matches = topMatchesForPreference(results, { start: START, radiusMeters: 800 });
  assert.deepEqual(matches.map((cafe) => cafe.name), ["Twin Coffee", "Good 1", "Good 2", "Good 3", "Good 4"]);
});

test("merge: a sixth result is not a match, and is only a candidate if the nearby search found it too", () => {
  const results = Array.from({ length: 7 }, (_, index) => cafeAt(`Result ${index + 1}`, 100 + 10 * index));
  const sixth = results[5];
  const merged = mergeCafesWithMatches({ start: START, radiusMeters: 800, nearbyCafes: [sixth], cafesByAspectId: { "cozy-quiet": results }, selectedAspectIds: ["cozy-quiet"] });
  assert.deepEqual(names(merged), ["Result 1", "Result 2", "Result 3", "Result 4", "Result 5", "Result 6"]);
  assert.deepEqual(merged.find((cafe) => cafe.name === "Result 6").matchedAspectIds, [], "found nearby, but not a top-five match");
  assert.deepEqual(merged.find((cafe) => cafe.name === "Result 5").matchedAspectIds, ["cozy-quiet"]);
  assert.ok(!merged.some((cafe) => cafe.name === "Result 7"));
});

test("merge: a high rating alone no longer counts as matching 'good coffee'", () => {
  const loved = cafeAt("Loved", 100, 0, { rating: 4.9, ratingCount: 3000 });
  const merged = mergeCafesWithMatches({ start: START, radiusMeters: 800, nearbyCafes: [loved], cafesByAspectId: { "good-coffee": [] }, selectedAspectIds: ["good-coffee"] });
  assert.deepEqual(merged[0].matchedAspectIds, []);
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

test("up to five minutes over the chosen time is not 'over'", () => {
  assert.equal(WALK_TIME_GRACE_MINUTES, 5);
  assert.equal(isWalkOverTimeAllowance(30 * 60, 30), false);
  assert.equal(isWalkOverTimeAllowance(31 * 60, 30), false, "the real 31-minute walk on a 30-minute limit");
  assert.equal(isWalkOverTimeAllowance(35 * 60, 30), false, "exactly five over is still fine");
  assert.equal(isWalkOverTimeAllowance(35 * 60 + 1, 30), true);
});

test("ranking: a walk within the grace beats a shorter walk that is far over, and loses to one within the time", () => {
  // Estimated walking time for a there-and-back to one café `meters` away: meters × 2 × 1.3 ÷ 1.35 seconds.
  // 15 min limit = 900 s; grace ends at 1200 s. 450 m → 867 s (fits). 550 m → 1059 s (grace). 900 m → 1733 s (over).
  const oneStop = { minStops: 1, maxStops: 1 };
  const fitsButPlain = cafeAt("Fits Plain", 450);
  const graceAndMatches = cafeAt("Grace Match", 550, 0, { matchedAspectIds: ["cozy-quiet"] });
  const overAndMatches = cafeAt("Over Match", 900, 0, { matchedAspectIds: ["cozy-quiet"] });
  const rank = (cafes) => rankWalkOptions({ start: START, cafes, selectedAspectIds: ["cozy-quiet"], stopRange: oneStop, maxWalkMinutes: 15 }).map((option) => option.stops[0].name);
  assert.deepEqual(rank([overAndMatches, graceAndMatches, fitsButPlain]), ["Fits Plain", "Grace Match", "Over Match"]);
  const [best] = rankWalkOptions({ start: START, cafes: [overAndMatches, graceAndMatches], selectedAspectIds: ["cozy-quiet"], stopRange: oneStop, maxWalkMinutes: 15 });
  assert.equal(best.stops[0].name, "Grace Match");
  assert.deepEqual([best.fitsTimeLimit, best.fitsWithGrace], [false, true]);
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

test("one café per name: the best-ranked branch is kept, the rest dropped", () => {
  const branches = [cafeAt("787 Coffee", 100), cafeAt("Other Roasters", 150), cafeAt("787 COFFEE", 200), cafeAt("787 Coffee.", 300)];
  assert.deepEqual(keepOneCafePerName(branches).map((cafe) => cafe.location.lat), [branches[0].location.lat, branches[1].location.lat]);
  const unnamed = [cafeAt("", 100), cafeAt("", 200)];
  assert.equal(keepOneCafePerName(unnamed).length, 2, "cafés without a name aren't treated as the same place");
});

test("ranking never puts two branches of the same café in one walk (the real '787 Coffee ×3' case)", () => {
  const matchesAll = { matchedAspectIds: ["good-coffee", "coffee-flight"], rating: 4.9, ratingCount: 4000 };
  const cafes = [
    { ...cafeAt("787 Coffee", 300, 0, matchesAll), placeId: "787-a" },
    { ...cafeAt("787 Coffee", 100, 200, matchesAll), placeId: "787-b" }, // the nearest branch
    { ...cafeAt("787 Coffee", 350, 300, matchesAll), placeId: "787-c" },
    cafeAt("Radiant Café", 120, 0, { matchedAspectIds: ["good-coffee"] }),
    cafeAt("Plain One", 150, 100),
    cafeAt("Plain Two", 200, 150),
  ];
  const options = rankWalkOptions({ start: START, cafes, selectedAspectIds: ["good-coffee", "coffee-flight"], stopRange: STOP_RANGES["3-4"], maxWalkMinutes: 60 });
  for (const option of options) {
    const stopNames = option.stops.map((stop) => stop.name);
    assert.equal(new Set(stopNames).size, stopNames.length, stopNames.join(", "));
  }
  const best = options[0].stops;
  assert.ok(best.some((stop) => stop.placeId === "787-b"), "the nearest branch is the one kept");
  assert.equal(best.length, 4);
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
