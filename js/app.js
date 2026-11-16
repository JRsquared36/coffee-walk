// Browser glue: buttons, location, map drawing, and which view the panel shows.
// The decisions live in the pure modules (walk-preferences.js, route-planning.js, cafe-selection.js, cafe-details.js).

import { loadGoogleMaps, searchNearbyCafes, searchCafesByText, computeWalkingLoop } from "./google-maps.js";
import {
  estimateStraightLineLegs,
  formatDistance,
  formatWalkingTime,
  checkInDistanceVerdict,
  buildWalkingDirectionsUrl,
} from "./route-planning.js";
import { createCoffeeLog } from "./coffee-log.js";
import { cafeMetaParts, cafeBadges, todaysHoursLabel } from "./cafe-details.js";
import { createBottomSheet, PHONE_LAYOUT_QUERY } from "./bottom-sheet.js";
import { selectCoffeeFirstCafes, MINIMUM_RATING, MINIMUM_REVIEW_COUNT } from "./cafe-selection.js";
import {
  ASPECTS,
  STOP_RANGES,
  searchRadiusMetersForWalk,
  mergeCafesWithMatches,
  rankWalkOptions,
  matchSummary,
  aspectLabelsNoStopMatched,
  isWalkOverTimeAllowance,
} from "./walk-preferences.js";

const DEFAULT_MAP_VIEW = { center: { lat: 39.5, lng: -98.35 }, zoom: 4 }; // whole US until we know where you are

const elements = {
  panel: document.getElementById("panel"),
  panelContent: document.querySelector(".panel-content"),
  sheetHandle: document.getElementById("sheet-handle"),
  cafeDetail: document.getElementById("cafe-detail"),
  startOverButton: document.getElementById("start-over-button"),
  startWalkButton: document.getElementById("start-walk-button"),
  newRouteButton: document.getElementById("new-route-button"),
  statusMessage: document.getElementById("status-message"),
  walkTotals: document.getElementById("walk-totals"),
  stopList: document.getElementById("stop-list"),
  routeSourceNote: document.getElementById("route-source-note"),
  logList: document.getElementById("log-list"),
  emptyLogMessage: document.getElementById("empty-log-message"),
  checkInDialog: document.getElementById("check-in-dialog"),
  checkInForm: document.getElementById("check-in-form"),
  checkInCafeName: document.getElementById("check-in-cafe-name"),
  checkInNote: document.getElementById("check-in-note"),
  checkInError: document.getElementById("check-in-error"),
  saveCheckInButton: document.getElementById("save-check-in-button"),
  cancelCheckInButton: document.getElementById("cancel-check-in-button"),
};

let coffeeLog;
try {
  coffeeLog = createCoffeeLog(window.localStorage);
} catch {
  // Some browsers throw just for touching localStorage when storage is blocked.
  coffeeLog = createCoffeeLog({ getItem: () => null, setItem: () => { throw new Error("blocked"); } });
}

const walk = {
  start: null,          // {lat, lng}
  preferences: null,    // what was chosen when this walk was planned: { aspectIds, maxWalkMinutes, stopRange }
  options: [],          // the best walks for those preferences, best first; "New route" steps through them without searching again
  optionIndex: 0,
  notices: [],          // things to tell the walker about this plan, e.g. a preference search that failed
  orderedStops: [],
  legs: [],             // walking distance/time for each leg of the current walk
  path: [],             // the points of the route line, used to zoom the map to the walk
};
let googleLibraries;    // { map, Polyline, LatLngBounds, AdvancedMarkerElement }
let selectedStopIndex = null; // which stop's details are open, or null
let drawnMarkers = [];  // removed before drawing a new walk
let stopMarkers = [];   // stopMarkers[i] is the pin for walk.orderedStops[i]
let drawnRouteLine = null;
let isWaitingForMapTap = false;
let cafeBeingCheckedIn = null;
let googleMapsApiKey = null; // loaded from js/config.js at startup

// The phone bottom sheet. Created before anything else so the layout is right even with no API key.
const bottomSheet = createBottomSheet({ sheetElement: elements.panel, handleElement: elements.sheetHandle });
bottomSheet.setSnap("full"); // the app opens on the setup view; see showView

function showStatus(message) {
  elements.statusMessage.textContent = message;
}

