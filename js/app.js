// Browser glue: buttons, location, map drawing, and which view the panel shows.
// The decisions live in the pure modules (route-planning.js, cafe-selection.js, cafe-details.js).

import { loadGoogleMaps, searchNearbyCafes, computeWalkingLoop } from "./google-maps.js";
import {
  chooseRandomStops,
  orderStopsForShortestLoop,
  estimateStraightLineLegs,
  formatDistance,
  formatWalkingTime,
  checkInDistanceVerdict,
  buildWalkingDirectionsUrl,
} from "./route-planning.js";
import { createCoffeeLog } from "./coffee-log.js";
import { cafeMetaParts, cafeBadges, todaysHoursLabel } from "./cafe-details.js";
import { createBottomSheet } from "./bottom-sheet.js";
import { selectCoffeeFirstCafes, topCandidatePool, MINIMUM_RATING, MINIMUM_REVIEW_COUNT } from "./cafe-selection.js";

const FIRST_SEARCH_RADIUS_METERS = 800;
const WIDER_SEARCH_RADIUS_METERS = 1500;
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
  nearbyCafes: [],      // qualifying coffee stops for this start, best first; cached so "New route" doesn't search again
  orderedStops: [],
  legs: [],             // walking distance/time for each leg of the current walk
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

function showStatus(message) {
  elements.statusMessage.textContent = message;
}

// The panel shows one view at a time: "setup" (choose and start), "walk" (the stop list)
// or "detail" (one café). css/style.css shows the view named in data-view.
function showView(viewName) {
  elements.panel.dataset.view = viewName;
  elements.panelContent.scrollTop = 0;
  bottomSheet.ensureAtLeastHalf();
}

// ---------- Startup ----------

async function startApp() {
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

elements.newRouteButton.addEventListener("click", () => {
  if (walk.start) buildAndShowWalk();
});

elements.startOverButton.addEventListener("click", () => {
  clearWalkFromMap();
  walk.orderedStops = [];
  showStatus("");
  showView("setup");
});

function askForMapTap(reason) {
  isWaitingForMapTap = true;
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

// Returns true if we have cafés to build a walk from; otherwise shows why not.
async function findCafesNear(start) {
  showStatus("Looking for coffee shops nearby…");
  let selection;
  try {
    selection = selectCoffeeFirstCafes(await searchNearbyCafes(start, FIRST_SEARCH_RADIUS_METERS));
    if (selection.qualifyingCafes.length < selectedStopCount()) {
      showStatus("Only a few coffee shops close by. Looking a bit farther…");
      selection = selectCoffeeFirstCafes(await searchNearbyCafes(start, WIDER_SEARCH_RADIUS_METERS));
    }
  } catch (error) {
    console.error(error);
    // Show Google's own reason: on a phone there is no console to look in.
    showStatus(`Café search failed. Google said: ${error.message}`);
    return false;
  }
  walk.nearbyCafes = selection.qualifyingCafes;
  if (walk.nearbyCafes.length === 0) {
    showStatus(`No coffee shops within 1.5 km met the bar${describeExclusions(selection.excludedCountsByReason)}. Try tapping the map somewhere busier.`);
    isWaitingForMapTap = true;
    return false;
  }
  return true;
}

// e.g. " (skipped: 3 chains, 2 below 4★ / 20 reviews)", so an empty result isn't a mystery.
function describeExclusions(excludedCountsByReason) {
  const labels = {
    "chain": (count) => `${count} chain${count === 1 ? "" : "s"}`,
    "not coffee-first": (count) => `${count} not coffee-first`,
    "below quality floor": (count) => `${count} below ${MINIMUM_RATING}★ / ${MINIMUM_REVIEW_COUNT} reviews`,
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
  const requestedStops = selectedStopCount();
  // Random picks from the best-scoring cafés: good stops, with variety when you tap "New route".
  const candidatePool = topCandidatePool(walk.nearbyCafes, requestedStops);
  const stops = chooseRandomStops(candidatePool, requestedStops);
  walk.orderedStops = orderStopsForShortestLoop(walk.start, stops);

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
  renderStopList();

  const totalMeters = legs.reduce((sum, leg) => sum + leg.distanceMeters, 0);
  const totalSeconds = legs.reduce((sum, leg) => sum + leg.durationSeconds, 0);
  elements.walkTotals.textContent = `${walk.orderedStops.length} stops · ${formatDistance(totalMeters)} · ~${formatWalkingTime(totalSeconds)}`;
  elements.routeSourceNote.textContent = usedRealStreets
    ? "Walking route by Google. Times don't include time spent in cafés."
    : "Couldn't get a street route, so these are straight lines with estimated times.";
  elements.newRouteButton.disabled = candidatePool.length <= requestedStops; // nothing new to pick from
  showView("walk");
  showStatus(walk.orderedStops.length < requestedStops
    ? `Only found ${walk.orderedStops.length} coffee shop${walk.orderedStops.length === 1 ? "" : "s"} that met the bar nearby, so your walk is shorter.`
    : "");
}

function selectedStopCount() {
  return Number(document.querySelector('input[name="stop-count"]:checked').value);
}

// Reads a design token from css/tokens.css, for the few places (Google's route line) that need a
// colour in JavaScript. Keeps tokens.css the only place colours are defined.
function designToken(tokenName) {
  return getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim();
}

function setButtonsBusy(isBusy) {
  elements.startWalkButton.disabled = isBusy;
  elements.newRouteButton.disabled = isBusy;
}

// ---------- Map drawing ----------

function drawWalkOnMap(path, usedRealStreets) {
  const { map, Polyline, LatLngBounds, AdvancedMarkerElement } = googleLibraries;
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

  const bounds = new LatLngBounds();
  path.forEach((point) => bounds.extend(point));
  map.fitBounds(bounds, 48);
}

function clearWalkFromMap() {
  drawnMarkers.forEach((marker) => (marker.map = null));
  drawnRouteLine?.setMap(null);
  drawnMarkers = [];
  stopMarkers = [];
  drawnRouteLine = null;
  selectedStopIndex = null;
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
  const pastVisits = coffeeLog.entriesForPlace(stop.placeId);
  if (pastVisits.length > 0) badges.push({ label: `Logged ${pastVisits.length}× · last ${pastVisits[0].rating}★`, tone: "accent" });
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

  const links = createElement("div", "detail-actions");
  links.append(createExternalLink("Directions", buildWalkingDirectionsUrl(stop), "button button--secondary"));
  if (stop.websiteUrl) links.append(createExternalLink("Website", stop.websiteUrl, "button button--quiet"));

  elements.cafeDetail.replaceChildren(header, facts, checkInButton, links);
  if (stop.googleMapsUrl) {
    const moreLink = createExternalLink("Reviews and photos on Google Maps", stop.googleMapsUrl);
    const moreLine = createElement("p", "caption");
    moreLine.append(moreLink);
    elements.cafeDetail.append(moreLine);
  }
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
