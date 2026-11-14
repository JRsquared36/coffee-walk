import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPriceLevel,
  formatRating,
  formatOpenNow,
  todaysHours,
  cafeSummaryParts,
  cafeMetaParts,
  cafeBadges,
  todaysHoursLabel,
} from "../js/cafe-details.js";

const WEEK = [
  "Monday: 7:00 AM – 5:00 PM",
  "Tuesday: 7:00 AM – 5:00 PM",
  "Wednesday: 7:00 AM – 5:00 PM",
  "Thursday: 7:00 AM – 9:00 PM",
  "Friday: 7:00 AM – 9:00 PM",
  "Saturday: 8:00 AM – 9:00 PM",
  "Sunday: Closed",
];
// new Date(year, monthIndex, day) uses local time, so getDay() is stable wherever the tests run.
const SUNDAY = new Date(2026, 10, 15);
const MONDAY = new Date(2026, 10, 16);
const SATURDAY = new Date(2026, 10, 14);

test("price level: both Google spellings, and unknown values", () => {
  assert.equal(formatPriceLevel("MODERATE"), "$$");
  assert.equal(formatPriceLevel("PRICE_LEVEL_VERY_EXPENSIVE"), "$$$$");
  assert.equal(formatPriceLevel("FREE"), "Free");
  assert.equal(formatPriceLevel(null), null);
  assert.equal(formatPriceLevel("PRICE_LEVEL_UNSPECIFIED"), null);
});

test("rating with and without a review count", () => {
  assert.equal(formatRating(4.56, 312), "4.6★ (312)");
  assert.equal(formatRating(4, null), "4.0★");
  assert.equal(formatRating(null, 10), null);
});

test("open now: true, false, unknown", () => {
  assert.equal(formatOpenNow(true), "Open now");
  assert.equal(formatOpenNow(false), "Closed now");
  assert.equal(formatOpenNow(null), null);
  assert.equal(formatOpenNow(undefined), null);
});

test("today's hours: Google's list starts Monday, JavaScript's week starts Sunday", () => {
  assert.equal(todaysHours(WEEK, MONDAY), "7:00 AM – 5:00 PM");
  assert.equal(todaysHours(WEEK, SATURDAY), "8:00 AM – 9:00 PM");
  assert.equal(todaysHours(WEEK, SUNDAY), "Closed");
});

test("today's hours: missing or malformed lists give null instead of a wrong day", () => {
  assert.equal(todaysHours(null, MONDAY), null);
  assert.equal(todaysHours(WEEK.slice(0, 5), MONDAY), null);
});

test("summary skips whatever Google didn't provide", () => {
  const fullCafe = { rating: 4.7, ratingCount: 88, priceLevel: "INEXPENSIVE", isOpenNow: true, weeklyHours: WEEK };
  assert.deepEqual(cafeSummaryParts(fullCafe, MONDAY), ["4.7★ (88)", "$", "Open now", "Today 7:00 AM – 5:00 PM"]);
  const bareCafe = { rating: null, priceLevel: null, isOpenNow: null, weeklyHours: null };
  assert.deepEqual(cafeSummaryParts(bareCafe, MONDAY), []);
});

test("meta line is rating and price only", () => {
  assert.deepEqual(cafeMetaParts({ rating: 4.7, ratingCount: 88, priceLevel: "MODERATE" }), ["4.7★ (88)", "$$"]);
  assert.deepEqual(cafeMetaParts({ rating: null, priceLevel: null }), []);
});

test("badges: place type, then open or closed; nothing when unknown", () => {
  assert.deepEqual(cafeBadges({ typeLabel: "Coffee shop", isOpenNow: true }), [
    { label: "Coffee shop", tone: "neutral" },
    { label: "Open now", tone: "success" },
  ]);
  assert.deepEqual(cafeBadges({ typeLabel: null, isOpenNow: false }), [{ label: "Closed now", tone: "danger" }]);
  assert.deepEqual(cafeBadges({ typeLabel: null, isOpenNow: null }), []);
});

test("today's hours label", () => {
  assert.equal(todaysHoursLabel({ weeklyHours: WEEK }, MONDAY), "Today 7:00 AM – 5:00 PM");
  assert.equal(todaysHoursLabel({ weeklyHours: null }, MONDAY), null);
});