// The panel shows one view at a time: "setup" (choose and start), "walk" (the stop list)
// or "detail" (one café). css/style.css shows the view named in data-view.
function showView(viewName) {
  const previousViewName = elements.panel.dataset.view;
  elements.panel.dataset.view = viewName;
  elements.panelContent.scrollTop = 0;
  // Phone sheet height: choosing preferences needs the room and the map is still empty, so setup is
  // full height. Once there's a route, drop to half so the map shows it. Otherwise leave the height
  // the walker chose, only lifting it if it's at peek.
  if (viewName === "setup") bottomSheet.setSnap("full");
  else if (previousViewName === "setup") bottomSheet.setSnap("half");
  else bottomSheet.ensureAtLeastHalf();
}

// ---------- Startup ----------

// The preference chips come from the ASPECTS list, so adding an aspect there is the only change needed.
function renderAspectChips() {
  const chipGroup = document.getElementById("aspect-chips");
  chipGroup.replaceChildren(
    ...ASPECTS.map((aspect) => {
      const checkbox = createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "aspect";
      checkbox.value = aspect.id;
      const chip = createElement("label", "chip");
      chip.append(checkbox, createElement("span", "", aspect.label));
      return chip;
    }),
  );
  chipGroup.addEventListener("change", limitAspectChoices);
}

// Each chosen preference costs one Google search and thins out what a "match" means, so only a
// few can be chosen (the number is data-max-choices in index.html). Once the limit is reached the
// other chips are switched off until one is unticked.
function limitAspectChoices() {
  const chipGroup = document.getElementById("aspect-chips");
  const maxChoices = Number(chipGroup.dataset.maxChoices) || Infinity;
  const checkboxes = [...chipGroup.querySelectorAll('input[name="aspect"]')];
  const hasReachedLimit = checkboxes.filter((checkbox) => checkbox.checked).length >= maxChoices;
  checkboxes.forEach((checkbox) => { checkbox.disabled = hasReachedLimit && !checkbox.checked; });
}

async function startApp() {
  renderAspectChips();
  renderCoffeeLog();
  try {
    // Loaded with import() instead of a top-of-file import so a missing js/config.js shows a
    // message rather than silently breaking the whole page.
    ({ GOOGLE_MAPS_API_KEY: googleMapsApiKey } = await import("./config.js"));
  } catch {
    googleMapsApiKey = null;
  }
  if (!googleMapsApiKey || googleMapsApiKey === "PASTE_YOUR_KEY_HERE") {
    showStatus("No Google Maps key found. For local preview, copy js/config.example.js to js/config.js and add your key.");
    elements.startWalkButton.disabled = true;
    return;
  }
  try {
    await loadGoogleMaps(googleMapsApiKey);
    const { Map, Polyline } = await google.maps.importLibrary("maps");
    const { LatLngBounds } = await google.maps.importLibrary("core"); // core, not maps
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const map = new Map(document.getElementById("map"), {
      ...DEFAULT_MAP_VIEW,
      mapId: "DEMO_MAP_ID", // advanced markers need a map ID; Google provides this one for testing
      clickableIcons: false,
      // Google's default buttons (Map/Satellite, fullscreen, street view, camera) crowd a small map
      // and aren't needed for a walk. Google's logo and legal links are not buttons and stay.
      disableDefaultUI: true,
      // Phones pinch to zoom. With a mouse there is no pinch, so wide screens keep the + and − buttons.
      zoomControl: !window.matchMedia(PHONE_LAYOUT_QUERY).matches,
    });
    googleLibraries = { map, Polyline, LatLngBounds, AdvancedMarkerElement };
    map.addListener("click", (event) => {
      if (isWaitingForMapTap) {
        isWaitingForMapTap = false;
        planWalkFrom({ lat: event.latLng.lat(), lng: event.latLng.lng() });
      } else if (selectedStopIndex !== null) {
        closeCafeDetail(); // tapping empty map dismisses the café, like in other map apps
      }
    });
  } catch (error) {
    showStatus(error.message);
    elements.startWalkButton.disabled = true;
  }
}

// ---------- Planning a walk ----------

