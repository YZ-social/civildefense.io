import { Int } from './translations.js';
import { s2 } from 'https://esm.sh/s2js';
import { v4 as uuidv4 } from 'uuid';
import { publish, subscribe, unpublishLast, resetInactivityTimer } from './pubSub.js';
import { getContainingCells, findCoverCellsByCenterAndPoint } from './s2.js';
const { L } = globalThis; // Leaflet namespace, for linters.

export let map; // Leaflet map object.
const ttl = 10 * 10e3;

const infoBanner = document.getElementById('info');
export function showMessage(message, type = 'loading', errorObject) { // Show loading/instructions/error message.
  if (errorObject) console.error(message, errorObject);
  if (!message) {
    infoBanner.style.display = 'none';
    return;
  }

  if (infoBanner.style) infoBanner.style = '';
  infoBanner.textContent = message;
  const className = `info-banner ${type}`;
  if (infoBanner.className !== className) infoBanner.className = className;

  if (type === 'instructions') {
    setTimeout(() => infoBanner.style.display = 'none', 4000);
  }
}

class Marker { // A wrapper around L.marker
  static icon = L.icon({iconUrl: "images/Achtung.png", iconSize: [40, 35]});
  // When we resubscribe to different cells covering the same place, we will get the same
  // sticky data. We don't want to change the marker. Fortunately, the publication to each
  // of the cells (at different scales) are all published with the same data.
  static markers = {}; // We keep track by subject UUID.
  static ensure(data) { // Add market at position with appropriate fade if not already present.
    const { payload, subject, issuedTime } = data;
    const existing = this.markers[subject]; // We are relying on the "same" data hashing in the same way as a property indicator.
    if (!payload) return existing?.destroy();
    if (existing) return existing; // No need to be glitchy and create a new one.
    const now = Date.now(),
	  expiration = issuedTime + ttl,
          remaining = expiration - now;
    if (remaining < 0) return null;  // expired.
    const marker = L.marker(payload, {icon: this.icon, autoPan: false}).addTo(map);
    // It would be nice to use CSS transitions, but, that's not the API presented by L.marker.
    const interval = 1000, // milliseconds per adjustment (a tiny increment at a time)
          fade = interval / ttl; // Change in opacity per adjustment.
    let opacity = remaining / ttl; // Do not start at 1 if it was reported some time ago.
    marker.setOpacity(opacity);
    const fader = setInterval(() => {
      marker.setOpacity(opacity -= fade);
      if (opacity > 0) return;
      wrapper.destroy();
    }, interval);
    const wrapper = this.markers[subject] = new this();
    Object.assign(wrapper, {marker, data, fader});
    return wrapper;
  }
  destroy() {
    clearInterval(this.fader);
    this.marker.removeFrom(map);
    delete this.constructor.markers[this.data];
  }
}

let subscriptions = []; // array of stringy keys s2:<cellID>
function updateSubscriptions() { // Update current subscriptions to the new map bounds.
  const center = map.getCenter();
  const bounds = map.getBounds();
  const northEast = bounds.getNorthEast();
  const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
  const newKeys = newCells.map(cell => `s2:${cell}`);

  // For each entry in the new subscription set that was not previously subscribed,/ subscribe now.
  for (const key of newKeys) subscriptions.includes(key) || subscribe(key, data => Marker.ensure(data));

  // For each existing subscription, if it does not appear in the new set then unsubscribe.
  for (const key of subscriptions) newKeys.includes(key) || subscribe(key, null);

  subscriptions = newKeys;
}

let yourLocation; // marker
let lastLatitude, lastLongitude;

export function updateLocation(lat, lng) {
  // Can't call getCurrentPosition while watching. So set it here for use in recenterMap.
  lastLatitude = lat;
  lastLongitude = lng;

  if (!map) {
    initMap(lat, lng);
    return;
  }

  // setLatLng can cause the map to autoPan to put the marker within bounds.
  // It seems like that shouldn't happen with autoPan:false, above, but it does.
  // So let's not even update it if it is outside the displayed area.
  // However, that means we will need to updateLocation from the last position on map moveend.
  if (!map.getBounds().contains(L.latLng(lat, lng))) return;

  const latLng = [lat, lng];
  yourLocation.setLatLng(latLng);
}

export function recenterMap() {
  resetInactivityTimer();
  const latLng = [lastLatitude, lastLongitude];
  map.flyTo(latLng);
}

export function initMap(lat, lng) { // Set up appropriate zoomed initial map and handlers for this position.
  // Initialize map centered on user's location
  showMessage(Int`Getting your location...`);

  map = L.map('map', { // Ensuring the default values, in case they have changed in some library version.
    worldCopyJump: false,
    maxBounds: null
  })
    .setView([lat, lng], 14)
    .stopLocate(); // Just in case some library version initates this.

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  // Add a marker at user's current location
  yourLocation = L.marker([lat, lng], {autoPan: false})
    .addTo(map)
    .bindPopup(Int`Your Location`)
    .openPopup();
  // We close the popup on move, because the map will try to keep an open popup from straddling the bounds,
  // which can be confusing. It also closes when another marker is made, so it's nice to just close it
  // upon interaction.
  map.on('movestart', () => {
    resetInactivityTimer();
    map.closePopup(yourLocation.getPopup());
  });
  map.on('moveend', () => {
    resetInactivityTimer();
    updateSubscriptions();
    updateLocation(lastLatitude, lastLongitude); // Might now be within map.
  });

  // Add click event to note position
  map.on('click', function(e) {
    resetInactivityTimer();
    unpublishLast();
    const { lat, lng } = e.latlng;
    const position = [lat, lng];
    const cells = getContainingCells(lat, lng);
    const subject = uuidv4(); // Added to data to be round-tripped. Not a user tag!
    const issuedTime = Date.now();
    for (const cell of cells) {
      // add _level for debug only
      const removeMeLevel = s2.cellid.level(cell);
      if (removeMeLevel < 5 || removeMeLevel > 10) continue;
      publish({eventName: `s2:${cell}`, payload: position, _level: s2.cellid.level(cell), issuedTime, subject});
    }
  });

  updateSubscriptions();
  showMessage(Int`Tap anywhere to mark a concern. Markers fade after 10 min.`, 'instructions');
}

export function defaultInit() { // After two seconds, show San Fransisco.
  setTimeout(() => {
    updateLocation(37.7749, -122.4194);
  }, 2000);
}

