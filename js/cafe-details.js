// Pure formatting for café details (hours, price, rating). No browser or Google needed, so it's unit-tested.

// Google's JavaScript library says "MODERATE"; its web API says "PRICE_LEVEL_MODERATE". Accept both.
const PRICE_SYMBOLS = {
  FREE: "Free",
  INEXPENSIVE: "$",
  MODERATE: "$$",
  EXPENSIVE: "$$$",
  VERY_EXPENSIVE: "$$$$",
};

export function formatPriceLevel(priceLevel) {
  if (!priceLevel) return null;
  return PRICE_SYMBOLS[String(priceLevel).replace(/^PRICE_LEVEL_/, "")] ?? null;
}

export function formatRating(rating, ratingCount) {
  if (rating == null) return null;
  return ratingCount ? `${rating.toFixed(1)}★ (${ratingCount})` : `${rating.toFixed(1)}★`;
}

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

// What a clock on the café's wall shows at `date`: the day (0 = Sunday) and minutes since midnight.
// `utcOffsetMinutes` is how far the café's time zone is from UTC (New York in winter: -300).
// Shifting the time by the offset and then reading it "as UTC" gives the café's local clock.
function cafeWallClock(utcOffsetMinutes, date) {
  const shifted = new Date(date.getTime() + utcOffsetMinutes * 60_000);
  return { dayOfWeek: shifted.getUTCDay(), minuteOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

// Is the café open at `date`? true or false, or null when Google has no hours for it.
// We work this out ourselves from Google's opening periods: Google's own isOpen() helper only
// exists in its beta channel, which this app doesn't load.
// A period is { open: {day, hour, minute}, close: {day, hour, minute} | null }, days counted from Sunday = 0.
export function isCafeOpenAt(cafe, date = new Date()) {
  const { openingPeriods, utcOffsetMinutes } = cafe;
  if (!Array.isArray(openingPeriods) || openingPeriods.length === 0 || utcOffsetMinutes == null) return null;
  const { dayOfWeek, minuteOfDay } = cafeWallClock(utcOffsetMinutes, date);
  const nowMinuteOfWeek = dayOfWeek * MINUTES_PER_DAY + minuteOfDay;
  const minuteOfWeek = (point) => point.day * MINUTES_PER_DAY + point.hour * 60 + point.minute;
  return openingPeriods.some(({ open, close }) => {
    if (!close) return true; // a period with no closing time is how Google says "always open"
    const opensAt = minuteOfWeek(open);
    let closesAt = minuteOfWeek(close);
    // Open Saturday night into Sunday morning: the close is "earlier" in the week than the open.
    if (closesAt <= opensAt) closesAt += MINUTES_PER_WEEK;
    return (nowMinuteOfWeek >= opensAt && nowMinuteOfWeek < closesAt) ||
      (nowMinuteOfWeek + MINUTES_PER_WEEK >= opensAt && nowMinuteOfWeek + MINUTES_PER_WEEK < closesAt);
  });
}

// Google lists weekly hours Monday first: ["Monday: 7:00 AM – 5:00 PM", …, "Sunday: Closed"].
// JavaScript counts Sunday as 0, so shift it to make Monday 0.
// "Today" is the café's own day when its time zone is known; otherwise this device's day.
export function todaysHours(weeklyHours, date = new Date(), utcOffsetMinutes = null) {
  if (!Array.isArray(weeklyHours) || weeklyHours.length !== 7) return null;
  const dayOfWeek = utcOffsetMinutes == null ? date.getDay() : cafeWallClock(utcOffsetMinutes, date).dayOfWeek;
  const mondayFirstIndex = (dayOfWeek + 6) % 7;
  return weeklyHours[mondayFirstIndex].replace(/^[^:]+:\s*/, "");
}

// Rating and price, e.g. ["4.7★ (312)", "$$"]. Shown as one line on the stop card.
export function cafeMetaParts(cafe) {
  return [formatRating(cafe.rating, cafe.ratingCount), formatPriceLevel(cafe.priceLevel)].filter(Boolean);
}

// Small coloured labels for a café. `tone` matches a badge style in css/style.css.
export function cafeBadges(cafe, date = new Date()) {
  const badges = [];
  if (cafe.typeLabel) badges.push({ label: cafe.typeLabel, tone: "neutral" }); // shows why the place qualified
  const isOpen = isCafeOpenAt(cafe, date); // worked out each time it's shown, so it stays right as time passes
  if (isOpen === true) badges.push({ label: "Open now", tone: "success" });
  if (isOpen === false) badges.push({ label: "Closed now", tone: "danger" });
  return badges;
}

export function todaysHoursLabel(cafe, date = new Date()) {
  const hoursToday = todaysHours(cafe.weeklyHours, date, cafe.utcOffsetMinutes ?? null);
  return hoursToday ? `Today ${hoursToday}` : null;
}
