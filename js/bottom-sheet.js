// The phone bottom sheet: the panel that slides up over the map. This file handles dragging and
// tapping the handle; the maths lives in sheet-snapping.js. On wide screens the panel is a sidebar
// and none of this applies.

import { sheetSnapHeights, clampSheetHeight, nearestSnapName, nextSnapNameOnTap } from "./sheet-snapping.js";

export const PHONE_LAYOUT_QUERY = "(max-width: 799px)"; // keep in step with the media query in css/style.css
const TAP_MOVEMENT_LIMIT_PX = 6; // less finger movement than this is a tap, not a drag
// The sheet's rounded top corners overlap the map by this much, so no page background shows through.
const SHEET_OVERLAP_ON_MAP_PX = 24;

export function createBottomSheet({ sheetElement, handleElement }) {
  const phoneLayout = window.matchMedia(PHONE_LAYOUT_QUERY);
  let currentSnapName = "half";
  let activeDrag = null; // { startPointerY, startHeightPx, hasMoved }
  let ignoreNextClick = false;

  const snapHeights = () => sheetSnapHeights(window.innerHeight);

  function showHeight(heightPx) {
    sheetElement.style.setProperty("--sheet-height", `${heightPx}px`);
  }

  // The map ends where the sheet begins, so Google's logo and controls are never hidden under it.
  // Done only when the sheet comes to rest: resizing the map on every drag frame would stutter.
  function resizeMapAboveSheet(heightPx) {
    const mapBottomPx = Math.max(0, heightPx - SHEET_OVERLAP_ON_MAP_PX);
    document.documentElement.style.setProperty("--map-bottom", `${mapBottomPx}px`);
  }

  function setSnap(snapName) {
    currentSnapName = snapName;
    sheetElement.dataset.snap = snapName;
    const heightPx = snapHeights()[snapName];
    showHeight(heightPx);
    resizeMapAboveSheet(heightPx);
  }

  handleElement.addEventListener("pointerdown", (event) => {
    if (!phoneLayout.matches) return;
    activeDrag = { startPointerY: event.clientY, startHeightPx: sheetElement.getBoundingClientRect().height, hasMoved: false };
    handleElement.setPointerCapture?.(event.pointerId); // keep receiving moves even if the finger leaves the handle
    sheetElement.classList.add("is-dragging");
  });

  handleElement.addEventListener("pointermove", (event) => {
    if (!activeDrag) return;
    const draggedUpPx = activeDrag.startPointerY - event.clientY;
    if (Math.abs(draggedUpPx) > TAP_MOVEMENT_LIMIT_PX) activeDrag.hasMoved = true;
    if (activeDrag.hasMoved) showHeight(clampSheetHeight(activeDrag.startHeightPx + draggedUpPx, snapHeights()));
  });

  function endDrag() {
    if (!activeDrag) return;
    const wasDragged = activeDrag.hasMoved;
    activeDrag = null;
    sheetElement.classList.remove("is-dragging");
    if (!wasDragged) return; // a tap: the click handler below deals with it
    setSnap(nearestSnapName(sheetElement.getBoundingClientRect().height, snapHeights()));
    // The browser fires a click after a drag that started and ended on the handle. Don't treat it as a tap.
    ignoreNextClick = true;
    setTimeout(() => { ignoreNextClick = false; }, 0);
  }
  handleElement.addEventListener("pointerup", endDrag);
  handleElement.addEventListener("pointercancel", endDrag);

  // Also fires for Enter and Space, so the sheet can be resized from a keyboard.
  handleElement.addEventListener("click", () => {
    if (ignoreNextClick || !phoneLayout.matches) return;
    setSnap(nextSnapNameOnTap(currentSnapName));
  });

  // Rotating the phone or showing the address bar changes the screen height.
  window.addEventListener("resize", () => setSnap(currentSnapName));

  setSnap(currentSnapName);
  return {
    setSnap,
    // Lift the sheet to at least half so freshly shown content isn't hidden at peek height.
    ensureAtLeastHalf() {
      if (currentSnapName === "peek") setSnap("half");
    },
  };
}
