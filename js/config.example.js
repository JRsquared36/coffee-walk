// Template for js/config.js, which is NOT committed (see .gitignore).
//
// Live site: the GitHub Actions deploy writes js/config.js from the GOOGLE_MAP_KEY repository secret.
// Local preview: copy this file to js/config.js and paste your key there.
//
// The key still ends up visible in the live site (the browser needs it), so protect it in
// Google Cloud Console → Credentials → your key → "Website restrictions":
// allow https://jrsquared36.github.io/* and http://localhost:8000/* only.
export const GOOGLE_MAPS_API_KEY = "PASTE_YOUR_KEY_HERE";
