import { test } from "node:test";
import assert from "node:assert/strict";
import { createCoffeeLog, COFFEE_LOG_STORAGE_KEY, MAX_NOTE_LENGTH } from "../js/coffee-log.js";

function createFakeStorage(initialItems = {}) {
  const items = { ...initialItems };
  return {
    getItem: (key) => (key in items ? items[key] : null),
    setItem: (key, value) => { items[key] = String(value); },
  };
}

test("adds entries and lists newest first", () => {
  const log = createCoffeeLog(createFakeStorage());
  log.addEntry({ placeId: "p1", cafeName: "Early", rating: 3, note: "", visitedAt: "2026-01-01T09:00:00Z" });
  log.addEntry({ placeId: "p2", cafeName: "Later", rating: 5, note: "great", visitedAt: "2026-02-01T09:00:00Z" });
  assert.deepEqual(log.listEntries().map((entry) => entry.cafeName), ["Later", "Early"]);
});

test("rejects ratings outside 1–5", () => {
  const log = createCoffeeLog(createFakeStorage());
  for (const badRating of [0, 6, 3.5, NaN]) {
    assert.equal(log.addEntry({ placeId: "p", cafeName: "x", rating: badRating }).saved, false);
  }
  assert.equal(log.listEntries().length, 0);
});

test("trims and caps notes", () => {
  const log = createCoffeeLog(createFakeStorage());
  const { entry } = log.addEntry({ placeId: "p", cafeName: "x", rating: 4, note: `  ${"a".repeat(900)}  ` });
  assert.equal(entry.note.length, MAX_NOTE_LENGTH);
});

test("repeat visits are separate entries; entriesForPlace filters", () => {
  const log = createCoffeeLog(createFakeStorage());
  log.addEntry({ placeId: "same", cafeName: "A", rating: 4, visitedAt: "2026-01-01T00:00:00Z" });
  log.addEntry({ placeId: "same", cafeName: "A", rating: 2, visitedAt: "2026-01-02T00:00:00Z" });
  log.addEntry({ placeId: "other", cafeName: "B", rating: 5 });
  assert.equal(log.entriesForPlace("same").length, 2);
  assert.equal(log.entriesForPlace("same")[0].rating, 2, "most recent first");
});

test("removeEntry deletes only that entry", () => {
  const log = createCoffeeLog(createFakeStorage());
  const { entry: keep } = log.addEntry({ placeId: "a", cafeName: "Keep", rating: 4, visitedAt: "2026-01-01T00:00:00Z" });
  const { entry: drop } = log.addEntry({ placeId: "b", cafeName: "Drop", rating: 1, visitedAt: "2026-01-02T00:00:00Z" });
  log.removeEntry(drop.entryId);
  assert.deepEqual(log.listEntries().map((entry) => entry.entryId), [keep.entryId]);
});

test("corrupted saved data starts an empty log instead of crashing", () => {
  const log = createCoffeeLog(createFakeStorage({ [COFFEE_LOG_STORAGE_KEY]: "{not json" }));
  assert.deepEqual(log.listEntries(), []);
});

test("blocked storage reports a reason instead of throwing", () => {
  const log = createCoffeeLog({ getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } });
  const result = log.addEntry({ placeId: "p", cafeName: "x", rating: 3 });
  assert.equal(result.saved, false);
  assert.match(result.reason, /save/);
});
