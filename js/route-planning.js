// Pure logic for planning a coffee walk: no browser, no Google, no network.
// Everything here can be tested with `npm test`.

export const AVERAGE_WALKING_SPEED_METERS_PER_SECOND = 1.35; // about 4.9 km/h
export const CHECK_IN_RADIUS_METERS = 75;
// Phone GPS is often off by 10–50 m (worse indoors). We forgive up to this much
// of the reported inaccuracy so people standing in the café can still check in.
export const MAX_GPS_ACCURACY_ALLOWANCE_METERS = 50;

const EARTH_RADIUS_METERS = 6_371_000;

// Straight-line ("as the crow flies") distance between two {lat, lng} points.
export function haversineDistanceMeters(pointA, pointB) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(pointB.lat - pointA.lat);
  const longitudeDelta = toRadians(pointB.lng - pointA.lng);
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(toRadians(pointA.lat)) * Math.cos(toRadians(pointB.lat)) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a));
}

// Pick `stopCount` different cafés at random. `randomNumber` is injectable so tests are repeatable.
export function chooseRandomStops(cafes, stopCount, randomNumber = Math.random) {
  const shuffled = [...cafes];
  // Fisher–Yates shuffle, stopped early once we have enough.
  for (let index = 0; index < Math.min(stopCount, shuffled.length); index++) {
    const swapIndex = index + Math.floor(randomNumber() * (shuffled.length - index));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled.slice(0, stopCount);
}

// Length of start → stop1 → … → stopN → start, using straight-line distances.
export function loopLengthMeters(start, orderedStops) {
  const path = [start, ...orderedStops.map((stop) => stop.location), start];
  let totalMeters = 0;
  for (let index = 1; index < path.length; index++) {
    totalMeters += haversineDistanceMeters(path[index - 1], path[index]);
  }
  return totalMeters;
}

// Try every visiting order and keep the shortest loop.
// 5 stops = 120 orders, which is instant, and it is always the true best order
// (unlike "always walk to the nearest café next", which can zig-zag).
export function orderStopsForShortestLoop(start, stops) {
  let shortestOrder = stops;
  let shortestLength = Infinity;
  for (const candidateOrder of allOrderings(stops)) {
    const candidateLength = loopLengthMeters(start, candidateOrder);
    if (candidateLength < shortestLength) {
      shortestLength = candidateLength;
      shortestOrder = candidateOrder;
    }
  }
  return shortestOrder;
}

function* allOrderings(items) {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let index = 0; index < items.length; index++) {
    const remainingItems = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const orderingOfRest of allOrderings(remainingItems)) {
      yield [items[index], ...orderingOfRest];
    }
  }
}

// Used when Google can't give us a real walking route: straight lines, estimated times.
export function estimateStraightLineLegs(start, orderedStops) {
  const path = [start, ...orderedStops.map((stop) => stop.location), start];
  const legs = [];
  for (let index = 1; index < path.length; index++) {
    const distanceMeters = haversineDistanceMeters(path[index - 1], path[index]);
    legs.push({ distanceMeters, durationSeconds: distanceMeters / AVERAGE_WALKING_SPEED_METERS_PER_SECOND });
  }
  return legs;
}

// The Routes API sends durations as strings like "754s".
export function parseGoogleDurationSeconds(durationText) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(durationText ?? "");
  return match ? Number(match[1]) : null;
}

export function formatDistance(meters) {
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function formatWalkingTime(seconds) {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// Can someone at `userPosition` (with GPS accuracy `accuracyMeters`) check in at `cafeLocation`?
export function checkInDistanceVerdict(userPosition, accuracyMeters, cafeLocation) {
  const distanceMeters = haversineDistanceMeters(userPosition, cafeLocation);
  const forgivenMeters = Math.min(accuracyMeters ?? 0, MAX_GPS_ACCURACY_ALLOWANCE_METERS);
  return { distanceMeters, isCloseEnough: distanceMeters - forgivenMeters <= CHECK_IN_RADIUS_METERS };
}

// Opens Google Maps (app or web) with walking directions to one café.
export function buildWalkingDirectionsUrl(cafe) {
  const parameters = new URLSearchParams({
    api: "1",
    destination: `${cafe.location.lat},${cafe.location.lng}`,
    travelmode: "walking",
  });
  if (cafe.placeId) parameters.set("destination_place_id", cafe.placeId);
  return `https://www.google.com/maps/dir/?${parameters}`;
}
