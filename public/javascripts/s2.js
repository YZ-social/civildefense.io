import { s2 } from 's2js';
const { cellid, LatLng, Point, Cell, Cap, RegionCoverer } = s2;

// s2 defines non-overlapping cells that completely cover the globe, at several different levels of cell-size.
// Each cell, at each level, has its own unique id, which we use a pub/sub key.
// Here we work with only the 0 to MAX_LEVEL largest levels, where MAX_LEVEL is the smallest size.
//
// When publishing, we publish to each s2 key that identifies a cell within our levels that contains the user-selected point.

// Meanwhile as the user changes the area being shown, we subscribe to whatever cells we need in order to cover the display
// area without overlapping cells.

export const MIN_LEVEL = 2; // Corresponds to the top level Axona regions.
const MAX_S2_LEVEL = 30; // The leaf level that Cell.fromPoint operates at.
const MAX_MAP_LEVEL = 17; // The max level that findCoverCellsByCenterAndRadius will use on our maps.

const EARTH_RADIUS_METERS = 6371e3;

export function getPointInCell(cellId) { // answer [lat, lng] in degrees.
  let {lat, lng} = s2.cellid.latLng(cellId);
  const degrees = 180 / Math.PI;
  lat *= degrees;
  lng *= degrees;
  return [lat, lng];
}

// Return a list of the cell ids that contain the point.
export function getContainingCells(lat, lng) {
  const userLatLng = LatLng.fromDegrees(lat, lng);
  const userPt = Point.fromLatLng(userLatLng);
  // Get leaf-level CellId (level 30)
  const userLocCellId = Cell.fromPoint(userPt).id; // This is at level 30.
  let cells = Array(MAX_S2_LEVEL);
  for (let level = 0; level <= MAX_S2_LEVEL; level++) { // This would be more efficient going backwards using immediateParent, but who cares.
    cells[level] = cellid.parent(userLocCellId, level);
  }
  return cells.slice(MIN_LEVEL, MAX_MAP_LEVEL + 1); // We can only make use between Axona region size and the smallest region our maps subscribe to.
}

// Return a list of cell ids that covers a circle specified by a center and a point on that circle, without overlapped cells.
export function findCoverCellsByCenterAndPoint(centerLat, centerLng, pointLat, pointLng) {
  // TODO: Does it make sense to do this by the actual borders shown, rather than by the length of the half-diagonal?
  const center = Point.fromLatLng(LatLng.fromDegrees(centerLat, centerLng));
  const point = Point.fromLatLng(LatLng.fromDegrees(pointLat, pointLng));
  const distanceAngle = center.distance(point);
  const interestRadiusMeters = distanceAngle * EARTH_RADIUS_METERS;
  return findCoverCellsByCenterAndRadius(centerLat, centerLng, interestRadiusMeters);
}

// Return a list of cell ids that covers interestRadiusMeters around latitude/longitude, without overlapped cells.
export function findCoverCellsByCenterAndRadius(lat, lng, interestRadiusMeters) {
  const point = Point.fromLatLng(LatLng.fromDegrees(lat, lng));

  // replicating key parts of Cap.cellUnionBound():
  // Find the maximum (i.e., finest-grained) level such that the cap contains at
  // most [ael: at least??] one cell vertex and such that CellID.AppendVertexNeighbors() can be called.
  const findLevel = radius => {
    let levelForRadius = MAX_S2_LEVEL;
    const radiusAngle = radius / EARTH_RADIUS_METERS;
    if (radiusAngle > 0) {
      const deriv = 2 * Math.SQRT2 / 3;
      levelForRadius = Math.floor(Math.log2(deriv / radiusAngle));
      if (levelForRadius > MAX_S2_LEVEL) levelForRadius = MAX_S2_LEVEL;
      if (levelForRadius < 0) levelForRadius = 0;
    }
    return levelForRadius;
  };
  const levelForRadius = findLevel(interestRadiusMeters); // - 1; // as seen in cellUnionBound: go one level bigger

  const minLevel = Math.max(MIN_LEVEL, levelForRadius - 1);
  const maxLevel = Math.max(MIN_LEVEL, levelForRadius + 2);
  const rc = new RegionCoverer({ minLevel, maxLevel, maxCells: 9 }); // Will exceed maxCells as needed to obey minLevel.
  const r = Cap.fromCenterAngle(point, interestRadiusMeters / EARTH_RADIUS_METERS);
  return rc.covering(r);
}