elements.startWalkButton.addEventListener("click", () => {
  if (!navigator.geolocation) {
    askForMapTap("This browser can't share your location.");
    return;
  }
  showStatus("Finding you…");
  navigator.geolocation.getCurrentPosition(
    (position) => planWalkFrom({ lat: position.coords.latitude, lng: position.coords.longitude }),
    (error) => {
      const reason = error.code === error.PERMISSION_DENIED ? "Location permission was denied." : "Couldn't get your location.";
      askForMapTap(reason);
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
  );
});

elements.newRouteButton.addEventListener("click", async () => {
  if (walk.options.length < 2) return;
  walk.optionIndex = (walk.optionIndex + 1) % walk.options.length; // after the last option, back to the best one
  setButtonsBusy(true);
  try {
    await buildWalkAndReportErrors();
  } finally {
    setButtonsBusy(false);
  }
});

elements.startOverButton.addEventListener("click", () => {
  clearWalkFromMap();
  walk.orderedStops = [];
  walk.options = [];
  showStatus("");
  showView("setup");
});

function askForMapTap(reason) {
  isWaitingForMapTap = true;
  bottomSheet.setSnap("half"); // uncover the map so there's something to tap
  showStatus(`${reason} Tap the map to choose where your walk starts.`);
}

async function planWalkFrom(start) {
  walk.start = start;
  setButtonsBusy(true);
  try {
    const foundCafes = await findCafesNear(start);
    if (foundCafes) await buildWalkAndReportErrors();
  } finally {
    setButtonsBusy(false); // runs on every path, including early returns and errors
  }
}

// Reads the preference chips in the setup view.
function chosenPreferences() {
  const checkedValue = (name) => document.querySelector(`input[name="${name}"]:checked`).value;
  return {
    aspectIds: [...document.querySelectorAll('input[name="aspect"]:checked')].map((input) => input.value),
    maxWalkMinutes: Number(checkedValue("walk-minutes")),
    stopRange: STOP_RANGES[checkedValue("stop-range")],
  };
}

// Finds cafés and ranks the possible walks. Returns true if there is a walk to show; otherwise shows why not.
async function findCafesNear(start) {
  const preferences = chosenPreferences();
  const radiusMeters = searchRadiusMetersForWalk(preferences.maxWalkMinutes);
  const chosenAspects = ASPECTS.filter((aspect) => preferences.aspectIds.includes(aspect.id));
  showStatus(chosenAspects.length > 0 ? "Looking for coffee shops that fit…" : "Looking for coffee shops nearby…");

  // One plain nearby search plus one text search per chosen aspect, all at once.
  let nearbyCafes;
  const cafesByAspectId = {};
  const notices = [];
  try {
    const nearbySearch = searchNearbyCafes(start, radiusMeters);
    const aspectSearches = await Promise.allSettled(
      chosenAspects.map((aspect) => searchCafesByText(start, radiusMeters, aspect.searchText)));
    nearbyCafes = await nearbySearch;
    aspectSearches.forEach((result, index) => {
      const aspect = chosenAspects[index];
      if (result.status === "fulfilled") {
        cafesByAspectId[aspect.id] = result.value;
      } else {
        // One failed preference search shouldn't cost the whole walk. Say which one, with Google's reason.
        console.error(result.reason);
        notices.push(`Couldn't check "${aspect.label}". Google said: ${result.reason.message}`);
      }
    });
  } catch (error) {
    console.error(error);
    // Show Google's own reason: on a phone there is no console to look in.
    showStatus(`Café search failed. Google said: ${error.message}`);
    return false;
  }

  const allCafes = mergeCafesWithMatches({ start, radiusMeters, nearbyCafes, cafesByAspectId, selectedAspectIds: preferences.aspectIds });
  const selection = selectCoffeeFirstCafes(allCafes); // text search can return bagel shops too, so the same rules apply
  if (selection.qualifyingCafes.length === 0) {
    showStatus(`No coffee shops within ${formatDistance(radiusMeters)} met the bar${describeExclusions(selection.excludedCountsByReason)}. Try a longer walk, or tap the map somewhere busier.`);
    isWaitingForMapTap = true;
    bottomSheet.setSnap("half"); // uncover the map so there's something to tap
    return false;
  }

  // Say so when closed cafés were left out, so a missing favourite isn't a mystery.
  const closedCount = selection.excludedCountsByReason["closed now"] ?? 0;
  if (closedCount > 0) notices.push(`Left out ${closedCount} coffee shop${closedCount === 1 ? "" : "s"} nearby that ${closedCount === 1 ? "is" : "are"} closed right now.`);

  walk.preferences = preferences;
  walk.notices = notices;
  walk.options = rankWalkOptions({
    start,
    cafes: selection.qualifyingCafes,
    selectedAspectIds: preferences.aspectIds,
    stopRange: preferences.stopRange,
    maxWalkMinutes: preferences.maxWalkMinutes,
  });
  walk.optionIndex = 0;
  return true;
}

// e.g. " (skipped: 3 chains, 2 below 4★ / 20 reviews)", so an empty result isn't a mystery.
function describeExclusions(excludedCountsByReason) {
  const labels = {
    "chain": (count) => `${count} chain${count === 1 ? "" : "s"}`,
    "not coffee-first": (count) => `${count} not coffee-first`,
    "below quality floor": (count) => `${count} below ${MINIMUM_RATING}★ / ${MINIMUM_REVIEW_COUNT} reviews`,
    "closed now": (count) => `${count} closed right now`,
  };
  const parts = Object.entries(excludedCountsByReason).map(([reason, count]) => labels[reason](count));
  return parts.length > 0 ? ` (skipped: ${parts.join(", ")})` : "";
}

// Separate from the search so the message says which part actually failed.
async function buildWalkAndReportErrors() {
  try {
    await buildAndShowWalk();
  } catch (error) {
    console.error(error);
    showStatus(`Found cafés, but couldn't build the walk: ${error.message}`);
  }
}

async function buildAndShowWalk() {
  const option = walk.options[walk.optionIndex];
  walk.orderedStops = option.stops;

  let legs;
  let path;
  let usedRealStreets = true;
  try {
    ({ legs, path } = await computeWalkingLoop(googleMapsApiKey, walk.start, walk.orderedStops));
  } catch (error) {
    console.warn("Walking route unavailable; drawing straight lines instead.", error);
    usedRealStreets = false;
    legs = estimateStraightLineLegs(walk.start, walk.orderedStops);
    path = [walk.start, ...walk.orderedStops.map((stop) => stop.location), walk.start];
  }

  walk.legs = legs;
  drawWalkOnMap(path, usedRealStreets);
  walk.path = path; // after drawing, because drawing first clears the previous walk (and its path)
  renderStopList();

  const totalMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const totalSeconds = legs.reduce((sum, leg) => sum + leg.durationSeconds, 0);
  elements.walkTotals.textContent = `${walk.orderedStops.length} stops · ${formatDistance(totalMeters)} · ~${formatWalkingTime(totalSeconds)}`;
  elements.routeSourceNote.textContent = usedRealStreets
    ? "Walking route by Google. Times don't include time spent in cafés."
    : "Couldn't get a street route, so these are straight lines with estimated times.";
  showView("walk");
  zoomMapToWalkAfterLayout();
  showStatus(walkNotices(totalSeconds).join(" "));
}

// Plain statements of where this walk falls short of what was asked, so nothing is quietly relaxed.
function walkNotices(totalWalkSeconds) {
  const { aspectIds, maxWalkMinutes, stopRange } = walk.preferences;
  const notices = [...walk.notices];
  if (walk.orderedStops.length < stopRange.minStops) {
    const count = walk.orderedStops.length;
    notices.push(`Only found ${count} coffee shop${count === 1 ? "" : "s"} that met the bar nearby, so your walk is shorter.`);
  }
  if (isWalkOverTimeAllowance(totalWalkSeconds, maxWalkMinutes)) { // a few minutes over is fine and isn't mentioned
    notices.push(`This walk is about ${formatWalkingTime(totalWalkSeconds)}, over your ${maxWalkMinutes} min. It's the closest fit nearby.`);
  }
  const unmatchedLabels = aspectLabelsNoStopMatched(walk.orderedStops, aspectIds);
  if (unmatchedLabels.length > 0) notices.push(`No stop on this walk matched: ${unmatchedLabels.join(", ")}.`);
  return notices;
}

// Reads a design token from css/tokens.css, for the few places (Google's route line) that need a
// colour in JavaScript. Keeps tokens.css the only place colours are defined.
function designToken(tokenName) {
  return getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
}

function setButtonsBusy(isBusy) {
  elements.startWalkButton.disabled = isBusy;
  elements.newRouteButton.disabled = isBusy || walk.options.length < 2; // with one option there is no other route to show
}

// ---------- Map drawing ----------

function drawWalkOnMap(path, usedRealStreets) {
  const { map, Polyline, AdvancedMarkerElement } = googleLibraries;
  clearWalkFromMap();

  // Pins are our own elements (styled by .map-pin in css/style.css) placed inside Google's markers.
  const startPin = createElement("div", "map-pin map-pin--start");
  drawnMarkers.push(new AdvancedMarkerElement({ map, position: walk.start, content: startPin, title: "Start" }));

  stopMarkers = walk.orderedStops.map((stop, index) => {
    const pin = createElement("div", "map-pin", String(index + 1));
    const marker = new AdvancedMarkerElement({
      map, position: stop.location, content: pin, title: stop.name, gmpClickable: true,
    });
    // Google has been moving markers from the "click" event to "gmp-click". Listening to both is
    // safe: opening the same café twice just leaves it open.
    marker.addListener?.("click", () => openCafeDetail(index));
    marker.addEventListener?.("gmp-click", () => openCafeDetail(index));
    return marker;
  });
  drawnMarkers.push(...stopMarkers);

  // A dashed line means "not a real street route". Google draws dashes as repeated line symbols.
  const routeColor = designToken("--color-route");
  const lineStyle = usedRealStreets
    ? { strokeColor: routeColor, strokeOpacity: 0.9, strokeWeight: 5 }
    : {
        strokeOpacity: 0,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: routeColor, scale: 3 }, offset: "0", repeat: "14px" }],
      };
  drawnRouteLine = new Polyline({ map, path, ...lineStyle });

}

