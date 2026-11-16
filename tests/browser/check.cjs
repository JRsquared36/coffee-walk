// Browser checks: drives the real page in headless Chromium against a FAKE Google Maps.
//
// Run:  npm run test:browser      (needs Playwright: `npm install --no-save playwright` once,
//                                  or a global install; see README "Tests")
//
// What this proves: our code behaves as intended given the Google responses we expect.
// What it does NOT prove: that real Google behaves like the fake below. When Google's API and this
// fake disagree, the checks pass and the live site breaks (it happened: LatLngBounds lives in
// importLibrary("core"), not "maps"). Check the fake against Google's docs whenever you extend it.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function loadPlaywright() {
  for (const name of ["playwright", "/opt/node22/lib/node_modules/playwright"]) {
    try { return require(name); } catch { /* try the next location */ }
  }
  console.error("Playwright isn't installed. Run: npm install --no-save playwright && npx playwright install chromium");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SCRATCH = path.join(__dirname, "screenshots"); // gitignored
fs.mkdirSync(SCRATCH, { recursive: true });

// A tiny static file server for the repo, so the checks don't depend on anything else running.
const CONTENT_TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };
const server = http.createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  const filePath = path.join(REPO_ROOT, urlPath === "/" ? "index.html" : urlPath);
  if (!filePath.startsWith(REPO_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404).end("not found");
    return;
  }
  response.writeHead(200, { "Content-Type": CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream" });
  fs.createReadStream(filePath).pipe(response);
});
let SITE_URL;
const START = { latitude: 40.7128, longitude: -74.006 };
const WEEK = ["Monday: 7:00 AM – 5:00 PM","Tuesday: 7:00 AM – 5:00 PM","Wednesday: 7:00 AM – 5:00 PM","Thursday: 7:00 AM – 5:00 PM","Friday: 7:00 AM – 5:00 PM","Saturday: 8:00 AM – 4:00 PM","Sunday: Closed"];
// Opening periods as real Google returns them: days from Sunday = 0, in the café's own time zone.
// A period with no close means "always open". The closed one is a single minute three days from now.
const CAFE_UTC_OFFSET_MINUTES = -300; // New York in winter
const cafeDayNow = new Date(Date.now() + CAFE_UTC_OFFSET_MINUTES * 60_000).getUTCDay();
const ALWAYS_OPEN_PERIOD = { open: { day: 0, hour: 0, minute: 0 } };
const CLOSED_NOW_PERIOD = { open: { day: (cafeDayNow + 3) % 7, hour: 3, minute: 0 }, close: { day: (cafeDayNow + 3) % 7, hour: 3, minute: 1 } };
const CAFES = Array.from({ length: 9 }, (_, i) => ({
  id: `place-${i}`,
  displayName: i === 2 ? `<img src=x onerror="window.__xss=1">Evil Café` : i === 7 ? "Starbucks" : i === 8 ? "Hudson Bagels" : `Café ${i}`,
  primaryType: i === 8 ? "cafe" : "coffee_shop",
  primaryTypeDisplayName: i === 8 ? "Café" : "Coffee shop",
  lat: START.latitude + 0.002 * Math.cos(i),
  lng: START.longitude + 0.002 * Math.sin(i),
  rating: 4 + i / 10,
  userRatingCount: 100 + i,
  businessStatus: i === 6 ? "CLOSED_PERMANENTLY" : "OPERATIONAL",
  formattedAddress: `${100 + i} Main St, New York, NY`,
  priceLevel: "MODERATE",
  // Café 3 has no hours at all; Café 5 is closed right now; the rest never close.
  regularOpeningHours: i === 3 ? null : { weekdayDescriptions: WEEK, periods: i === 5 ? [CLOSED_NOW_PERIOD] : [ALWAYS_OPEN_PERIOD] },
  utcOffsetMinutes: CAFE_UTC_OFFSET_MINUTES,
  websiteURI: `https://cafe${i}.example`,
  googleMapsURI: `https://maps.google.com/?cid=${i}`,
}));

