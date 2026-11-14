// Your personal coffee log, saved in this browser only (localStorage).
// Each check-in is its own entry, so visiting the same café twice gives two entries.

export const COFFEE_LOG_STORAGE_KEY = "coffeeWalk.log.v1";
export const MAX_NOTE_LENGTH = 500;

// `storage` is localStorage in the browser and a fake object in tests.
export function createCoffeeLog(storage) {
  function readEntries() {
    try {
      const savedText = storage.getItem(COFFEE_LOG_STORAGE_KEY);
      const parsed = savedText ? JSON.parse(savedText) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Private browsing, blocked storage, or corrupted data: start with an empty log.
      return [];
    }
  }

  function writeEntries(entries) {
    try {
      storage.setItem(COFFEE_LOG_STORAGE_KEY, JSON.stringify(entries));
      return true;
    } catch {
      return false;
    }
  }

  return {
    // Newest first.
    listEntries() {
      return readEntries().sort((first, second) => second.visitedAt.localeCompare(first.visitedAt));
    },

    entriesForPlace(placeId) {
      return this.listEntries().filter((entry) => entry.placeId === placeId);
    },

    // Returns { saved: true, entry } or { saved: false, reason }.
    addEntry({ placeId, cafeName, rating, note, visitedAt = new Date().toISOString() }) {
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return { saved: false, reason: "Pick a rating from 1 to 5." };
      }
      const trimmedNote = (note ?? "").trim().slice(0, MAX_NOTE_LENGTH);
      const entry = {
        entryId: `${visitedAt}-${Math.random().toString(36).slice(2, 8)}`,
        placeId,
        cafeName,
        rating,
        note: trimmedNote,
        visitedAt,
      };
      const didWrite = writeEntries([...readEntries(), entry]);
      return didWrite
        ? { saved: true, entry }
        : { saved: false, reason: "This browser won't let the page save data (private mode?)." };
    },

    removeEntry(entryId) {
      writeEntries(readEntries().filter((entry) => entry.entryId !== entryId));
    },
  };
}
