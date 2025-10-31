import { s2 } from 'https://esm.sh/s2js';
import { publish, subscribe } from './pubSub.js';
import { getContainingCells, findCoverCellsByCenterAndPoint } from './s2.js';

export let map; // Leaflet map object.
const ttl = 10 * 10e3;

const infoBanner = document.getElementById('info');
export function showMessage(message, type = 'loading', errorObject) { // Show loading/instructions/error message.
  if (errorObject) console.error(message, errorObject);
  if (!message) {
    infoBanner.style.display = 'none';
    return;
  }

  infoBanner.style = '';
  infoBanner.textContent = message;
  infoBanner.className = `info-banner ${type}`;

  if (type === 'instructions') {
    setTimeout(() => infoBanner.style.display = 'none', 4000);
  }
}

let markers = []; // array of { marker, key }
const icon = L.icon({iconUrl: "images/Achtung.png", iconSize: [40, 35]});
export function showMarker({position, expiration, _level}, key) { // Add marker at position, completing a fade out at expiration.  key is the subscription key that triggered the call.
  const now = Date.now(),
        remaining = expiration - now;
  if (remaining < 0) return;  // expired.
  const marker = L.marker(position, {icon}).addTo(map);
  // TODO: use css transitions?
  const interval = 1000, // milliseconds per adjustment (a tiny increment at a time)
        fade = interval / ttl; // Change in opacity per adjustment.
  let opacity = remaining / ttl; // Do not start at 1 if it was reported some time ago.
  marker.setOpacity(opacity);
  const timer = setInterval(() => {
    marker.setOpacity(opacity -= fade);
    if (opacity > 0) return;
    clearInterval(timer);
    marker.removeFrom(map);
    markers = markers.filter(mObj => mObj.marker !== marker);
  }, interval);

  markers.push({ marker, key }); // TODO: use a weak map to hold against gc instead?
}

let subscriptions = []; // array of stringy keys s2:<cellID>
function updateSubscriptions() { // Update current subscriptions to the new map bounds.
  const center = map.getCenter();
  const bounds = map.getBounds();
  const northEast = bounds.getNorthEast();
  const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
  const newKeys = newCells.map(cell => `s2:${cell}`);

  // For each entry in the new subscription set that was not previously subscribed,
  // subscribe now.
  for (const key of newKeys) subscriptions.includes(key) || subscribe(key, showMarker);

  // For each existing subscription, if it does not appear in the new set then
  // unsubscribe, and after a small pause (to allow the new subscriptions' stickies
  // to arrive) remove all markers that were placed by that sub.
  for (const key of subscriptions) {
    if (!newKeys.includes(key)) {
      subscribe(key, null);
      const newMarkers = [];
      for (const mObj of markers) {
        const { marker, key: mKey } = mObj;
        if (mKey === key) {
          // first fade, then after a while remove.  TODO: smooth this.
          marker.setOpacity(marker.options.opacity / 2);
          setTimeout(() => marker.removeFrom(map), 1000);
        }
        else newMarkers.push(mObj);
      }
      markers = newMarkers;
    }
  }

  subscriptions = newKeys;
}

var yourLocation;
export function initMap(lat, lng) { // Set up appropriate zoomed initial map and handlers for this position.
  // Initialize map centered on user's location
  map = L.map('map').setView([lat, lng], 14);

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  // Add a marker at user's current location
  yourLocation = L.marker([lat, lng])
    .addTo(map)
    .bindPopup('Your Location')
    .openPopup();

  // Add click event to note position
  map.on('click', function(e) {
    const { lat, lng } = e.latlng;
    const position = [lat, lng];
    //showMarker({position, expiration: Date.now() + ttl}); // To debug by showing immediately.
    const cells = getContainingCells(lat, lng);
    for (const cell of cells) {
      // add _level for debug only
      publish(`s2:${cell}`, {position, _level: s2.cellid.level(cell), expiration: Date.now() + ttl}, ttl);
    }
  });

  map.on('moveend', updateSubscriptions);

  updateSubscriptions();
  showMessage('Tap anywhere to mark a concern. Markers fade after 10 min.', 'instructions');
}

export function updateLocation(lat, lng) {
  if (!map) {
    initMap(lat, lng);
    return;
  }
  const latLng = [lat, lng];
  yourLocation.setLatLng(latLng);
}

export function recenterMap(lat, lng) {
  const latLng = [lat, lng];
  map.panTo(latLng);
}

export function defaultInit() { // After two seconds, show San Fransisco.
  setTimeout(() => {
    updateLocation(37.7749, -122.4194);
  }, 2000);
}

