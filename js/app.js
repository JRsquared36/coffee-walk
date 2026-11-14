// Browser glue: buttons, location, map drawing. The decisions live in route-planning.js.

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
import { cafeSummaryParts, cafeMetaParts, cafeBadges, todaysHoursLabel } from "./cafe-details.js";
import { selectCoffeeFirstCafes, topCandidatePool, MINIMUM_RATING, MINIMUM_REVIEW_COUNT } from "./cafe-selection.js";

const FIRST_SEARCH_RADIUS_METERS = 800;
const WIDER_SEARCH_RADIUS_METERS = 1500;
const DEFAULT_MAP_VIEW = { center: { lat: 39.5, lng: -98.35 }, zoom: 4 }; // whole US until we know where you are

const elements = {
  startWalkButton: document.getElementById("start-walk-button"),
  newRouteButton: document.getElementById("new-route-button"),
  statusMessage: document.getElementById("status-message"),
  walkSection: document.getElementById("walk-section"),
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
let cafeInfoPopup;      // one shared Google InfoWindow; opening it on another café moves it there
let drawnMarkers = [];  // removed before drawing a new walk
let stopMarkers = [];   // stopMarkers[i] is the pin for walk.orderedStops[i]
let drawnRouteLine = null;
let isWaitingForMapTap = false;
let cafeBeingCheckedIn = null;
let googleMapsApiKey = null; // loaded from js/config.js at startup

function showStatus(message) {
  elements.statusMessage.textContent = message;
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
    const { Map, Polyline, InfoWindow } = await google.maps.importLibrary("maps");
    const { LatLngBounds } = await google.maps.importLibrary("core"); // core, not maps
    const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
    const map = new Map(document.getElementById("map"), {
      ...DEFAULT_MAP_VIEW,
      mapId: "DEMO_MAP_ID", // advanced markers need a map ID; Google provides this one for testing
      clickableIcons: false,
    });
    googleLibraries = { map, Polyline, LatLngBounds, AdvancedMarkerElement };
    cafeInfoPopup = new InfoWindow();
    cafeInfoPopup.addListener("closeclick", () => highlightStopCard(null));
    map.addListener("click", (event) => {
      if (!isWaitingForMapTap) return;
      isWaitingForMapTap = false;
      planWalkFrom({ lat: event.latLng.lat(), lng: event.latLng.lng() });
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
  elements.walkTotals.textContent = `${walk.orderedStops.length} stops · ${formatDistance(totalMeters)} · ~${formatWalkingTime(totalSeconds)} walking`;
  elements.routeSourceNote.textContent = usedRealStreets
    ? "Walking route by Google. Times don't include time spent in cafés."
    : "Couldn't get a street route, so these are straight lines with estimated times.";
  elements.newRouteButton.disabled = candidatePool.length <= requestedStops; // nothing new to pick from
  elements.walkSection.hidden = false;
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
  drawnMarkers.forEach((marker) => (marker.map = null));
  drawnRouteLine?.setMap(null);
  drawnMarkers = [];
  cafeInfoPopup.close();

  // Pins are our own elements (styled by .map-pin in css/style.css) placed inside Google's markers.
  const startPin = createElement("div", "map-pin map-pin--start");
  drawnMarkers.push(new AdvancedMarkerElement({ map, position: walk.start, content: startPin, title: "Start" }));

  stopMarkers = walk.orderedStops.map((stop, index) => {
    const pin = createElement("div", "map-pin", String(index + 1));
    const marker = new AdvancedMarkerElement({
      map, position: stop.location, content: pin, title: stop.name, gmpClickable: true,
    });
    // Google has been moving markers from the "click" event to "gmp-click". Listening to both is
    // safe: opening the same popup twice just leaves it open.
    marker.addListener?.("click", () => openCafeInfo(index));
    marker.addEventListener?.("gmp-click", () => openCafeInfo(index));
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

// ---------- Stop list ----------

// legs[0] is start → stop 1, legs[i] is stop i → stop i+1, the last leg returns to start.
function renderStopList() {
  const legs = walk.legs;
  elements.stopList.replaceChildren(
    ...walk.orderedStops.map((stop, index) => {
      const item = createElement("li", "stop");
      item.dataset.stopIndex = String(index);
      item.append(createElement("span", "stop-number", String(index + 1)));
      // A button (not plain text) so it works with a keyboard and screen readers too.
      const nameButton = createElement("button", "stop-name", stop.name); // textContent, never innerHTML: names come from the internet
      nameButton.type = "button";
      nameButton.title = "Show on map";
      nameButton.addEventListener("click", () => openCafeInfo(index, { scrollMapIntoView: true }));
      item.append(nameButton);

      const meta = cafeMetaParts(stop);
      if (meta.length > 0) item.append(createElement("span", "stop-details", meta.join(" · ")));

      const badges = cafeBadges(stop);
      const pastVisits = coffeeLog.entriesForPlace(stop.placeId);
      if (pastVisits.length > 0) badges.push({ label: `Logged ${pastVisits.length}× · last ${pastVisits[0].rating}★`, tone: "accent" });
      if (badges.length > 0) item.append(createBadgeRow(badges));

      const hoursToday = todaysHoursLabel(stop);
      if (hoursToday) item.append(createElement("span", "stop-details", hoursToday));
      if (stop.address) item.append(createElement("span", "stop-details", stop.address));
      if (stop.weeklyHours) item.append(createWeeklyHoursFoldout(stop.weeklyHours));
      const fromWhere = index === 0 ? "from start" : `from stop ${index}`;
      item.append(createElement("span", "stop-details",
        `${formatDistance(legs[index].distanceMeters)} · ${formatWalkingTime(legs[index].durationSeconds)} ${fromWhere}`));

      const actions = createElement("div", "stop-actions");
      const checkInButton = createElement("button", "button button--secondary button--small", "I'm here");
      checkInButton.type = "button";
      checkInButton.addEventListener("click", () => openCheckIn(stop));
      const directionsLink = createExternalLink("Directions", buildWalkingDirectionsUrl(stop));
      directionsLink.className = "button button--quiet button--small";
      actions.append(checkInButton, directionsLink);
      item.append(actions);
      return item;
    }),
  );

  const returnLeg = legs[legs.length - 1];
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

function createExternalLink(text, url) {
  const link = createElement("a", "", text);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener"; // the opened page can't control this one
  return link;
}

// ---------- Café popup on the map ----------

function openCafeInfo(stopIndex, { scrollMapIntoView = false } = {}) {
  const stop = walk.orderedStops[stopIndex];
  const marker = stopMarkers[stopIndex];
  if (!stop || !marker) return;
  cafeInfoPopup.setContent(buildCafeInfoContent(stop, stopIndex));
  cafeInfoPopup.open({ map: googleLibraries.map, anchor: marker });
  highlightStopCard(stopIndex);
  // On phones the map sits above the list, so tapping a card would otherwise open a popup off-screen.
  if (scrollMapIntoView && window.matchMedia("(max-width: 799px)").matches) {
    document.getElementById("map").scrollIntoView({ behavior: "smooth" });
  }
}

// Built as DOM nodes rather than an HTML string, so café text can't inject markup.
function buildCafeInfoContent(stop, stopIndex) {
  const content = createElement("div", "cafe-popup");
  content.append(createElement("strong", "cafe-popup-name", `${stopIndex + 1}. ${stop.name}`));
  const summary = cafeSummaryParts(stop);
  if (summary.length > 0) content.append(createElement("p", "", summary.join(" · ")));
  if (stop.address) content.append(createElement("p", "cafe-popup-muted", stop.address));
  if (!stop.weeklyHours) content.append(createElement("p", "cafe-popup-muted", "Google has no hours for this café."));

  const links = createElement("p", "cafe-popup-links");
  links.append(createExternalLink("Directions", buildWalkingDirectionsUrl(stop)));
  if (stop.websiteUrl) links.append(createExternalLink("Website", stop.websiteUrl));
  if (stop.googleMapsUrl) links.append(createExternalLink("Google Maps", stop.googleMapsUrl));
  content.append(links);
  return content;
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
      if (walk.orderedStops.length) renderStopList();
    },
    () => {
      elements.saveCheckInButton.disabled = false;
      elements.checkInError.textContent = "Couldn't confirm your location, so we can't check you in yet.";
    },
    // maximumAge 0: a fresh reading, so an old position from across town can't be reused.
    { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
  );
});

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
        if (walk.orderedStops.length) renderStopList();
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
