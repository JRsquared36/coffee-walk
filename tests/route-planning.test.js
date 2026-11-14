import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineDistanceMeters,
  loopLengthMeters,
  orderStopsForShortestLoop,
  estimateStraightLineLegs,
  parseGoogleDurationSeconds,
  formatDistance,
  formatWalkingTime,
  checkInDistanceVerdict,
  buildWalkingDirectionsUrl,
} from "../js/route-planning.js";

const cafeAt = (name, lat, lng) => ({ placeId: name, name, location: { lat, lng } });

test("haversine: one degree of latitude is about 111 km", () => {
  const meters = haversineDistanceMeters({ lat: 0, lng: 0 }, { lat: 1, lng: 0 });
  assert.ok(Math.abs(meters - 111_195) < 50, `got ${meters}`);
});

test("haversine: same point is zero", () => {
  assert.equal(haversineDistanceMeters({ lat: 40.7, lng: -74 }, { lat: 40.7, lng: -74 }), 0);
});

test("orderStopsForShortestLoop fixes a zig-zag order", () => {
  // Four corners of a square around the start; visiting diagonally is longer than going around.
  const start = { lat: 0, lng: 0 };
  const zigZag = [cafeAt("NE", 0.01, 0.01), cafeAt("SW", -0.01, -0.01), cafeAt("NW", 0.01, -0.01), cafeAt("SE", -0.01, 0.01)];
  const ordered = orderStopsForShortestLoop(start, zigZag);
  assert.ok(loopLengthMeters(start, ordered) < loopLengthMeters(start, zigZag));
  // Going around the square means NE and SW are never next to each other.
  const names = ordered.map((cafe) => cafe.name);
  const northEastIndex = names.indexOf("NE");
  const southWestIndex = names.indexOf("SW");
  assert.notEqual(Math.abs(northEastIndex - southWestIndex), 1);
});

test("orderStopsForShortestLoop handles one stop and zero stops", () => {
  const only = [cafeAt("only", 0.01, 0)];
  assert.deepEqual(orderStopsForShortestLoop({ lat: 0, lng: 0 }, only), only);
  assert.deepEqual(orderStopsForShortestLoop({ lat: 0, lng: 0 }, []), []);
});

test("straight-line legs: one more leg than stops (the walk back)", () => {
  const legs = estimateStraightLineLegs({ lat: 0, lng: 0 }, [cafeAt("a", 0.001, 0), cafeAt("b", 0.002, 0)]);
  assert.equal(legs.length, 3);
  assert.ok(legs.every((leg) => leg.durationSeconds > 0));
});

test("parseGoogleDurationSeconds", () => {
  assert.equal(parseGoogleDurationSeconds("754s"), 754);
  assert.equal(parseGoogleDurationSeconds("12.5s"), 12.5);
  assert.equal(parseGoogleDurationSeconds(undefined), null);
  assert.equal(parseGoogleDurationSeconds("about 5 minutes"), null);
});

test("formatDistance and formatWalkingTime", () => {
  assert.equal(formatDistance(347), "350 m");
  assert.equal(formatDistance(2450), "2.5 km");
  assert.equal(formatWalkingTime(20), "1 min", "never shows 0 min");
  assert.equal(formatWalkingTime(600), "10 min");
  assert.equal(formatWalkingTime(4500), "1 h 15 min");
});

test("check-in: allowed nearby, refused far away, GPS error forgiven only up to a cap", () => {
  const cafe = { lat: 0, lng: 0 };
  const metersNorth = (meters) => ({ lat: meters / 111_195, lng: 0 });
  assert.equal(checkInDistanceVerdict(metersNorth(30), 5, cafe).isCloseEnough, true);
  assert.equal(checkInDistanceVerdict(metersNorth(400), 5, cafe).isCloseEnough, false);
  // 110 m away with 40 m GPS error: 110 - 40 = 70 ≤ 75, allowed.
  assert.equal(checkInDistanceVerdict(metersNorth(110), 40, cafe).isCloseEnough, true);
  // 200 m away with a terrible 1000 m GPS reading: only 50 m forgiven, refused.
  assert.equal(checkInDistanceVerdict(metersNorth(200), 1000, cafe).isCloseEnough, false);
});

test("directions URL asks for walking and includes the place id", () => {
  const url = new URL(buildWalkingDirectionsUrl({ placeId: "abc123", location: { lat: 40.1, lng: -74.2 } }));
  assert.equal(url.searchParams.get("travelmode"), "walking");
  assert.equal(url.searchParams.get("destination"), "40.1,-74.2");
  assert.equal(url.searchParams.get("destination_place_id"), "abc123");
});
