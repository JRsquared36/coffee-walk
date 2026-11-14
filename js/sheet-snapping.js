// Pure maths for the phone bottom sheet: which heights it rests at, and which one a drag ends on.
// No browser needed, so it's unit-tested.

export const PEEK_HEIGHT_PX = 132;        // handle plus one line of heading: almost all map
export const HALF_HEIGHT_FRACTION = 0.55; // of the screen
export const GAP_ABOVE_FULL_SHEET_PX = 56; // a strip of map stays visible so the sheet never looks like a new page

// The three resting heights ("snap points") for a screen of this height, smallest first.
export function sheetSnapHeights(viewportHeightPx) {
  const full = Math.max(viewportHeightPx - GAP_ABOVE_FULL_SHEET_PX, 0);
  const peek = Math.min(PEEK_HEIGHT_PX, full);
  const half = Math.min(Math.max(Math.round(viewportHeightPx * HALF_HEIGHT_FRACTION), peek), full);
  return { peek, half, full };
}

// While dragging, the sheet can't go below peek or above full.
export function clampSheetHeight(heightPx, snapHeights) {
  return Math.min(Math.max(heightPx, snapHeights.peek), snapHeights.full);
}

// Where a drag that ended at this height should settle: the closest snap point.
export function nearestSnapName(heightPx, snapHeights) {
  let closestName = "half";
  let closestDistance = Infinity;
  for (const [name, snapHeight] of Object.entries(snapHeights)) {
    const distance = Math.abs(snapHeight - heightPx);
    if (distance < closestDistance) {
      closestDistance = distance;
      closestName = name;
    }
  }
  return closestName;
}

// Tapping the handle (or pressing Enter on it) steps through the heights without dragging.
export function nextSnapNameOnTap(currentSnapName) {
  return { peek: "half", half: "full", full: "half" }[currentSnapName] ?? "half";
}