// Shapes follow Google's docs as far as I know them: LatLngBounds in "core"; Map, Polyline in "maps";
// AdvancedMarkerElement in "marker" with a .content element; Place.searchNearby returns { places }.
const fakeGoogleScript = `
  window.__markers = new Set(); window.__lines = 0; window.__panTo = [];
  const places = ${JSON.stringify(CAFES)}.map(p => ({ ...p, location: { lat: () => p.lat, lng: () => p.lng } })); // no isOpen(): that exists only in Google's beta channel
  const libs = {
    maps: {
      // Like the real Map, this sets inline position/overflow on its element, which overrides our CSS.
      // (The live site lost its map on phones because the fake didn't do this.)
      Map: class { constructor(el) { el.textContent = "FAKE MAP"; el.style.position = "relative"; el.style.overflow = "hidden"; window.__map = this; }
                   addListener(_e, fn) { window.__mapClick = fn; } fitBounds() {} panTo(p) { window.__panTo.push(p); } },
      Polyline: class { constructor(o) { window.__lines++; window.__lastLine = o; } setMap(m) { if (!m) window.__lines--; } },
    },
    core: { LatLngBounds: class { extend() {} } },
    marker: {
      AdvancedMarkerElement: class { constructor(o) { this._map = o.map; this.title = o.title; this.content = o.content; this.clickHandlers = []; window.__markers.add(this); }
        addListener(name, fn) { if (name === "click") this.clickHandlers.push(fn); }
        set map(v) { this._map = v; if (!v) window.__markers.delete(this); } get map() { return this._map; } },
    },
    places: { Place: { searchByText: async (req) => {
      window.__textRequests = (window.__textRequests || []).concat([req]);
      if ((window.__failTextQueries || []).some(q => req.textQuery.includes(q))) throw new Error("PERMISSION_DENIED: text search not enabled");
      const farPlace = { ...places[0], id: "far", displayName: "Far Away Roasters", location: { lat: () => places[0].lat + 0.05, lng: () => places[0].lng } };
      // "cozy" also returns a bagel shop and a café 5 km away: both must be filtered out by the app.
      const picked = req.textQuery.includes("cozy") ? [places[0], places[1], places[8], farPlace] : req.textQuery.includes("work from") ? [places[4]] : [];
      return { places: picked };
    }, searchNearby: async (req) => {
      window.__searchRequests = (window.__searchRequests || []).concat([req]);
      if (window.__failDetailedSearch && req.fields.includes("rating")) throw new Error("PERMISSION_DENIED: field not allowed");
      return { places: places.map(p => Object.fromEntries(Object.entries(p).filter(([k]) => k === "id" || k === "location" || req.fields.includes(k)))) };
    } } },
  };
  window.google = { maps: { importLibrary: async (name) => libs[name] } };
  setTimeout(() => window.onGoogleMapsReady(), 0);
`;

async function openPage(browser, { routesFail = false, viewport = { width: 1280, height: 800 }, geolocationAllowed = true, init } = {}) {
  const context = await browser.newContext({ viewport, geolocation: START, permissions: geolocationAllowed ? ["geolocation"] : [] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (init) await page.addInitScript(init);
  await page.route("**/js/config.js", (r) => r.fulfill({ contentType: "text/javascript", body: 'export const GOOGLE_MAPS_API_KEY = "FAKE_KEY";' }));
  await page.route("https://fonts.googleapis.com/**", (r) => r.abort());
  await page.route("https://maps.googleapis.com/**", (r) => r.fulfill({ contentType: "text/javascript", body: fakeGoogleScript }));
  await page.route("https://routes.googleapis.com/**", async (r) => {
    if (routesFail) return r.fulfill({ status: 403, body: "PERMISSION_DENIED" });
    const body = JSON.parse(r.request().postData());
    const points = [body.origin, ...body.intermediates, body.destination].map((w) => [w.location.latLng.longitude, w.location.latLng.latitude]);
    // Each leg to a stop takes 4.5 minutes and the walk home 7.5: 3 stops = 21 min, 4 = 25.5, 6 = 34.5.
    const legs = body.intermediates.map(() => ({ distanceMeters: 300, duration: "270s" })).concat([{ distanceMeters: 500, duration: "450s" }]);
    r.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ routes: [{ distanceMeters: 1700, duration: "1360s", legs, polyline: { geoJsonLinestring: { coordinates: points } } }] }) });
  });
  await page.goto(SITE_URL);
  return { page, context, errors };
}

