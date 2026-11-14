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

const FIRST_SEARCH_RADIUS_METERS = 800;
const WIDER_SEARCH_RADIUS_METERS = 1500;
const DEFAULT_MAP_VIEW = { center: { lat: 39.5, lng: -98.35 }, zoom: 4 }; // whole US until we know where you are

const elements = {
  stopCount: document.getElementById("stop-count"),
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
  nearbyCafes: [],      // cached search results for this start, so "New route" doesn't search again
  orderedStops: [],
  legs: [],             // walking distance/time for each leg of the current walk
};
let googleLibraries;    // { map, Polyline, LatLngBounds, AdvancedMarkerElement, PinElement }
let drawnMarkers = [];  // removed before drawing a new walk
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
    const { Map, Polyline, LatLngBounds } = await google.maps.importLibrary("maps");
    const { AdvancedMarkerElement, PinElement } = await google.maps.importLibrary("marker");
    const map = new Map(document.getElementById("map"), {
      ...DEFAULT_MAP_VIEW,
      mapId: "DEMO_MAP_ID", // advanced markers need a map ID; Google provides this one for testing
      clickableIcons: false,
    });
    googleLibraries = { map, Polyline, LatLngBounds, AdvancedMarkerElement, PinElement };
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
  showStatus("Looking for cafés nearby…");
  try {
    walk.nearbyCafes = await searchNearbyCafes(start, FIRST_SEARCH_RADIUS_METERS);
    if (walk.nearbyCafes.length < selectedStopCount()) {
      showStatus("Only a few cafés close by. Looking a bit farther…");
      walk.nearbyCafes = await searchNearbyCafes(start, WIDER_SEARCH_RADIUS_METERS);
    }
    if (walk.nearbyCafes.length === 0) {
      showStatus("No cafés found within 1.5 km. Try tapping the map somewhere busier.");
      isWaitingForMapTap = true;
      return;
    }
    await buildAndShowWalk();
  } catch (error) {
    console.error(error);
    // Show Google's own reason: on a phone there is no console to look in.
    showStatus(`Café search failed. Google said: ${error.message}`);
  } finally {
    setButtonsBusy(false);
  }
}

async function buildAndShowWalk() {
  const requestedStops = selectedStopCount();
  const stops = chooseRandomStops(walk.nearbyCafes, requestedStops);
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
  elements.newRouteButton.disabled = walk.nearbyCafes.length <= requestedStops; // nothing new to pick from
  elements.walkSection.hidden = false;
  showStatus(walk.orderedStops.length < requestedStops
    ? `Only found ${walk.orderedStops.length} café${walk.orderedStops.length === 1 ? "" : "s"} nearby, so your walk is shorter.`
    : "");
}

function selectedStopCount() {
  return Number(elements.stopCount.value);
}

function setButtonsBusy(isBusy) {
  elements.startWalkButton.disabled = isBusy;
  elements.newRouteButton.disabled = isBusy;
}

// ---------- Map drawing ----------

function drawWalkOnMap(path, usedRealStreets) {
  const { map, Polyline, LatLngBounds, AdvancedMarkerElement, PinElement } = googleLibraries;
  drawnMarkers.forEach((marker) => (marker.map = null));
  drawnRouteLine?.setMap(null);
  drawnMarkers = [];

  const startPin = new PinElement({ glyph: "★", background: "#2b211b", borderColor: "#2b211b", glyphColor: "#fff" });
  drawnMarkers.push(new AdvancedMarkerElement({ map, position: walk.start, content: startPin.element, title: "Start" }));

  walk.orderedStops.forEach((stop, index) => {
    const pin = new PinElement({ glyph: String(index + 1), background: "#6f4e37", borderColor: "#4b3324", glyphColor: "#fff" });
    drawnMarkers.push(new AdvancedMarkerElement({ map, position: stop.location, content: pin.element, title: stop.name }));
  });

  // A dashed line means "not a real street route". Google draws dashes as repeated line symbols.
  const lineStyle = usedRealStreets
    ? { strokeColor: "#6f4e37", strokeOpacity: 0.9, strokeWeight: 5 }
    : {
        strokeOpacity: 0,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 0.9, strokeColor: "#6f4e37", scale: 3 }, offset: "0", repeat: "14px" }],
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
      item.append(createElement("span", "stop-number", String(index + 1)));
      item.append(createElement("span", "stop-name", stop.name)); // textContent, never innerHTML: names come from the internet

      const fromWhere = index === 0 ? "from start" : `from stop ${index}`;
      const ratingText = stop.rating ? ` · ${stop.rating.toFixed(1)}★ (${stop.ratingCount ?? 0})` : "";
      item.append(createElement("span", "stop-details",
        `${formatDistance(legs[index].distanceMeters)}, ~${formatWalkingTime(legs[index].durationSeconds)} ${fromWhere}${ratingText}`));

      const actions = createElement("div", "stop-actions");
      const directionsLink = createElement("a", "", "Directions");
      directionsLink.href = buildWalkingDirectionsUrl(stop);
      directionsLink.target = "_blank";
      directionsLink.rel = "noopener";
      const checkInButton = createElement("button", "", "I'm here");
      checkInButton.type = "button";
      checkInButton.addEventListener("click", () => openCheckIn(stop));
      actions.append(directionsLink, checkInButton);

      const pastVisits = coffeeLog.entriesForPlace(stop.placeId);
      if (pastVisits.length > 0) {
        actions.append(createElement("span", "logged-badge", `Logged ${pastVisits.length}× · last ${pastVisits[0].rating}★`));
      }
      item.append(actions);
      return item;
    }),
  );

  const returnLeg = legs[legs.length - 1];
  const returnItem = createElement("li", "fine-print",
    `Back to start: ${formatDistance(returnLeg.distanceMeters)}, ~${formatWalkingTime(returnLeg.durationSeconds)}`);
  elements.stopList.append(returnItem);
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
      header.append(createElement("strong", "", `${entry.cafeName} · ${"★".repeat(entry.rating)}`));
      const removeButton = createElement("button", "remove-entry-button", "Remove");
      removeButton.type = "button";
      removeButton.addEventListener("click", () => {
        coffeeLog.removeEntry(entry.entryId);
        renderCoffeeLog();
        if (walk.orderedStops.length) renderStopList();
      });
      header.append(removeButton);
      item.append(header);
      item.append(createElement("p", "fine-print", new Date(entry.visitedAt).toLocaleDateString()));
      if (entry.note) item.append(createElement("p", "", entry.note));
      return item;
    }),
  );
}

startApp();
