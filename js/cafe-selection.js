// Which places count as a coffee stop, and which are best. Pure logic, unit-tested.
//
// The rules (decided with the owner):
//   1. Coffee-first: primary type coffee_shop or cafe. A bakery counts only if its name says coffee.
//   2. A café whose name is food-first ("…Bagels", "…Pie Co.") and has no coffee word is dropped.
//   3. Chains are excluded.
//   4. Quality floor: 4.0★ or better with at least 20 reviews.
//   Survivors are scored so the most coffee-focused, best-rated places are picked first.

// What we ask Google for. Bakery is included only so rule 1's exception can apply.
export const SEARCH_PRIMARY_TYPES = ["coffee_shop", "cafe", "bakery"];

export const MINIMUM_RATING = 4.0;
export const MINIMUM_REVIEW_COUNT = 20;

// "Café" is deliberately not here: "Joe's Bagel Café" shouldn't count as coffee-first.
const COFFEE_WORDS = ["coffee", "espresso", "roast", "roaster", "roasters", "roastery", "roasting", "brew", "kaffe"];
const FOOD_FIRST_WORDS = ["bagel", "bagels", "bakery", "bake shop", "bakeshop", "pie", "pies", "baguette", "donut", "donuts",
  "doughnut", "doughnuts", "boulangerie", "patisserie", "pâtisserie", "deli", "sandwich", "sandwiches", "pizza", "crepe", "crêpe"];
// Matched against the start of the name, so "Starbucks Reserve" and "Dunkin'" are caught.
// Edit this list freely; it only needs lowercase names without punctuation.
const CHAIN_NAMES = ["starbucks", "dunkin", "tim hortons", "peets", "caribou coffee", "costa coffee", "pret a manger",
  "panera", "mccafe", "dutch bros", "the coffee bean", "coffee bean and tea leaf", "krispy kreme", "biggby",
  "scooters coffee", "gloria jeans", "philz coffee", "black rifle coffee", "7 brew"];

// "Peet's Coffee & Tea" → "peets coffee and tea"; "Dunkin'" → "dunkin".
export function normalizeName(name) {
  return (name ?? "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // é → e
    .replace(/&/g, " and ")
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameHasAnyWord(name, words) {
  const paddedName = ` ${normalizeName(name)} `;
  return words.some((word) => paddedName.includes(` ${normalizeName(word)} `));
}

export function isChain(name) {
  const normalizedName = normalizeName(name);
  return CHAIN_NAMES.some((chainName) => normalizedName === chainName || normalizedName.startsWith(`${chainName} `));
}

// Returns null if the café qualifies, otherwise a short reason (used to explain empty results).
export function reasonCafeIsExcluded(cafe) {
  const hasCoffeeName = nameHasAnyWord(cafe.name, COFFEE_WORDS);
  if (isChain(cafe.name)) return "chain";
  // primaryType is null when Google refused the detailed fields; we can't judge type, so don't exclude on it.
  if (cafe.primaryType != null && cafe.primaryType !== "coffee_shop" && cafe.primaryType !== "cafe" && !hasCoffeeName) {
    return "not coffee-first";
  }
  if (cafe.primaryType !== "coffee_shop" && nameHasAnyWord(cafe.name, FOOD_FIRST_WORDS) && !hasCoffeeName) {
    return "not coffee-first";
  }
  // The floor needs a rating to check. Without one (basic fields), the café isn't excluded for it.
  if (cafe.rating != null && (cafe.rating < MINIMUM_RATING || (cafe.ratingCount ?? 0) < MINIMUM_REVIEW_COUNT)) {
    return "below quality floor";
  }
  return null;
}

// Higher is better. Coffee focus first, then rating.
export function coffeeFirstScore(cafe) {
  let score = 0;
  if (cafe.primaryType === "coffee_shop") score += 3;
  else if (cafe.primaryType === "cafe") score += 1;
  if (nameHasAnyWord(cafe.name, COFFEE_WORDS)) score += 2;
  if (cafe.rating != null) score += Math.max(0, cafe.rating - MINIMUM_RATING) * 2; // 4.0★ → 0, 5.0★ → 2
  return score;
}

// Splits search results into qualifying cafés (best first) and counts of why the rest were dropped.
export function selectCoffeeFirstCafes(cafes) {
  const qualifyingCafes = [];
  const excludedCountsByReason = {};
  for (const cafe of cafes) {
    const reason = reasonCafeIsExcluded(cafe);
    if (reason) excludedCountsByReason[reason] = (excludedCountsByReason[reason] ?? 0) + 1;
    else qualifyingCafes.push(cafe);
  }
  qualifyingCafes.sort((first, second) => coffeeFirstScore(second) - coffeeFirstScore(first));
  return { qualifyingCafes, excludedCountsByReason };
}

// The pool to pick stops from: the best-scoring cafés, with a few extra so "New route" still has variety.
export function topCandidatePool(rankedCafes, stopCount) {
  return rankedCafes.slice(0, Math.max(stopCount * 2, 8));
}
