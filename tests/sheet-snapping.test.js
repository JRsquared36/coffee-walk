import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sheetSnapHeights,
  clampSheetHeight,
  nearestSnapName,
  nextSnapNameOnTap,
  PEEK_HEIGHT_PX,
  GAP_ABOVE_FULL_SHEET_PX,
} from "../js/sheet-snapping.js";

const IPHONE = sheetSnapHeights(844);

test("snap heights on a typical phone: peek < half < full, with map left above the full sheet", () => {
  assert.deepEqual(IPHONE, { peek: PEEK_HEIGHT_PX, half: 464, full: 844 - GAP_ABOVE_FULL_SHEET_PX });
  assert.ok(IPHONE.peek < IPHONE.half && IPHONE.half < IPHONE.full);
});

test("snap heights never go out of order on a very short screen (phone held sideways)", () => {
  for (const viewportHeight of [0, 100, 150, 200, 320]) {
    const { peek, half, full } = sheetSnapHeights(viewportHeight);
    assert.ok(0 <= peek && peek <= half && half <= full, `viewport ${viewportHeight}: ${peek}, ${half}, ${full}`);
    assert.ok(full <= viewportHeight);
  }
});

test("a drag can't pull the sheet below peek or above full", () => {
  assert.equal(clampSheetHeight(20, IPHONE), IPHONE.peek);
  assert.equal(clampSheetHeight(5000, IPHONE), IPHONE.full);
  assert.equal(clampSheetHeight(400, IPHONE), 400);
});

test("a drag settles on the closest snap point", () => {
  assert.equal(nearestSnapName(150, IPHONE), "peek");
  assert.equal(nearestSnapName(290, IPHONE), "peek");   // 158 from peek, 174 from half
  assert.equal(nearestSnapName(310, IPHONE), "half");
  assert.equal(nearestSnapName(620, IPHONE), "half");
  assert.equal(nearestSnapName(640, IPHONE), "full");
});

test("tapping the handle steps peek → half → full → half", () => {
  assert.equal(nextSnapNameOnTap("peek"), "half");
  assert.equal(nextSnapNameOnTap("half"), "full");
  assert.equal(nextSnapNameOnTap("full"), "half");
  assert.equal(nextSnapNameOnTap("something else"), "half");
});