// Zooms the map so the whole route is visible, with some breathing room around it.
function zoomMapToWalk() {
  if (walk.path.length === 0) return;
  const { map, LatLngBounds } = googleLibraries;
  const mapBox = document.getElementById("map").getBoundingClientRect();
  // On a small map, a fixed 48px margin on every side can leave no room for the route at all.
  const marginPx = Math.min(48, Math.floor(Math.min(mapBox.width, mapBox.height) / 5));
  const bounds = new LatLngBounds();
  walk.path.forEach((point) => bounds.extend(point));
  map.fitBounds(bounds, marginPx);
}

// On phones, showing the walk shrinks the sheet from full to half, which makes the map taller.
// Zooming before the browser has applied that would fit the route to the old, nearly hidden map.
// Two animation frames is enough for the browser to lay out and for Google to notice the new size.
function zoomMapToWalkAfterLayout() {
  requestAnimationFrame(() => requestAnimationFrame(zoomMapToWalk));
}

function clearWalkFromMap() {
  drawnMarkers.forEach((marker) => (marker.map = null));
  drawnRouteLine?.setMap(null);
  drawnMarkers = [];
  stopMarkers = [];
  drawnRouteLine = null;
  selectedStopIndex = null;
  walk.path = [];
}

// ---------- Stop list ----------

