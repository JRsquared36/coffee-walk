// Everything that talks to Google lives here, so swapping providers later touches one file.

import { parseGoogleDurationSeconds } from "./route-planning.js";

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

// Fields cost different amounts; rating is a pricier tier that a demo key may not include.
const DETAILED_PLACE_FIELDS = ["id", "displayName", "location", "rating", "userRatingCount", "businessStatus"];
const BASIC_PLACE_FIELDS = ["id", "displayName", "location"];

// Returns cafés as plain objects: { placeId, name, location: {lat, lng}, rating, ratingCount }.
export async function searchNearbyCafes(center, radiusMeters) {
  const { Place } = await google.maps.importLibrary("places");
  const locationRestriction = { center, radius: radiusMeters };
  let places;
  try {
    ({ places } = await Place.searchNearby({
      fields: DETAILED_PLACE_FIELDS,
      locationRestriction,
      includedTypes: ["cafe", "coffee_shop"],
      maxResultCount: 20,
    }));
  } catch (detailedSearchError) {
    console.warn("Detailed café search failed; retrying with basic fields only.", detailedSearchError);
    ({ places } = await Place.searchNearby({
      fields: BASIC_PLACE_FIELDS,
      locationRestriction,
      includedTypes: ["cafe"],
      maxResultCount: 20,
    }));
  }
  return places
    .filter((place) => place.businessStatus == null || place.businessStatus === "OPERATIONAL")
    .map((place) => ({
      placeId: place.id,
      name: place.displayName ?? "Unnamed café",
      location: { lat: place.location.lat(), lng: place.location.lng() },
      rating: place.rating ?? null,
      ratingCount: place.userRatingCount ?? null,
    }));
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
