# Coffee Walk

A phone-first web app that builds a walking tour through nearby coffee shops. You pick up to two
things you're in the mood for, how long you want to walk and how many stops; it finds you, picks the
coffee shops that fit best, orders them into a loop, and draws the walking route. Each stop shows
which of your choices it matched, and you can check in at a stop to rate it.

Live: https://jrsquared36.github.io/coffee-walk/ · Owner: @JRsquared36

## What exists now
- **Setup:** up to two preferences (Good coffee, Unique space, Outdoor seating, Cozy & quiet,
  Lively & buzzy, Work-friendly), walk length (15/30/45/60 min) and stop range (2–3, 3–4, 5–6).
- **Finding cafés:** one Google Nearby Search, plus one Text Search per chosen preference. The rules
  for what counts as a stop are listed at the top of `js/cafe-selection.js`.
- **Matching:** a café matches a preference if it is among the first five qualifying results of
  that preference's search (`MATCHES_PER_PREFERENCE` in `js/walk-preferences.js`). It is a hint, and
  the app says so.
- **Choosing the walk:** every group of stops in the range is tried. Walks within the chosen time
  come first, then walks up to 5 minutes over; within each, best fit, then more stops, then shorter.
  One café per name. "New route" steps through the five best without searching again.
- **On the map:** numbered pins, a walking route from Google's Routes API (straight lines if that
  fails), a café view when a pin or card is tapped.
- **Check-in:** only within about 75 m of the café; rating and note saved in this browser.

## Roadmap
Done: v1, café details, coffee-first selection, design system and phone layout, preferences, and a
first round of fixes from testing against real Google.

Ideas not yet built, in no fixed order. Ask the owner which is next:
- Leave off cafés that will have closed by the time the walk reaches them.
- Remember the chosen preferences between visits.
- Bring the Figma file back in line with the app (preferences screen, café view with match badges).
- A designed wide-screen layout.
- Shared Letterboxd-style reviews with accounts. Needs a backend, so discuss first.

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

## Shared check-ins (friends beta, in progress)
- Database: Supabase (free plan). Sign-in: Google only. Access: only emails in `beta_members`.
  Every beta member sees every check-in; each person changes only their own.
- Everything about it is in `supabase/`: the schema and row-level security rules in
  `supabase/migrations/`, their tests, and the owner's setup steps in `supabase/README.md`.
- The app reaches the database with a public key, so **the rules in the database are the only
  protection**. Every table has row-level security on. A new table without rules is open to everyone.
- Never edit a migration that has been run on the real project; add a new numbered file.
- Run `npm run test:database` (needs a local throwaway Postgres) after any change to the rules,
  and weaken the rule on purpose to confirm a test fails.
- Store Google place IDs only. Never store a café's name, address or hours in the database.
- Never ask for, print or commit the Supabase secret (service_role) key, the database password or
  the Google client secret. The project URL and publishable key are public.
- Still to build, one PR each, screens designed in Figma first: sign-in and username; saving
  check-ins to the database (importing the local log); the feed and café page; friends' ratings on
  walk stops.

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
  that touches the page, and extend them with the feature. They use a fake Google Maps.
- **The fake only proves the code does what you assumed Google does.** Five bugs passed every check
  and broke the live site because the fake copied a wrong assumption:
  - `LatLngBounds` lives in `importLibrary("core")`, not `"maps"`.
  - Google sets `position: relative` on the map element, overriding our CSS.
  - `Place.isOpen()` exists only in Google's beta channel; this app loads the regular one.
  - The route was zoomed to while the sheet still covered the map.
  - Google's logo sits on the map's bottom edge, where the sheet used to overlap it.
  So: read Google's reference before using an API for the first time, make the fake behave like
  the real thing, and confirm a new check fails on the old code.
- **Test against real Google before saying something works.** The `coffee-walk` cloud environment
  allows Google's hosts and the live site. The key only works from the live address, so load
  `https://jrsquared36.github.io/coffee-walk/` in headless Chromium (through `HTTPS_PROXY`) and use
  Playwright's `page.route` to serve the page's own files from the working tree, leaving
  `js/config.js` to come from the live site. Never copy the key into the repo.
  Real requests are billed: keep runs small and tell the owner roughly how many were made.
- Say in every PR what was checked on real Google and what was only checked against the fake.

## Google Maps Platform: cost and security
- APIs used: Maps JavaScript API, Places API (New), Routes API. The key is billed.
- The key is visible in the live site (the browser needs it). Its website restriction is what protects
  it. Never commit the key; `js/config.js` is gitignored.
- The `fields` list in each Places request sets the price. Request only what's displayed, and say
  so in the PR when adding a field from a pricier tier.
- Reuse search results (e.g. "New route" doesn't search again) instead of calling Google repeatedly.
- Each Start costs one Nearby Search, one Text Search per chosen preference (at most two), and one
  Routes request: at most four. "New route" costs one Routes request. Say so in the PR if a change
  adds requests or fields.
- The key's allowed websites cover the live address only. `http://localhost:8000` is refused unless
  the owner adds it in Google Cloud.
- Google's terms: place IDs may be stored indefinitely; other Places data (names, ratings, hours) must
  not be stored long-term. Anything persisted (now the coffee log; later a shared database) should key
  on place ID and re-fetch details.
