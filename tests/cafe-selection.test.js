import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeName,
  isChain,
  reasonCafeIsExcluded,
  coffeeFirstScore,
  selectCoffeeFirstCafes,
} from "../js/cafe-selection.js";

// A good café by default; each test overrides what it's about.
const cafe = (overrides) => ({ name: "Corner Coffee", primaryType: "coffee_shop", rating: 4.5, ratingCount: 200, ...overrides });

test("the places from the first real walk are excluded", () => {
  // What Google most likely returned: cafés by type, but food-first by name.
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Hudson Bagels", primaryType: "cafe" })), "not coffee-first");
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Petee's Pie Company", primaryType: "cafe" })), "not coffee-first");
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Le Baguette", primaryType: "cafe" })), "not coffee-first");
  // Or bakeries by primary type.
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Sullivan Street", primaryType: "bakery" })), "not coffee-first");
});

test("coffee shops and coffee-forward cafés qualify", () => {
  assert.equal(reasonCafeIsExcluded(cafe({})), null);
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Little Owl", primaryType: "cafe" })), null);
  // A coffee_shop is trusted even with a food word in its name.
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Bagel Bar Espresso", primaryType: "coffee_shop" })), null);
});

test("a bakery qualifies only when its name says coffee", () => {
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Breadline Coffee Bakery", primaryType: "bakery" })), null);
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Breadline Bakery", primaryType: "bakery" })), "not coffee-first");
});

test("a café with a food word is dropped even when its name also says coffee", () => {
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Joe's Bagel Café", primaryType: "cafe" })), "not coffee-first");
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Sunrise Bagels & Coffee", primaryType: "cafe" })), "not coffee-first");
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Sunrise Bagels & Coffee", primaryType: null, rating: null })), "not coffee-first");
  // The same name is fine if Google calls it a coffee shop.
  assert.equal(reasonCafeIsExcluded(cafe({ name: "Sunrise Bagels & Coffee", primaryType: "coffee_shop" })), null);
});

test("chains are excluded, independents with similar words are not", () => {
  for (const chainName of ["Starbucks", "Starbucks Reserve Roastery", "Dunkin'", "Peet's Coffee", "Tim Hortons", "Pret A Manger", "The Coffee Bean & Tea Leaf"]) {
    assert.equal(isChain(chainName), true, chainName);
    assert.equal(reasonCafeIsExcluded(cafe({ name: chainName })), "chain", chainName);
  }
  for (const independentName of ["Starling Coffee", "Peter's Espresso", "Dunking Bird Café"]) {
    assert.equal(isChain(independentName), false, independentName);
  }
});

test("quality floor: 4.0★ and 20 reviews", () => {
  assert.equal(reasonCafeIsExcluded(cafe({ rating: 3.9 })), "below quality floor");
  assert.equal(reasonCafeIsExcluded(cafe({ ratingCount: 19 })), "below quality floor");
  assert.equal(reasonCafeIsExcluded(cafe({ rating: 4.0, ratingCount: 20 })), null, "exactly at the floor passes");
  assert.equal(reasonCafeIsExcluded(cafe({ rating: 4.5, ratingCount: null })), "below quality floor");
});

test("without detailed data (Google refused the fields), cafés aren't excluded for what we can't see", () => {
  assert.equal(reasonCafeIsExcluded({ name: "Mystery Spot", primaryType: null, rating: null, ratingCount: null }), null);
  assert.equal(reasonCafeIsExcluded({ name: "Mystery Bagels", primaryType: null, rating: null, ratingCount: null }), "not coffee-first");
});

test("score: coffee shop beats café; coffee name and rating add", () => {
  assert.ok(coffeeFirstScore(cafe({ name: "Plain", primaryType: "coffee_shop" })) > coffeeFirstScore(cafe({ name: "Plain", primaryType: "cafe" })));
  assert.ok(coffeeFirstScore(cafe({ name: "Ace Espresso" })) > coffeeFirstScore(cafe({ name: "Ace" })));
  assert.ok(coffeeFirstScore(cafe({ rating: 4.9 })) > coffeeFirstScore(cafe({ rating: 4.1 })));
});

test("selectCoffeeFirstCafes ranks survivors and counts the rest by reason", () => {
  const { qualifyingCafes, excludedCountsByReason } = selectCoffeeFirstCafes([
    cafe({ name: "Okay Café", primaryType: "cafe", rating: 4.1 }),
    cafe({ name: "Starbucks" }),
    cafe({ name: "Best Roasters", rating: 4.8 }),
    cafe({ name: "Hudson Bagels", primaryType: "cafe" }),
    cafe({ name: "Meh Coffee", rating: 3.5 }),
  ]);
  assert.deepEqual(qualifyingCafes.map((c) => c.name), ["Best Roasters", "Okay Café"]);
  assert.deepEqual(excludedCountsByReason, { chain: 1, "not coffee-first": 1, "below quality floor": 1 });
});

test("normalizeName handles apostrophes, ampersands and accents", () => {
  assert.equal(normalizeName("Peet's Coffee & Tea"), "peets coffee and tea");
  assert.equal(normalizeName("Pâtisserie Café"), "patisserie cafe");
});
