# Coffee Walk

A walking loop through coffee shops that fit your mood. Choose what you're after (good coffee, a coffee flight, cozy and quiet…), how long you want to walk and how many stops, then tap **Start a coffee walk**: the app finds you, picks the coffee shops that fit best, puts them in the shortest loop order, and draws a walking route that starts and ends where you are. Each stop shows which of your choices it matched. At each stop, tap **I'm here** to rate it and leave a note — you can only check in when you're actually at the café. Your log is saved in your browser.

Live: https://jrsquared36.github.io/coffee-walk/

## Setup

1. **Live site:** the key lives in the repository secret `GOOGLE_MAP_KEY` (Settings → Secrets and variables → Actions). On every push to `main`, `.github/workflows/deploy.yml` runs the tests, writes `js/config.js` from that secret, and deploys. Pages must be set to **Settings → Pages → Source: GitHub Actions**.
2. **Local preview:** copy `js/config.example.js` to `js/config.js` and paste your key. `js/config.js` is in `.gitignore`, so it won't be committed.
3. In Google Cloud Console, restrict the key to these websites: `https://jrsquared36.github.io/*` and `http://localhost:8000/*`. The key is still visible to anyone who opens the live site (the browser needs it); the secret only keeps it out of git history. The restriction is what stops others from using it.
4. The key needs: Maps JavaScript API, Places API (New), and Routes API. Without the Routes API the walk is drawn as straight lines with estimated times.

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
| `css/tokens.css` | Design tokens: colours, type, spacing, corners, shadows. Mirrors the Figma variables |
| `css/style.css` | Layout (bottom sheet on phones, sidebar on wide screens) and components, built only from the tokens |
| `js/app.js` | Browser glue: buttons, location, map drawing, the panel's views (setup, walk, café detail), check-in |
| `js/bottom-sheet.js` | The phone bottom sheet: dragging and tapping the handle |
| `js/sheet-snapping.js` | Pure maths for the sheet's three resting heights |
| `js/google-maps.js` | Everything that talks to Google (load map, café search, walking route) |
| `js/walk-preferences.js` | Pure logic: the preference list, matching cafés to preferences, ranking the possible walks |
| `js/route-planning.js` | Pure logic: distances, shortest loop order, check-in distance |
| `js/coffee-log.js` | Your check-ins, saved in localStorage |
| `js/config.example.js` | Template for `js/config.js` (your key; not committed) |
| `.github/workflows/deploy.yml` | Tests, injects the key secret, deploys to Pages |
| `tests/` | Unit tests for the pure logic and the log |