// legs[0] is start → stop 1, legs[i] is stop i → stop i+1, the last leg returns to start.
function legLabel(stopIndex) {
  const leg = walk.legs[stopIndex];
  const fromWhere = stopIndex === 0 ? "from start" : `from stop ${stopIndex}`;
  return `${formatDistance(leg.distanceMeters)} · ${formatWalkingTime(leg.durationSeconds)} ${fromWhere}`;
}

function badgesFor(stop) {
  const badges = cafeBadges(stop);
  matchSummary(stop, walk.preferences.aspectIds).matchedLabels.forEach((label) => badges.push({ label, tone: "accent" }));
  const pastVisits = coffeeLog.entriesForPlace(stop.placeId);
  if (pastVisits.length > 0) badges.push({ label: `Logged ${pastVisits.length}× · last ${pastVisits[0].rating}★`, tone: "neutral" });
  return badges;
}

function renderStopList() {
  elements.stopList.replaceChildren(
    ...walk.orderedStops.map((stop, index) => {
      // The whole card is one button, so it's a big tap target and works with a keyboard.
      const card = createElement("button", "stop");
      card.type = "button";
      card.dataset.stopIndex = String(index);
      card.classList.toggle("is-selected", index === selectedStopIndex);
      card.addEventListener("click", () => openCafeDetail(index));

      card.append(createElement("span", "stop-number", String(index + 1)));
      card.append(createElement("span", "stop-name", stop.name)); // textContent, never innerHTML: names come from the internet
      const meta = cafeMetaParts(stop);
      if (meta.length > 0) card.append(createElement("span", "stop-details", meta.join(" · ")));
      const badges = badgesFor(stop);
      if (badges.length > 0) card.append(createBadgeRow(badges));
      const hoursToday = todaysHoursLabel(stop);
      if (hoursToday) card.append(createElement("span", "stop-details", hoursToday));
      card.append(createElement("span", "stop-details", legLabel(index)));

      const item = createElement("li");
      item.append(card);
      return item;
    }),
  );

  const returnLeg = walk.legs[walk.legs.length - 1];
  const returnItem = createElement("li", "caption",
    `Back to start: ${formatDistance(returnLeg.distanceMeters)} · ${formatWalkingTime(returnLeg.durationSeconds)}`);
  elements.stopList.append(returnItem);
}

