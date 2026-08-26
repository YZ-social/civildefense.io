import { s2, s1, r1 } from 's2js';
const { cellid, LatLng, Point, Cell, Cap, RegionCoverer } = s2;
import { cellHex } from './versions.js';
import { geoCellCenter/*, geoCellId*/ } from '@axona/protocol';
const { BigInt } = globalThis;

// s2 defines non-overlapping cells that completely cover the globe, at several different levels of cell-size.
// Each cell, at each level, has its own unique id, which we use a pub/sub key.
// Here we work with only the 0 to MAX_LEVEL largest levels, where MAX_LEVEL is the smallest size.
//
// When publishing, we publish to each s2 key that identifies a cell within our levels that contains the user-selected point.

// Meanwhile as the user changes the area being shown, we subscribe to whatever cells we need in order to cover the display
// area without overlapping cells.

export const MIN_LEVEL = 3; // The largest cell that is still smaller than an Axona region.
const MAX_S2_LEVEL = 30; // The leaf level that Cell.fromPoint operates at.
const MAX_MAP_LEVEL = 17; // The max level that findCoverCellsByCenterAndRadius will use on our maps.

const EARTH_RADIUS_METERS = 6371e3;

export function getPointInCell(cellId) { // answer [lat, lng] in degrees from a BigInt
  // const {lat, lng} = geoCellCenter(cellid);
  // return [lat, lng];
  // CAUTION: This is intended for s2 level 3 or finer, and won't always work symmetrically for our top-level regions.
  // e.g. getContainingCells(...getPointInCell( cell for 0x47 )][0] is 0x46!
  let center = s2.cellid.latLng(cellId);
  return [s1.angle.degrees(center.lat), s1.angle.degrees(center.lng)];
}

function getCellSubdivision(cell) { // Answer four children off BigInt cell, as BigInt.
  return cellid.children(cell);
}
export function getSubdivision(hexString) { // Same as getCellSubDivision, but accepting and returning hex strings.
  return getCellSubdivision(BigInt('0x' + hexString)).map(childCell => cellHex(childCell));
}
function getCellLevel(cell) { // Answer level of BigInt cell, as number.
  return cellid.level(cell);
}
function getCellFace(cell) { // Answer top level face id of BigInt cell, as integer 0 through 5.
  return cellid.face(cell);
}
export function cellContains(putativeOuter, putativeInner) { // Answer true IFF putativeOuter BigInt cell contains putativeInner
  return cellid.contains(putativeOuter, putativeInner);
}
export function pointFromLatLng(lat, lng) { // Answer an s2 Point from lat/lng in degrees.
  const latLng = LatLng.fromDegrees(lat, lng);
  return Point.fromLatLng(latLng);
}
export function cellFromCellID(bigint) {
  return Cell.fromCellID(bigint);
}
export function getSmallestCellId(lat, lng, level = MAX_MAP_LEVEL) { // Answer smallest BigInt cellid containing latitude/longitude in degrees, at integer level.
  const userPt = pointFromLatLng(lat, lng);
  const userLocCellId = Cell.fromPoint(userPt).id; // This is at MAX_S2_LEVEL
  return cellid.parent(userLocCellId, level);
}

// Return a list of the cell ids that contain the point, from region to MAX_S2_LEVEL
// Note that the first of the cells (the region
export function getContainingCells(lat, lng) {
  let id = getSmallestCellId(lat, lng);
  const level = MAX_MAP_LEVEL, cells = Array(MAX_MAP_LEVEL + 1 - MIN_LEVEL);
  for (let index = level - MIN_LEVEL; index >= 0; index--) {
    cells[index] = id;
    id = cellid.immediateParent(id);
  }
  return cells;
}

export function findCoverCellsByMinMaxLatLng({minLat, maxLat, minLng, maxLng, full = false,
					      options:{minLevel = MIN_LEVEL, maxLevel = MAX_MAP_LEVEL, maxCells = 12} = {}}) {
  // Return a list-like object of cell ids that cover the specified range.
  // The lat/lng won't work well for the full map, so an exact full map can be requested, overriding that lat/lng.

  // There are a lot of ways that seem like they do this, but it is very easy to find something that works for a few cases,
  // but misses cells in some circumstances, so be wary about rewriting this.
  const lo = LatLng.fromDegrees(minLat, minLng);
  const hi = LatLng.fromDegrees(maxLat, maxLng);

  const rect = full ? s2.Rect.fullRect() : new s2.Rect(
    new r1.Interval(lo.lat, hi.lat),
    new r1.Interval(lo.lng, hi.lng)
  );

  const coverer = new RegionCoverer({minLevel, maxLevel, maxCells});
  return coverer.covering(rect); // a CellUnion — array-like of bigint cell IDs, already normalized/minimal
}
