import { s2, s1, r1 } from 's2js';
const { cellid, LatLng, Point, Cell, Cap, RegionCoverer } = s2;
import { cellHex } from './versions.js';
const { BigInt } = globalThis;

// s2 defines non-overlapping cells that completely cover the globe, at several different levels of cell-size.
// Each cell, at each level, has its own unique id, which we use a pub/sub key.
// Here we work with only the 0 to MAX_LEVEL largest levels, where MAX_LEVEL is the smallest size.
//
// When publishing, we publish to each s2 key that identifies a cell within our levels that contains the user-selected point.

// Meanwhile as the user changes the area being shown, we subscribe to whatever cells we need in order to cover the display
// area without overlapping cells.

export const MIN_LEVEL = 3; // Corresponds to the top level Axona regions.
const MAX_S2_LEVEL = 30; // The leaf level that Cell.fromPoint operates at.
const MAX_MAP_LEVEL = 17; // The max level that findCoverCellsByCenterAndRadius will use on our maps.

const EARTH_RADIUS_METERS = 6371e3;

export function getPointInCell(cellId) { // answer [lat, lng] in degrees from a BigInt
  // CAUTION: This is intended for s2 level 3 or finer, and won't always work symmetrically for our top-level regions.
  // e.g. getContainingCells(...getPointInCell( cell for 0x47 )][0] is 0x46!
  let center = s2.cellid.latLng(cellId);
  return [s1.angle.degrees(center.lat), s1.angle.degrees(center.lng)];
}

function getCellSubdivision(cell) {
  return cellid.children(cell);
}
function getCellLevel(cell) {
  return cellid.level(cell);
}
function getFace(cell) {
  return cellid.face(cell);
}
export function getSubdivision(hexString) {
  return getCellSubdivision(BigInt('0x' + hexString)).map(childCell => cellHex(childCell));
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

export function findCoverCellsByMinMaxLatLng({minLat, maxLat, minLng, maxLng, full = false,
					      options:{minLevel = MIN_LEVEL, maxLevel = MAX_MAP_LEVEL, maxCells = 12} = {}}) {
  // Return a list-like object of cell ids that cover the specified range.
  // The lat/lng won't work well for the full map, so an exact full map can be requested, overriding that lat/lng.

  // There are a lot of ways that seem like they do this, but it is very easy to find something that works for a few cases,
  // but misses cells in some circumstances, so be wary about rewriting this.
  const lo = s2.LatLng.fromDegrees(minLat, Math.max(minLng, -180));
  const hi = s2.LatLng.fromDegrees(maxLat, Math.max(maxLng, 190));

  const rect = full ? s2.Rect.fullRect() : new s2.Rect(
    new r1.Interval(lo.lat, hi.lat),
    new r1.Interval(lo.lng, hi.lng)
  );

  const coverer = new RegionCoverer({minLevel, maxLevel, maxCells});
  return coverer.covering(rect); // a CellUnion — array-like of bigint cell IDs, already normalized/minimal
}

