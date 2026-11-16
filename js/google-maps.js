// Everything that talks to Google lives here, so swapping providers later touches one file.

import { parseGoogleDurationSeconds, boundingBoxAround } from "./route-planning.js";
import { SEARCH_PRIMARY_TYPES } from "./cafe-selection.js";

// Loads the Maps JavaScript API once. Resolves when `google.maps.importLibrary` is ready.
export function loadGoogleMaps(apiKey) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // Google calls this global function if the key is wrong, unrestricted for this site, etc.
    window.gm_authFailure = () =>
      reject(new Error("Google rejected the API key. Check the key and its allowed websites in Google Cloud."));
    window.onGoogleMapsReady = () => resolve();
    const parameters = new URLSearchParams({ key: apiKey, v: "weekly", loading: "async", callback: "onGoogleMapsReady" });
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?${parameters}`;
    script.async = true;
    script.onerror = () => reject(new Error("Couldn't download Google Maps. Check your internet connection."));
    document.head.append(script);
  });
}

// The fields list sets the price of each search (see CLAUDE.md). Everything here is shown to the user:
// rating, price, hours and website appear on the stop cards and map popups.
const DETAILED_PLACE_FIELDS = [
  "id",
  "displayName",
  "location",
  "rating",
  "userRatingCount",
  "businessStatus",
  "formattedAddress",
  "priceLevel",
  "regularOpeningHours",
  "utcOffsetMinutes", // the café's time zone, needed to work out "open now" from its opening hours
  "websiteURI",
  "googleMapsURI",
  "primaryType", // e.g. "coffee_shop", "cafe", "bakery": what Google says the place mainly is
  "primaryTypeDisplayName", // the same in words, e.g. "Coffee shop", shown on the stop card
];
const BASIC_PLACE_FIELDS = ["id", "displayName", "location"];

// Returns cafés as plain objects: { placeId, name, location: {lat, lng}, rating, ratingCount,
// address, priceLevel, weeklyHours, openingPeriods, utcOffsetMinutes, websiteUrl, googleMapsUrl, primaryType, typeLabel }.
// Any detail may be null. Deciding which ones are real coffee stops happens in cafe-selection.js.
export async function searchNearbyCafes(center, radiusMeters) {
  const { Place } = await google.maps.importLibrary("places");
  const locationRestriction = { center, radius: radiusMeters };
  let places;
  try {
    ({ places } = await Place.searchNearby({
      fields: DETAILED_PLACE_FIELDS,
      locationRestriction,
      // Primary type = what the place mainly is. Plain includedTypes also matched bagel shops and
      // pie companies that merely list "cafe" among their secondary types.
      includedPrimaryTypes: SEARCH_PRIMARY_TYPES,
      maxResultCount: 20,
    }));
  } catch (detailedSearchError) {
    console.warn("Detailed café search failed; retrying with basic fields only.", detailedSearchError);
    try {
      ({ places } = await Place.searchNearby({
        fields: BASIC_PLACE_FIELDS,
        locationRestriction,
        includedPrimaryTypes: ["coffee_shop", "cafe"],
        maxResultCount: 20,
      }));
    } catch (basicSearchError) {
      // Keep both of Google's reasons: the first often names the real problem.
      throw new Error(`${detailedSearchError.message} (basic retry: ${basicSearchError.message})`);
    }
  }
  const openPlaces = places.filter((place) => place.businessStatus == null || place.businessStatus === "OPERATIONAL");
  return openPlaces.map(toCafe);
}

// Coffee shops Google's text search returns for a phrase like "cozy quiet coffee shop", best match
// first, inside the box around `center`. Used to guess which cafés fit a preference: Google has no
// "cozy" field, but its search reads reviews and descriptions.
// Two settings matter (both checked against real Google):
//   - locationRestriction: only places inside the walking area. With a mere "bias" towards the area,
//     about 8 of every 20 results were too far to walk to.
//   - includedType + strict filtering: coffee shops only. Without it, some phrases ("lively coffee
//     shop") returned bars and restaurants instead.
// Throws with Google's reason if the search is refused.
export async function searchCafesByText(center, radiusMeters, textQuery) {
  const { Place } = await google.maps.importLibrary("places");
  const { places } = await Place.searchByText({
    textQuery,
    fields: DETAILED_PLACE_FIELDS,
    locationRestriction: boundingBoxAround(center, radiusMeters),
    includedType: "coffee_shop",
    useStrictTypeFiltering: true,
    maxResultCount: 20,
  });
  const openPlaces = places.filter((place) => place.businessStatus == null || place.businessStatus === "OPERATIONAL");
  return openPlaces.map(toCafe);
}

function toCafe(place) {
  return {
    placeId: place.id,
    name: place.displayName ?? "Unnamed café",
    location: { lat: place.location.lat(), lng: place.location.lng() },
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? null,
    address: place.formattedAddress ?? null,
    priceLevel: place.priceLevel ?? null,
    weeklyHours: place.regularOpeningHours?.weekdayDescriptions ?? null,
    openingPeriods: place.regularOpeningHours?.periods?.map(toPlainPeriod) ?? null,
    utcOffsetMinutes: place.utcOffsetMinutes ?? null,
    websiteUrl: place.websiteURI ?? null,
    googleMapsUrl: place.googleMapsURI ?? null,
    primaryType: place.primaryType ?? null,
    typeLabel: place.primaryTypeDisplayName ?? null,
  };
}

// Google's opening period as plain data: when it opens and closes, with days counted from Sunday = 0.
// `close` is missing for a place that never closes. cafe-details.js turns these into "Open now".
function toPlainPeriod(period) {
  const toPlainPoint = (point) => ({ day: point.day, hour: point.hour, minute: point.minute });
  return { open: toPlainPoint(period.open), close: period.close ? toPlainPoint(period.close) : null };
}

const ROUTES_ENDPOINT = "https://routes.googleapis.com/directions/v2:computeRoutes";
// The field mask tells Google which parts of the answer we want (and pay for).
const ROUTES_FIELD_MASK = [
  "routes.distanceMeters",
  "routes.duration",
  "routes.legs.distanceMeters",
  "routes.legs.duration",
  "routes.polyline.geoJsonLinestring",
].join(",");

const toWaypoint = ({ lat, lng }) => ({ location: { latLng: { latitude: lat, longitude: lng } } });

// Real walking route along streets: start → stops (in the given order) → start.
// Throws if Google refuses; the caller falls back to straight lines.
export async function computeWalkingLoop(apiKey, start, orderedStops) {
  const response = await fetch(ROUTES_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": ROUTES_FIELD_MASK },
    body: JSON.stringify({
      origin: toWaypoint(start),
      destination: toWaypoint(start),
      intermediates: orderedStops.map((stop) => toWaypoint(stop.location)),
      travelMode: "WALK",
      polylineEncoding: "GEO_JSON_LINESTRING",
    }),
  });
  if (!response.ok) throw new Error(`Routes API answered ${response.status}: ${await response.text()}`);
  const route = (await response.json()).routes?.[0];
  if (!route) throw new Error("Routes API found no walking route.");
  return {
    legs: route.legs.map((leg) => ({
      distanceMeters: leg.distanceMeters ?? 0,
      durationSeconds: parseGoogleDurationSeconds(leg.duration) ?? 0,
    })),
    // GeoJSON stores [longitude, latitude] — the opposite order from Google Maps' {lat, lng}.
    path: route.polyline.geoJsonLinestring.coordinates.map(([lng, lat]) => ({ lat, lng })),
  };
}
