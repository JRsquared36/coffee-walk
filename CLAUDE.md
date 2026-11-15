# Coffee Walk

A web app that builds a walking tour through nearby cafés. You pick what you want from the cafés
(and soon: vibes, coffee flight, walking time, number of stops), it finds you, picks matching cafés,
orders them into a loop, and draws the walking route. You can check in at each stop to rate it.

Live: https://jrsquared36.github.io/coffee-walk/ · Owner: @JRsquared36

## Roadmap (build in this order, one PR each)
1. v1 (done): random cafés nearby, shortest loop, walking route, per-leg times, personal coffee log.
2. Café details (done): map pin popups and stop cards with rating, price, open now, hours.
3. Coffee-first selection (done): primary types, no chains, 4.0★ / 20-review floor.
4. Design system: tokens and components from Figma, then the mobile bottom-sheet layout.
5. Preferences: aspects (good coffee, coffee flight, unique space, outdoor seating, good conversation,
   cozy/quiet, lively/buzzy, work-friendly), max walking time, stop range (2–3, 3–4, 5–6). Matching uses
   one Google text search per aspect; each stop shows why it was picked and what it didn't match.
   If nothing fits fully, fill with the best partial matches and label them.
6. Later (needs a backend, so discuss first): shared Letterboxd-style reviews with accounts.

## Working with the owner
- The owner is learning to build software. Explain every change in plain language: what, why, and
  what could go wrong. Define jargon the first time.
- Ask before product decisions (what the user sees or what data is used). Pick sensible defaults for
  small technical choices and say what you picked.
- Say plainly what you don't know or couldn't verify. Never present a guess as a fact.

## Workflow
- **One change per pull request.** Every fix, feature, enhancement and docs change gets its own branch
  and PR. Never bundle a fix into a feature PR. If you find a bug while building something, fix it in a
  separate PR and say so.
- Start each branch from the latest `main`. If the work depends on an unmerged PR, ask the owner to
  merge it first instead of stacking branches.
- Branch names: `fix/…`, `feature/…`, `docs/…`, `chore/…`.
- Never push to `main` directly; the owner reviews and merges every PR.
- PR descriptions: What changed · Why · How it was tested · **What was NOT tested** (e.g. "checked
  against a fake Google Maps, not the real one").

## Architecture
- Static site on GitHub Pages. No build step, no frameworks, no npm runtime dependencies. Ask before
  adding any library.
- Deploy: `.github/workflows/deploy.yml` runs on push to `main`: `npm test`, then writes `js/config.js`
  from the `GOOGLE_MAP_KEY` secret, then publishes.
- File responsibilities. Keep them separate:
  - `js/route-planning.js`, `js/cafe-details.js`, `js/cafe-selection.js`, `js/walk-preferences.js`: pure logic
    and formatting (no DOM, no Google), unit-tested. `walk-preferences.js` holds the `ASPECTS` list
    (label and Google search phrase for each preference) and ranks the possible walks.
  - `js/google-maps.js`: the only file that talks to Google.
  - `js/coffee-log.js`: check-ins in localStorage.
  - `js/app.js`: browser glue (buttons, location, map drawing, which view the panel shows).
  - `js/sheet-snapping.js`: pure maths for the phone bottom sheet's resting heights, unit-tested.
  - `js/bottom-sheet.js`: dragging and tapping the sheet handle (DOM only).
- The panel has three views (setup, walk, detail), chosen by `data-view` on `#panel`. On phones the
  panel is a bottom sheet and the map ends exactly where the sheet begins, with no overlap: Google's
  logo sits along the map's bottom edge and its terms require it to stay visible.
- Size and position `.map-area`, never `#map`: Google's script sets `position: relative` on the map
  element, which overrides our CSS (this once collapsed the map to zero height on phones).

## Design system
- Source of truth: the Figma file "Coffee Walk — Design System"
  (https://www.figma.com/design/TAUz8uhQSr0vvbJJAC6Vac). Warm and cozy, light mode only, phone first.
- `css/tokens.css` mirrors the Figma variables by name (`color/bg/brand` = `--color-bg-brand`).
  Change a value in both places or neither.
- Components use semantic tokens only: no raw colours, sizes or fonts in `css/style.css` or in
  JavaScript. Read a token from JavaScript with `getComputedStyle` when Google needs a colour.
- Design a new screen in Figma first and get the owner's approval before coding it.
- Phone rules: tap targets at least 44 px, body text at least 16 px, text contrast at least 4.5:1,
  main actions within thumb reach at the bottom.

## Code style
- Name every identifier so a newcomer understands it without reading the surrounding code.
- Text from the internet (café names, reviews, addresses) goes in with `textContent`, never `innerHTML`.
- Comments explain *why*, not *what*.
- Error messages say which step failed and include Google's own reason. There's no console on a phone.

## Testing
- Run `npm test` before every PR. New pure logic gets unit tests.
- Browser checks live in `tests/browser/check.cjs` (`npm run test:browser`). Run them before every PR
  that touches the page, and extend them with the feature. They use a fake Google Maps. Before relying on one, check the fake's shape against Google's
  docs (lesson: `LatLngBounds` lives in `importLibrary("core")`, not `"maps"`. The fake copied the
  same mistake, so tests passed while the live site crashed).

## Google Maps Platform: cost and security
- APIs used: Maps JavaScript API, Places API (New), Routes API. The key is billed.
- The key is visible in the live site (the browser needs it). Its website restriction is what protects
  it. Never commit the key; `js/config.js` is gitignored.
- The `fields` list in each Places request sets the price. Request only what's displayed, and say
  so in the PR when adding a field from a pricier tier.
- Reuse search results (e.g. "New route" doesn't search again) instead of calling Google repeatedly.
- Each Start costs one Nearby Search plus one Text Search per chosen preference (up to 9 requests).
  Adding a preference adds a request per walk; say so in the PR.
- Google's terms: place IDs may be stored indefinitely; other Places data (names, ratings, hours) must
  not be stored long-term. Anything persisted (now the coffee log; later a shared database) should key
  on place ID and re-fetch details.
