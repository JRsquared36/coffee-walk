# Coffee Walk

A walking loop through cafés near you. Tap **Start a coffee walk**: the app finds you, picks 3–5 nearby cafés, puts them in the shortest loop order, and draws a walking route that starts and ends where you are. At each stop, tap **I'm here** to rate it and leave a note — you can only check in when you're actually at the café. Your log is saved in your browser.

Live: https://jrsquared36.github.io/coffee-walk/

## Setup

1. Put your Google Maps Platform key in `js/config.js`.
2. In Google Cloud Console, restrict the key to these websites: `https://jrsquared36.github.io/*` and `http://localhost:8000/*`. The key is visible to anyone who opens the site, so this restriction is what stops others from using it.
3. The key needs: Maps JavaScript API, Places API (New), and Routes API. Without the Routes API the walk is drawn as straight lines with estimated times.

## Run locally

```
python -m http.server 8000
```
Then open http://localhost:8000. (Location only works on `localhost` or HTTPS, so double-clicking `index.html` won't work.)

## Tests

```
npm test
```
Uses Node's built-in test runner (Node 20+). No packages to install.

## Files

| File | What it does |
|---|---|
| `index.html` | Page structure |
| `css/style.css` | Layout (map + panel; stacks on phones) |
| `js/app.js` | Browser glue: buttons, location, map drawing, check-in dialog |
| `js/google-maps.js` | Everything that talks to Google (load map, café search, walking route) |
| `js/route-planning.js` | Pure logic: distances, picking stops, shortest loop order, check-in distance |
| `js/coffee-log.js` | Your check-ins, saved in localStorage |
| `js/config.js` | Your API key |
| `tests/` | Unit tests for the pure logic and the log |
