import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatPriceLevel,
  formatRating,
  isCafeOpenAt,
  todaysHours,
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

// A New York café (UTC−5 in winter) open 7:00–19:00 Monday to Saturday, closed Sunday.
const NEW_YORK_WINTER = -300;
const dayPeriod = (day, openHour, closeHour) => ({ open: { day, hour: openHour, minute: 0 }, close: { day, hour: closeHour, minute: 0 } });
const DAYTIME_CAFE = { openingPeriods: [1, 2, 3, 4, 5, 6].map((day) => dayPeriod(day, 7, 19)), utcOffsetMinutes: NEW_YORK_WINTER };
// 2026-11-14 is a Saturday. Times are given in UTC; New York is 5 hours behind.
const utc = (isoTime) => new Date(`${isoTime}Z`);

test("open now is judged by the café's own clock, not the device's", () => {
  assert.equal(isCafeOpenAt(DAYTIME_CAFE, utc("2026-11-14T17:00:00")), true, "Saturday noon in New York");
  assert.equal(isCafeOpenAt(DAYTIME_CAFE, utc("2026-11-14T11:59:00")), false, "Saturday 6:59 AM: a minute before opening");
  assert.equal(isCafeOpenAt(DAYTIME_CAFE, utc("2026-11-14T12:00:00")), true, "7:00 AM exactly: open");
  assert.equal(isCafeOpenAt(DAYTIME_CAFE, utc("2026-11-15T00:00:00")), false, "7:00 PM exactly: closed");
  // The case from the first real test: Sunday 01:30 UTC is still Saturday 8:30 PM in New York.
  assert.equal(isCafeOpenAt(DAYTIME_CAFE, utc("2026-11-15T01:30:00")), false);
  assert.equal(isCafeOpenAt(DAYTIME_CAFE, utc("2026-11-15T17:00:00")), false, "Sunday noon: closed all day");
});

test("open now: late-night hours that run past midnight, including Saturday into Sunday", () => {
  const lateBar = { openingPeriods: [{ open: { day: 5, hour: 18, minute: 0 }, close: { day: 6, hour: 2, minute: 0 } }, { open: { day: 6, hour: 18, minute: 0 }, close: { day: 0, hour: 2, minute: 0 } }], utcOffsetMinutes: 0 };
  assert.equal(isCafeOpenAt(lateBar, utc("2026-11-14T01:00:00")), true, "Saturday 1 AM, opened Friday evening");
  assert.equal(isCafeOpenAt(lateBar, utc("2026-11-14T03:00:00")), false, "Saturday 3 AM");
  assert.equal(isCafeOpenAt(lateBar, utc("2026-11-15T01:00:00")), true, "Sunday 1 AM, opened Saturday evening (wraps the week)");
  assert.equal(isCafeOpenAt(lateBar, utc("2026-11-15T02:00:00")), false, "Sunday 2 AM exactly");
});

test("open now: always-open places, and unknown when Google has no hours", () => {
  const alwaysOpen = { openingPeriods: [{ open: { day: 0, hour: 0, minute: 0 }, close: null }], utcOffsetMinutes: 60 };
  assert.equal(isCafeOpenAt(alwaysOpen, utc("2026-11-15T03:33:00")), true);
  assert.equal(isCafeOpenAt({ openingPeriods: null, utcOffsetMinutes: 0 }), null);
  assert.equal(isCafeOpenAt({ openingPeriods: [], utcOffsetMinutes: 0 }), null);
  assert.equal(isCafeOpenAt({ openingPeriods: DAYTIME_CAFE.openingPeriods, utcOffsetMinutes: null }), null, "no time zone");
  assert.equal(isCafeOpenAt({}), null, "basic data only");
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

test("meta line is rating and price only", () => {
  assert.deepEqual(cafeMetaParts({ rating: 4.7, ratingCount: 88, priceLevel: "MODERATE" }), ["4.7★ (88)", "$$"]);
  assert.deepEqual(cafeMetaParts({ rating: null, priceLevel: null }), []);
});

test("badges: place type, then open or closed; nothing when unknown", () => {
  const saturdayNoon = utc("2026-11-14T17:00:00"), saturdayNight = utc("2026-11-15T01:30:00");
  assert.deepEqual(cafeBadges({ ...DAYTIME_CAFE, typeLabel: "Coffee shop" }, saturdayNoon), [
    { label: "Coffee shop", tone: "neutral" },
    { label: "Open now", tone: "success" },
  ]);
  assert.deepEqual(cafeBadges({ ...DAYTIME_CAFE, typeLabel: null }, saturdayNight), [{ label: "Closed now", tone: "danger" }]);
  assert.deepEqual(cafeBadges({ typeLabel: null }), []);
});

test("today's hours follow the café's day, not the device's", () => {
  // Sunday 01:30 UTC is still Saturday evening in New York: show Saturday's hours, not Sunday's.
  const sundayEarlyUtc = utc("2026-11-15T01:30:00");
  assert.equal(todaysHours(WEEK, sundayEarlyUtc, NEW_YORK_WINTER), "8:00 AM – 9:00 PM");
  assert.equal(todaysHoursLabel({ weeklyHours: WEEK, utcOffsetMinutes: NEW_YORK_WINTER }, sundayEarlyUtc), "Today 8:00 AM – 9:00 PM");
});

test("today's hours label", () => {
  assert.equal(todaysHoursLabel({ weeklyHours: WEEK }, MONDAY), "Today 7:00 AM – 5:00 PM");
  assert.equal(todaysHoursLabel({ weeklyHours: null }, MONDAY), null);
});
