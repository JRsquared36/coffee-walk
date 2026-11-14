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

export function formatOpenNow(isOpenNow) {
  if (isOpenNow === true) return "Open now";
  if (isOpenNow === false) return "Closed now";
  return null; // unknown: Google has no hours for this café
}

// Google lists weekly hours Monday first: ["Monday: 7:00 AM – 5:00 PM", …, "Sunday: Closed"].
// JavaScript's getDay() counts Sunday as 0, so shift it to make Monday 0.
export function todaysHours(weeklyHours, date = new Date()) {
  if (!Array.isArray(weeklyHours) || weeklyHours.length !== 7) return null;
  const mondayFirstIndex = (date.getDay() + 6) % 7;
  return weeklyHours[mondayFirstIndex].replace(/^[^:]+:\s*/, "");
}

// Rating and price, e.g. ["4.7★ (312)", "$$"]. Shown as one line on the stop card.
export function cafeMetaParts(cafe) {
  return [formatRating(cafe.rating, cafe.ratingCount), formatPriceLevel(cafe.priceLevel)].filter(Boolean);
}

// Small coloured labels for a café. `tone` matches a badge style in css/style.css.
export function cafeBadges(cafe) {
  const badges = [];
  if (cafe.typeLabel) badges.push({ label: cafe.typeLabel, tone: "neutral" }); // shows why the place qualified
  if (cafe.isOpenNow === true) badges.push({ label: "Open now", tone: "success" });
  if (cafe.isOpenNow === false) badges.push({ label: "Closed now", tone: "danger" });
  return badges;
}

export function todaysHoursLabel(cafe, date = new Date()) {
  const hoursToday = todaysHours(cafe.weeklyHours, date);
  return hoursToday ? `Today ${hoursToday}` : null;
}