function createBadgeRow(badges) {
  const row = createElement("div", "badge-row");
  badges.forEach(({ label, tone }) => row.append(createElement("span", `badge badge--${tone}`, label)));
  return row;
}

// A native <details> fold-out: closed by default, no JavaScript needed to open and close it.
function createWeeklyHoursFoldout(weeklyHours) {
  const foldout = createElement("details", "weekly-hours");
  foldout.append(createElement("summary", "", "All hours"));
  const list = createElement("ul");
  weeklyHours.forEach((dayLine) => list.append(createElement("li", "", dayLine)));
  foldout.append(list);
  return foldout;
}

function createExternalLink(text, url, className = "") {
  const link = createElement("a", className, text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener"; // the opened page can't control this one
  return link;
}

// ---------- Café detail view ----------

function openCafeDetail(stopIndex) {
  const stop = walk.orderedStops[stopIndex];
  if (!stop) return;
  selectedStopIndex = stopIndex;
  renderCafeDetail();
  highlightStopCard(stopIndex);
  showView("detail");
  googleLibraries.map.panTo(stop.location); // the map ends above the sheet, so this centres the pin in what's visible
}

function closeCafeDetail() {
  selectedStopIndex = null;
  highlightStopCard(null);
  showView("walk");
}

// Built as DOM nodes rather than an HTML string, so café text can't inject markup.
function renderCafeDetail() {
  const stop = walk.orderedStops[selectedStopIndex];
  if (!stop) return;

  const title = createElement("div", "detail-title");
  title.append(createElement("p", "caption", `Stop ${selectedStopIndex + 1} of ${walk.orderedStops.length} · ${legLabel(selectedStopIndex)}`));
  title.append(createElement("h2", "", stop.name));
  const badges = badgesFor(stop);
  if (badges.length > 0) title.append(createBadgeRow(badges));

  const closeButton = createElement("button", "close-button", "✕");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "Back to your walk");
  closeButton.addEventListener("click", closeCafeDetail);
  const header = createElement("div", "detail-header");
  header.append(title, closeButton);

  const facts = createElement("div", "detail-facts");
  const meta = cafeMetaParts(stop);
  if (meta.length > 0) facts.append(createElement("p", "strong", meta.join(" · ")));
  facts.append(createElement("p", stop.weeklyHours ? "" : "text-secondary", todaysHoursLabel(stop) ?? "Google has no hours for this café."));
  if (stop.address) facts.append(createElement("p", "text-secondary", stop.address));
  if (stop.weeklyHours) facts.append(createWeeklyHoursFoldout(stop.weeklyHours));

  const checkInButton = createElement("button", "button button--primary button--block", "I'm here");
  checkInButton.type = "button";
  checkInButton.addEventListener("click", () => openCheckIn(stop));

  const matches = createMatchExplanation(stop);

  const links = createElement("div", "detail-actions");
  links.append(createExternalLink("Directions", buildWalkingDirectionsUrl(stop), "button button--secondary"));
  if (stop.websiteUrl) links.append(createExternalLink("Website", stop.websiteUrl, "button button--quiet"));

  elements.cafeDetail.replaceChildren(...[header, facts, matches, checkInButton, links].filter(Boolean));
  if (stop.googleMapsUrl) {
    const moreLink = createExternalLink("Reviews and photos on Google Maps", stop.googleMapsUrl);
    const moreLine = createElement("p", "caption");
    moreLine.append(moreLink);
    elements.cafeDetail.append(moreLine);
  }
}

