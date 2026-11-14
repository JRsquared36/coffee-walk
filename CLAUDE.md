# Working conventions for Coffee Walk

## One change per pull request
- Every fix, feature and enhancement gets its own branch and its own pull request.
- Never bundle a bug fix into a feature PR, or two features into one PR. If a fix is found while
  building a feature, put the fix in a separate PR and mention it to the owner.
- Start each branch from the latest `main`. If a new change depends on an unmerged PR, ask the
  owner to merge that PR first instead of stacking on top of it.
- PR descriptions say what changed, why, and how it was tested (including what was NOT tested,
  e.g. checks run against a fake Google Maps rather than the real one).

## Project facts
- Static site on GitHub Pages, deployed by `.github/workflows/deploy.yml` on push to `main`.
  The workflow runs `npm test`, then writes `js/config.js` from the `GOOGLE_MAP_KEY` secret.
- `js/config.js` is gitignored; `js/config.example.js` is the template for local preview.
- Run `npm test` before every PR.