const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
const view = (page) => page.getAttribute("#panel", "data-view");
const startWalk = async (page) => { await page.click("#start-walk-button"); await page.waitForSelector('#panel[data-view="walk"]'); };
const selectedPins = (page) => page.evaluate(() => [...window.__markers].filter(m => m.content.classList.contains("is-selected")).map(m => m.content.textContent));
const clickPin = (page, number) => page.evaluate((n) => [...window.__markers].find(m => m.content.textContent === String(n)).clickHandlers.forEach(fn => fn()), number);
const mapClick = (page) => page.evaluate(([lat, lng]) => window.__mapClick({ latLng: { lat: () => lat, lng: () => lng } }), [START.latitude, START.longitude]);

(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); // port 0 = any free port
  SITE_URL = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();

  // ---- No key ----
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("https://fonts.googleapis.com/**", (r) => r.abort());
    // Always the placeholder, so a developer's real key in js/config.js is never used by these checks.
    await page.route("**/js/config.js", (r) => r.fulfill({ contentType: "text/javascript", body: 'export const GOOGLE_MAPS_API_KEY = "PASTE_YOUR_KEY_HERE";' }));
    await page.goto(SITE_URL);
    await page.waitForTimeout(300);
    check("no key → helpful message", (await page.textContent("#status-message")).includes("config.example.js"));
    check("no key → start button disabled", await page.isDisabled("#start-walk-button"));
    await context.close();
  }

  // ---- Desktop: views, detail, check-in ----
  {
    const { page, context, errors } = await openPage(browser);
    check("starts on the setup view", (await view(page)) === "setup");
    check("walk list hidden in setup view", !(await page.isVisible("#walk-section")));
    await startWalk(page);
    check("setup hidden once a walk exists", !(await page.isVisible("#start-walk-button")));
    const names = await page.$$eval(".stop-name", (els) => els.map((e) => e.textContent));
    check("4 stop cards", names.length === 4, names.join(" | "));
    check("permanently closed café excluded", !names.includes("Café 6"));
    check("totals shown", (await page.textContent("#walk-totals")).includes("4 stops"));
    check("5 markers, 1 line", (await page.evaluate(() => window.__markers.size)) === 5 && (await page.evaluate(() => window.__lines)) === 1);
    check("cards are buttons with no nested buttons or links", await page.evaluate(() => [...document.querySelectorAll(".stop")].every(c => c.tagName === "BUTTON" && !c.querySelector("button, a"))));
    const cardOfCafe = (name) => page.evaluate((n) => [...document.querySelectorAll(".stop")].find(c => c.querySelector(".stop-name").textContent === n)?.textContent ?? "(not a stop)", name);
    const cardText = await page.evaluate(() => [...document.querySelectorAll(".stop")].find(c => !/Café [35]/.test(c.textContent)).textContent);
    check("card shows rating, price, badges, hours, leg", ["★", "$$", "Coffee shop", "Open now", "Today", "from"].every(t => cardText.includes(t)), cardText);
    const closedCard = await cardOfCafe("Café 5");
    check("a café outside its opening hours shows Closed now", closedCard.includes("Closed now") && !closedCard.includes("Open now"), closedCard);
    const noHoursCard = await cardOfCafe("Café 3");
    check("a café with no hours shows neither Open nor Closed", !noHoursCard.includes("Open now") && !noHoursCard.includes("Closed now"), noHoursCard);

    // Card → detail
    await page.click(".stop >> nth=1");
    const secondName = names[1];
    check("tapping a card opens the detail view", (await view(page)) === "detail");
    const detail = await page.textContent("#cafe-detail");
    check("detail shows stop position and leg", detail.includes("Stop 2 of 4") && detail.includes("from stop 1"), detail.slice(0, 80));
    check("detail shows the café name as heading", (await page.textContent("#cafe-detail h2")) === secondName);
    check("detail has I'm here, Directions, Website", ["I'm here", "Directions", "Website"].every(t => detail.includes(t)));
    check("directions link is walking", (await page.getAttribute("#cafe-detail .detail-actions a", "href")).includes("travelmode=walking"));
    check("external links open safely", await page.evaluate(() => [...document.querySelectorAll("#cafe-detail a")].every(a => a.target === "_blank" && a.rel === "noopener")));
    check("selected pin is enlarged", JSON.stringify(await selectedPins(page)) === '["2"]');
    check("map pans to the café", await page.evaluate(() => window.__panTo.length === 1 && typeof window.__panTo[0].lat === "number"));
    check("coffee log hidden in detail view", !(await page.isVisible(".log-section")));

    // Close → back to walk
    await page.click(".close-button");
    check("✕ returns to the walk", (await view(page)) === "walk" && (await selectedPins(page)).length === 0);
    // Pin → detail; empty map tap closes
    await clickPin(page, 3);
    check("tapping a pin opens that café", (await view(page)) === "detail" && (await page.textContent("#cafe-detail")).includes("Stop 3 of 4"));
    await mapClick(page);
    check("tapping empty map closes the café", (await view(page)) === "walk" && (await selectedPins(page)).length === 0);

    // New route
    await page.click("#new-route-button");
    await page.waitForTimeout(250);
    check("new route: 5 markers, 1 line, 1 search", (await page.evaluate(() => window.__markers.size === 5 && window.__lines === 1 && window.__searchRequests.length === 1)));
    check("no preference chosen → no text searches", await page.evaluate(() => (window.__textRequests || []).length === 0));
    check("30 min walk searches within 810 m", (await page.evaluate(() => window.__searchRequests[0].locationRestriction.radius)) === 810);
    const seen = new Set();
    for (let round = 0; round < 12; round++) {
      (await page.$$eval(".stop-name", (els) => els.map((e) => e.textContent))).forEach((n) => seen.add(n));
      await page.click("#new-route-button"); await page.waitForTimeout(50);
    }
    check("chain and bagel shop never become stops", !seen.has("Starbucks") && !seen.has("Hudson Bagels"));

    // Check-in from the detail view
    const firstName = await page.textContent(".stop-name");
    await page.click(".stop");
    await page.click("#cafe-detail .button--primary");
    check("I'm here opens the check-in", await page.evaluate(() => document.querySelector("#check-in-dialog").open));
    await page.check('input[name="rating"][value="4"]');
    check("4 stars filled", (await page.evaluate(() => [...document.querySelectorAll(".star-glyph")].filter(g => getComputedStyle(g).color === "rgb(214, 154, 92)").length)) === 4);
    await page.fill("#check-in-note", "Nice flat white");
    await context.setGeolocation({ latitude: START.latitude + 0.01, longitude: START.longitude });
    await page.click("#save-check-in-button");
    await page.waitForFunction(() => document.querySelector("#check-in-error").textContent.length > 0);
    check("far check-in refused, dialog stays open", (await page.textContent("#check-in-error")).includes("away") && await page.evaluate(() => document.querySelector("#check-in-dialog").open));
    const cafe = CAFES.find((c) => c.displayName === firstName) ?? CAFES[2];
    await context.setGeolocation({ latitude: cafe.lat, longitude: cafe.lng });
    await page.click("#save-check-in-button");
    await page.waitForFunction(() => !document.querySelector("#check-in-dialog").open);
    check("detail shows Logged badge after check-in", (await page.textContent("#cafe-detail")).includes("Logged 1×"));
    await page.click(".close-button");
    check("card shows Logged badge", (await page.textContent(".stop")).includes("Logged 1×"));
    check("log shows the entry", (await page.textContent("#log-list")).includes("Nice flat white"));
    await page.screenshot({ path: `${SCRATCH}/sheet-desktop.png` });

    // Start over
    await page.click("#start-over-button");
    check("start over → setup view, map cleared", (await view(page)) === "setup" && await page.evaluate(() => window.__markers.size === 0 && window.__lines === 0));

    // Reload keeps the log; remove works
    await page.reload(); await page.waitForTimeout(400);
    check("log survives reload", (await page.textContent("#log-list")).includes("Nice flat white"));
    await page.click(".log-entry button");
    check("remove entry", !(await page.textContent("#log-list")).includes("Nice flat white"));

    // HTML in a café name stays text, in cards and in the detail view
    await page.check('input[name="stop-range"][value="5-6"]');
    await startWalk(page);
    const evilIndex = (await page.$$eval(".stop-name", (els) => els.map((e) => e.textContent))).findIndex((n) => n.includes("Evil"));
    if (evilIndex >= 0) await page.click(`.stop >> nth=${evilIndex}`);
    check("HTML in café name not executed (card and detail)", evilIndex >= 0 && !(await page.evaluate(() => window.__xss)) && (await page.$$("#cafe-detail img")).length === 0);
    check("no page errors (desktop)", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---- Phone: bottom sheet ----
  {
    const { page, context, errors } = await openPage(browser, { viewport: { width: 390, height: 844 }, routesFail: true });
    const sheetHeight = () => page.evaluate(() => Math.round(document.querySelector("#panel").getBoundingClientRect().height));
    const mapRect = () => page.evaluate(() => { const r = document.querySelector("#map").getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width) }; });
    const settle = () => page.waitForTimeout(320);
    await settle();
    check("setup opens at full height so every choice is visible", (await sheetHeight()) === 788, String(await sheetHeight()));
    let map = await mapRect();
    check("map fills the space above the sheet", map.top === 0 && map.width === 390 && map.bottom === 844 - 788 + 24, JSON.stringify(map));
    check("all three preference groups visible without scrolling", await page.evaluate(() => [...document.querySelectorAll(".view--setup .preference")].every(e => { const r = e.getBoundingClientRect(); return r.top > 0 && r.bottom < 844; })));
    check("sheet is pinned to the bottom", await page.evaluate(() => Math.round(document.querySelector("#panel").getBoundingClientRect().bottom) === 844));
    check("page itself doesn't scroll", await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.documentElement.scrollWidth <= window.innerWidth));
    check("start button visible without scrolling", await page.evaluate(() => { const r = document.querySelector("#start-walk-button").getBoundingClientRect(); return r.top > 0 && r.bottom < 844; }));
    await page.screenshot({ path: `${SCRATCH}/sheet-phone-1-start.png` });

    // Record how tall the map is each time the app zooms to the route.
    await page.evaluate(() => { window.__mapHeightAtZoom = []; window.__map.fitBounds = (_bounds, margin) => window.__mapHeightAtZoom.push({ height: Math.round(document.querySelector("#map").getBoundingClientRect().height), margin }); });
    await startWalk(page); await settle();
    check("sheet drops to half once the route is drawn", (await sheetHeight()) === 464, String(await sheetHeight()));
    const zooms = await page.evaluate(() => window.__mapHeightAtZoom);
    check("map zooms to the route after the sheet has dropped, not while it covers the map", zooms.length === 1 && zooms[0].height >= 380 && zooms[0].margin === 48, JSON.stringify(zooms));
    check("straight-line fallback noted and dashed", (await page.textContent("#route-source-note")).includes("straight lines") && await page.evaluate(() => window.__lastLine.strokeOpacity === 0 && !!window.__lastLine.icons));
    check("first stop card visible without scrolling", await page.evaluate(() => { const r = document.querySelector(".stop").getBoundingClientRect(); return r.top > 0 && r.top < 844 - 60; }));
    await page.screenshot({ path: `${SCRATCH}/sheet-phone-2-walk.png` });

    // Tap the handle: half → full → half
    await page.click("#sheet-handle"); await settle();
    check("tap handle → full height", (await sheetHeight()) === 788, String(await sheetHeight()));
    await page.click("#sheet-handle"); await settle();
    check("tap handle again → half", (await sheetHeight()) === 464);
    // Drag the handle down → peek
    const handle = await page.evaluate(() => { const r = document.querySelector("#sheet-handle").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    await page.mouse.move(handle.x, handle.y); await page.mouse.down();
    await page.mouse.move(handle.x, handle.y + 150, { steps: 5 });
    check("sheet follows the finger mid-drag", Math.abs((await sheetHeight()) - 314) <= 2, String(await sheetHeight()));
    await page.mouse.move(handle.x, handle.y + 300, { steps: 5 }); await page.mouse.up(); await settle();
    check("drag down settles at peek", (await sheetHeight()) === 132, String(await sheetHeight()));
    map = await mapRect();
    check("map grows when the sheet shrinks", map.bottom === 844 - 132 + 24, JSON.stringify(map));
    await page.screenshot({ path: `${SCRATCH}/sheet-phone-3-peek.png` });
    // Keyboard
    await page.focus("#sheet-handle"); await page.keyboard.press("Enter"); await settle();
    check("Enter on the handle resizes (keyboard)", (await sheetHeight()) === 464);
    // At peek, tapping a pin lifts the sheet so the café is readable
    await page.mouse.move(handle.x, handle.y); await page.mouse.down(); await page.mouse.move(handle.x, handle.y + 300, { steps: 4 }); await page.mouse.up(); await settle();
    await clickPin(page, 1); await settle();
    check("pin tap at peek opens the café at half height", (await view(page)) === "detail" && (await sheetHeight()) === 464);
    check("café name and I'm here visible without scrolling", await page.evaluate(() => ["#cafe-detail h2", "#cafe-detail .button--primary"].every(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return r.top > 0 && r.bottom <= 844; })));
    await page.screenshot({ path: `${SCRATCH}/sheet-phone-4-detail.png` });
    // Check-in slides up from the bottom
    await page.click("#cafe-detail .button--primary"); await settle();
    const dialog = await page.evaluate(() => { const r = document.querySelector("#check-in-dialog").getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width), bottom: Math.round(r.bottom) }; });
    check("check-in is a full-width bottom sheet", dialog.left === 0 && dialog.width === 390 && dialog.bottom === 844, JSON.stringify(dialog));
    await page.screenshot({ path: `${SCRATCH}/sheet-phone-5-checkin.png` });
    await page.click("#cancel-check-in-button");
    const tapTargets = await page.evaluate(() => [...document.querySelectorAll("#panel button, #panel a.button, #panel .chip span")].filter(e => e.offsetParent !== null && e.id !== "sheet-handle").map(e => ({ t: e.textContent.trim().slice(0, 16), h: Math.round(e.getBoundingClientRect().height) })).filter(e => e.h < 44));
    check("every visible button is at least 44px tall", tapTargets.length === 0, JSON.stringify(tapTargets));
    check("no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    check("no page errors (phone)", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---- Preferences ----
  {
    const { page, context, errors } = await openPage(browser);
    const chips = await page.$$eval("#aspect-chips .chip span", (els) => els.map((e) => e.textContent));
    check("6 preference chips from the ASPECTS list", chips.length === 6 && !chips.includes("Good conversation") && !chips.includes("Coffee flight") && chips.includes("Work-friendly") && chips.includes("Cozy & quiet"), chips.join(", "));
    check("walk-length and stop-range chips, with defaults", await page.evaluate(() => document.querySelectorAll('input[name="walk-minutes"]').length === 4 && document.querySelectorAll('input[name="stop-range"]').length === 3 && document.querySelector('input[name="walk-minutes"]:checked').value === "30" && document.querySelector('input[name="stop-range"]:checked').value === "3-4"));
    const pick = (label) => page.click(`#aspect-chips .chip:has-text("${label}")`);
    await pick("Cozy & quiet"); await pick("Work-friendly");
    check("chosen preference chips look selected", (await page.evaluate(() => [...document.querySelectorAll('input[name="aspect"]:checked + span')].filter(e => getComputedStyle(e).backgroundColor === "rgb(111, 78, 55)").length)) === 2);
    // At most two preferences.
    const aspectState = () => page.evaluate(() => { const boxes = [...document.querySelectorAll('input[name="aspect"]')]; return { checked: boxes.filter(b => b.checked).length, disabled: boxes.filter(b => b.disabled).length, total: boxes.length }; });
    let aspects = await aspectState();
    check("with two chosen, every other chip is switched off", aspects.checked === 2 && aspects.disabled === aspects.total - 2, JSON.stringify(aspects));
    await page.click('#aspect-chips .chip:has-text("Lively & buzzy")', { force: true }).catch(() => {});
    check("a third preference can't be chosen", (await aspectState()).checked === 2);
    check("switched-off chips look faded", (await page.evaluate(() => getComputedStyle(document.querySelector('input[name="aspect"]:disabled + span')).opacity)) === "0.4");
    await pick("Work-friendly");
    aspects = await aspectState();
    check("unticking one switches the others back on", aspects.checked === 1 && aspects.disabled === 0, JSON.stringify(aspects));
    await pick("Work-friendly");
    check("the hint says how many can be chosen", (await page.textContent("#aspects-label")).includes("up to 2"));
    await startWalk(page);
    const textRequests = await page.evaluate(() => window.__textRequests.map(r => ({ q: r.textQuery, radius: r.locationBias.radius, max: r.maxResultCount })));
    check("one text search per chosen preference, near the start", textRequests.length === 2 && textRequests.every(r => r.radius === 810 && r.max === 20), JSON.stringify(textRequests));
    const names = await page.$$eval(".stop-name", (els) => els.map((e) => e.textContent));
    check("matching cafés are chosen first", ["Café 0", "Café 1", "Café 4"].every(n => names.includes(n)) && names.length === 4, names.join(" | "));
    check("bagel shop and far-away café from text search are not stops", !names.includes("Hudson Bagels") && !names.includes("Far Away Roasters"));
    const cardOf = (name) => page.evaluate((n) => [...document.querySelectorAll(".stop")].find(c => c.querySelector(".stop-name").textContent === n).textContent, name);
    check("card shows what it matched", (await cardOf("Café 0")).includes("Cozy & quiet") && !(await cardOf("Café 0")).includes("Work-friendly") && (await cardOf("Café 4")).includes("Work-friendly"));
    await page.click(`.stop >> nth=${names.indexOf("Café 4")}`);
    const matches = await page.textContent(".detail-matches");
    check("detail explains matches and misses", matches.includes("Matches what you asked for") && matches.includes("Work-friendly") && matches.includes("No sign of") && matches.includes("Cozy & quiet") && matches.includes("treat it as a hint"), matches);
    await page.click(".close-button");
    // New route steps through ranked options without searching again.
    const before = names.slice().sort().join("|");
    await page.click("#new-route-button"); await page.waitForTimeout(250);
    const after = (await page.$$eval(".stop-name", (els) => els.map((e) => e.textContent))).sort().join("|");
    check("new route shows a different group of stops", before !== after, after);
    check("new route does not search Google again", await page.evaluate(() => window.__searchRequests.length === 1 && window.__textRequests.length === 2));
    for (let i = 0; i < 4; i++) { await page.click("#new-route-button"); await page.waitForTimeout(120); }
    check("after the last option, back to the best one", (await page.$$eval(".stop-name", (els) => els.map((e) => e.textContent))).sort().join("|") === before);
    // Change preferences keeps the choices.
    await page.click("#start-over-button");
    check("change preferences → setup view with choices kept", (await view(page)) === "setup" && (await page.$$('input[name="aspect"]:checked')).length === 2);
    // Swap one choice for a preference the fake finds nothing for.
    await pick("Work-friendly"); await pick("Lively & buzzy");
    // 15 minutes: the fake route takes ~23 min for 4 stops, so the app must say it's over.
    await page.check('input[name="walk-minutes"][value="15"]');
    await startWalk(page);
    check("15 min walk searches within 405 m", (await page.evaluate(() => window.__searchRequests.at(-1).locationRestriction.radius)) === 405);
    const status = await page.textContent("#status-message");
    check("says plainly when the walk is over the time limit", /over your 15 min/.test(status), status);
    check("status says which preference no stop matched", status.includes("No stop on this walk matched: Lively & buzzy"), status);
    check("no page errors (preferences)", errors.length === 0, errors.join("; "));
    await context.close();
  }
  // ---- One preference search refused: the walk still works ----
  {
    const { page, context, errors } = await openPage(browser, { init: () => { window.__failTextQueries = ["work from"]; } });
    await page.click('#aspect-chips .chip:has-text("Work-friendly")'); await page.click('#aspect-chips .chip:has-text("Cozy & quiet")');
    await startWalk(page);
    const status = await page.textContent("#status-message");
    check("failed preference search is named with Google's reason", status.includes('Couldn\'t check "Work-friendly"') && status.includes("PERMISSION_DENIED"), status);
    check("walk still built from the other preference", (await page.$$(".stop-name")).length >= 3 && (await page.textContent(".stop-list")).includes("Cozy & quiet") && errors.length === 0);
    await context.close();
  }
  // ---- Phone: setup view ----
  {
    const { page, context } = await openPage(browser, { viewport: { width: 390, height: 844 } });
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SCRATCH}/prefs-phone-setup.png` });
    // Drag down to half: the Start button must stay pinned at the bottom of the shorter sheet.
    await page.click("#sheet-handle"); await page.waitForTimeout(350);
    check("phone: Start button pinned in view at half height", await page.evaluate(() => { const r = document.querySelector("#start-walk-button").getBoundingClientRect(); return r.top > 400 && r.bottom <= 844; }));
    await page.screenshot({ path: `${SCRATCH}/prefs-phone-setup-half.png` });
    await page.evaluate(() => { document.querySelector(".panel-content").scrollTop = 200; });
    check("phone: Start button stays pinned while choices scroll", await page.evaluate(() => { const r = document.querySelector("#start-walk-button").getBoundingClientRect(); return r.top > 400 && r.bottom <= 844; }));
    const small = await page.evaluate(() => [...document.querySelectorAll(".view--setup .chip span")].map(e => Math.round(e.getBoundingClientRect().height)).filter(h => h < 44));
    check("phone: every preference chip is at least 44px tall", small.length === 0, JSON.stringify(small));
    check("phone: no horizontal overflow with chips", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.querySelector(".panel-content").scrollWidth <= document.querySelector(".panel-content").clientWidth));
    await page.click('#aspect-chips .chip:has-text("Cozy & quiet")');
    await startWalk(page); await page.waitForTimeout(300);
    await page.screenshot({ path: `${SCRATCH}/prefs-phone-walk.png` });
    await page.click(".stop"); await page.waitForTimeout(300);
    await page.click("#sheet-handle"); await page.waitForTimeout(350);
    await page.screenshot({ path: `${SCRATCH}/prefs-phone-detail.png` });
    await context.close();
  }

  // ---- A walk a few minutes over the chosen time is accepted without a warning ----
  {
    const { page, context, errors } = await openPage(browser);
    await page.check('input[name="stop-range"][value="5-6"]'); // walk length stays at the default 30 min
    await startWalk(page);
    const stopCount = (await page.$$(".stop-name")).length;
    const totals = await page.textContent("#walk-totals");
    // The fake's 6-stop route takes 34.5 minutes: over 30, but within the 5-minute grace.
    check("30 min choice, 5–6 stops: the fake route for 6 stops takes ~35 min", stopCount === 6 && /35 min/.test(totals), `${stopCount} stops, ${totals}`);
    check("up to 5 minutes over: no over-time message", !/over your/.test(await page.textContent("#status-message")), await page.textContent("#status-message"));
    check("the setup caption mentions walks can run a few minutes over", (await page.evaluate(() => document.querySelector(".view--setup .caption").textContent)).includes("a few minutes over"));
    check("no page errors (time allowance)", errors.length === 0, errors.join("; "));
    await context.close();
  }

  // ---- Location denied → tap the map ----
  {
    const { page, context } = await openPage(browser, { geolocationAllowed: false, routesFail: true });
    await page.click("#start-walk-button");
    await page.waitForFunction(() => document.querySelector("#status-message").textContent.includes("Tap the map"), null, { timeout: 15000 });
    check("asking for a map tap uncovers the map", (await page.getAttribute("#panel", "data-snap")) === "half");
    await mapClick(page);
    await page.waitForSelector('#panel[data-view="walk"]');
    check("location denied → map tap starts the walk", (await page.$$(".stop-name")).length === 4);
    await context.close();
  }

  // ---- Missing config.js ----
  {
    const context = await browser.newContext(); const page = await context.newPage();
    await page.route("https://fonts.googleapis.com/**", (r) => r.abort());
    await page.route("**/js/config.js", (r) => r.fulfill({ status: 404, body: "" }));
    await page.goto(SITE_URL); await page.waitForTimeout(400);
    check("missing config.js → helpful message", (await page.textContent("#status-message")).includes("config.example.js"));
    await context.close();
  }

  // ---- Google refuses the detailed fields ----
  {
    const { page, context, errors } = await openPage(browser, { routesFail: true, init: () => { window.__failDetailedSearch = true; } });
    await startWalk(page);
    check("detailed fields refused → basic walk still works", (await page.$$(".stop-name")).length === 4 && errors.length === 0, errors.join("; "));
    await page.click(".stop");
    check("basic café detail says there are no hours", (await page.textContent("#cafe-detail")).includes("no hours"));
    await context.close();
  }

  await browser.close();
  server.close();
  console.log(results.join("\n"));
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => { console.log(results.join("\n")); console.log("CRASH " + error.message.split("\n")[0]); process.exit(1); });