// "Why this café": which chosen preferences it matched and which it didn't. Null if none were chosen.
function createMatchExplanation(stop) {
  const { matchedLabels, unmatchedLabels } = matchSummary(stop, walk.preferences.aspectIds);
  if (matchedLabels.length + unmatchedLabels.length === 0) return null;
  const explanation = createElement("div", "detail-matches");
  if (matchedLabels.length > 0) {
    explanation.append(createElement("p", "label", "Matches what you asked for"));
    explanation.append(createBadgeRow(matchedLabels.map((label) => ({ label, tone: "accent" }))));
  }
  if (unmatchedLabels.length > 0) {
    explanation.append(createElement("p", "label", matchedLabels.length > 0 ? "No sign of" : "No sign of what you asked for"));
    explanation.append(createBadgeRow(unmatchedLabels.map((label) => ({ label, tone: "neutral" }))));
  }
  explanation.append(createElement("p", "caption", "Among Google's top 5 nearby for each, so treat it as a hint."));
  return explanation;
}

// Highlights the chosen café's card and enlarges its pin; pass null to clear.
function highlightStopCard(selectedStopIndex) {
  elements.stopList.querySelectorAll(".stop").forEach((card) => {
    card.classList.toggle("is-selected", card.dataset.stopIndex === String(selectedStopIndex));
  });
  stopMarkers.forEach((marker, index) => marker.content?.classList.toggle("is-selected", index === selectedStopIndex));
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

// ---------- Check-ins ----------

function openCheckIn(cafe) {
  cafeBeingCheckedIn = cafe;
  elements.checkInForm.reset();
  elements.checkInError.textContent = "";
  elements.checkInCafeName.textContent = `Check in at ${cafe.name}`;
  elements.checkInDialog.showModal();
}

elements.cancelCheckInButton.addEventListener("click", () => elements.checkInDialog.close());

elements.checkInForm.addEventListener("submit", (event) => {
  event.preventDefault(); // keep the dialog open until we've confirmed you're actually there
  const rating = Number(new FormData(elements.checkInForm).get("rating"));
  const cafe = cafeBeingCheckedIn;
  if (!navigator.geolocation) {
    elements.checkInError.textContent = "Checking in needs your location, and this browser can't share it.";
    return;
  }
  elements.saveCheckInButton.disabled = true;
  elements.checkInError.textContent = "";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      elements.saveCheckInButton.disabled = false;
      const here = { lat: position.coords.latitude, lng: position.coords.longitude };
      const verdict = checkInDistanceVerdict(here, position.coords.accuracy, cafe.location);
      if (!verdict.isCloseEnough) {
        elements.checkInError.textContent = `You're about ${formatDistance(verdict.distanceMeters)} away. Check in once you're at the café.`;
        return;
      }
      const result = coffeeLog.addEntry({ placeId: cafe.placeId, cafeName: cafe.name, rating, note: elements.checkInNote.value });
      if (!result.saved) {
        elements.checkInError.textContent = result.reason;
        return;
      }
      elements.checkInDialog.close();
      renderCoffeeLog();
      refreshWalkViews();
    },
    () => {
      elements.saveCheckInButton.disabled = false;
      elements.checkInError.textContent = "Couldn't confirm your location, so we can't check you in yet.";
    },
    // maximumAge 0: a fresh reading, so an old position from across town can't be reused.
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
  );
});

// After the log changes, redraw whatever shows "Logged" badges.
function refreshWalkViews() {
  if (walk.orderedStops.length === 0) return;
  renderStopList();
  if (selectedStopIndex !== null) renderCafeDetail();
}

function renderCoffeeLog() {
  const entries = coffeeLog.listEntries();
  elements.emptyLogMessage.hidden = entries.length > 0;
  elements.logList.replaceChildren(
    ...entries.map((entry) => {
      const item = createElement("li", "log-entry");
      const header = createElement("div", "log-entry-header");
      const title = createElement("span", "", `${entry.cafeName} `);
      const stars = createElement("span", "log-entry-stars", "★".repeat(entry.rating));
      stars.setAttribute("aria-label", `${entry.rating} out of 5`);
      title.append(stars);
      header.append(title);
      const removeButton = createElement("button", "button button--quiet button--small", "Remove");
      removeButton.type = "button";
      removeButton.addEventListener("click", () => {
        coffeeLog.removeEntry(entry.entryId);
        renderCoffeeLog();
        refreshWalkViews();
      });
      header.append(removeButton);
      item.append(header);
      item.append(createElement("p", "caption", new Date(entry.visitedAt).toLocaleDateString()));
      if (entry.note) item.append(createElement("p", "", entry.note));
      return item;
    }),
  );
}

startApp();
