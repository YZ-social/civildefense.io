const { localStorage, URL, URLSearchParams } = globalThis;
import * as L from 'leaflet';
import { Int } from './translations.js';
import { consume } from './display.js';
import { Agent } from './agent.js';
import { P2PWebNetwork } from './p2pWebNetwork.js';
import { Alert, go } from './alert.js';
import { resetInactivityTimer, tooltip } from './main.js';
import { Hashtags } from './hashtags.js';

export let map; // Leaflet map object.

const infoBanner = document.getElementById('info');
let messageTimeout;
export function showMessage(message, type = 'loading', errorObject) { // Show loading/instructions/error message.
  if (errorObject || type === 'error' ) console.error(message, errorObject || '');
  else if (message) console.warn(message);
  if (!message) {
    infoBanner.style.display = 'none';
    return;
  }

  if (infoBanner.style) infoBanner.style = '';
  infoBanner.innerHTML = message;
  const className = `info-banner ${type}`;
  if (infoBanner.className !== className) infoBanner.className = className;

  if (type === 'instructions') {
    clearTimeout(messageTimeout);
    messageTimeout = setTimeout(() => infoBanner.style.display = 'none', 5e3);
  }
}

let yourLocation; // marker
let lastLatitude, lastLongitude;

export function updateLocation(lat, lng, zoom, positionLabel) { // initMap if necessary, and set our position.
  //console.log('updateLocation', lat, lng, map, yourLocation);
  // Can't call getCurrentPosition while watching. So set it here for use in recenterMap.
  lastLatitude = lat;
  lastLongitude = lng;

  if (!map) {
    initMap(lat, lng, zoom, positionLabel);

    const params = new URL(location).searchParams;
    const tags = params.get('tags');
    const tagsArray = tags?.split(',') || [];
    tagsArray.forEach(tag => Hashtags.add(decodeURIComponent(tag)));
    Hashtags.onchange({resetSubscriptions: false}); // Too early to subscribe, but will be done during initialization.
    go({lat: params.get('lat'), lng: params.get('lng'), zoom: params.get('z'), subject: params.get('sub')});
    // We don't need the query parameters now. Get rid of them. They're annoying.
    const copy = new URL(location);
    const dht = copy.searchParams.get('dht');
    if (copy.searchParams.size > 0) {
      copy.search = '';
      history.replaceState(null, '', copy);
    }

    return;
  }
  // Otherwise just update the yourLocation marker if appropriate (and not update zoom).
  if (positionLabel) yourLocation.getPopup().setContent(positionLabel);

  // setLatLng can cause the map to autoPan to put the marker within bounds.
  // It seems like that shouldn't happen with autoPan:false, above, but it does.
  // So let's not even update it if it is outside the displayed area.
  // However, that means we will need to updateLocation from the last position on map moveend.
  if (!map.getBounds().contains(L.latLng(lat, lng))) return;

  const latLng = [lat, lng];
  setTimeout(() => yourLocation.setLatLng(latLng), 100); // It seems that yourLocation can be set, but not yet ready to be moved?
}

export function recenterMap(event) {
  consume(event);
  Alert.closePopup();
  const latLng = [lastLatitude, lastLongitude];
  map.flyTo(latLng);
}

export var trackMap;

export function initMap(lat, lng, zoom, positionLabel) { // Set up appropriate zoomed initial map and handlers for this position.
  // Then show initial message and updateSubscriptions.

  P2PWebNetwork.setSessionRegion({lat, lng});

  // Map will be centered at the given current location marker, unless overriden by query parameters.
  let center = {lat, lng};
  const queryParameters = new URLSearchParams(location.search);
  if (queryParameters.has('lat')) center.lat = queryParameters.get('lat');
  if (queryParameters.has('lng')) center.lng = queryParameters.get('lng');
  if (queryParameters.has('z')) zoom = queryParameters.get('z');

  map = L.map('map', { // Ensuring the default values, in case they have changed in some library version.
    worldCopyJump: false,
    center,
    zoom,
    minZoom: 2,
    zoomControl: navigator.maxTouchPoints <= 1, // Only when no multi-touch.
    maxBounds: [[90, 180], [-90, -180]]
  }).stopLocate(); // Just in case some library version initates this.

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    // Because we have a service worker AND rebuild dom structure within canvas in domtoimage, we need to tell Leaflet to not be opaque.
    crossOrigin: 'anonymous',
    maxZoom: 19
  }).addTo(map);

  // Add the "About" button. This is incredibly subtle, because we need for the button
  // to be rendered above the map, but below the popups. The Leaflet pupups are in their
  // own stacking context, and there is no way to arrange for some element to be rendered
  // WITHIN some other stacking context. (This makes sense if you think about how to
  // render efficiently.) However, that whole stacking context gets transformed as the
  // map moves around under the viewport. There's no way to position right:10px from the
  // viewport when there's a transform in between you and the viewport. So instead,
  // we handle map 'move' events by adjusting the about container element's style so as
  // to keep it 10px from the right edge of the viewport.
  const subPopoverControls = document.getElementById('subPopoverControls');
  const popupPane = document.querySelector('.leaflet-popup-pane');
  const mapPane = document.querySelector('.leaflet-map-pane');
  trackMap = () => {
    const rect = mapPane.getBoundingClientRect();
    subPopoverControls.style = `left: ${-rect.left}px; top: ${-rect.top}px;`;
  };
  popupPane.parentElement.insertBefore(subPopoverControls, popupPane);
  trackMap();
  map.on('move', trackMap);

  // Add a marker at user's current location
  L.Icon.Default.prototype.options.crossOrigin = 'anonymous'; // Set default prop, as it is used on next line.
  yourLocation = L.marker([lat, lng], {autoPan: false})
    .addTo(map)
    .bindPopup(positionLabel)
    .openPopup();
  // We close the popup on move, because the map will try to keep an open popup from straddling the bounds,
  // which can be confusing. It also closes when another marker is made, so it's nice to just close it
  // upon interaction.
  map.on('movestart', () => {
    resetInactivityTimer();
    map.closePopup(yourLocation.getPopup());
  });
  map.on('moveend', () => {
    Alert.updateSubscriptions();
    updateLocation(lastLatitude, lastLongitude); // Might now be within map.
  });

  // Add click event to note position
  map.on('click', async function(e) {
    resetInactivityTimer();
    if (document.getElementById('map').querySelector('.leaflet-popup')) return; // Ignore clicks with popup open.
    const { lat, lng } = e.latlng;
    Alert.openPopup(await Alert.publish({lat, lng}));
    Agent.current.persistPublicMetadata(P2PWebNetwork.regionCode(lat, lng));
  });
  tooltip('.leaflet-control-zoom-in', Int`Zoom in to show more detail in the map.`);
  tooltip('.leaflet-control-zoom-out', Int`Zoom out to show a larger area in the map.`);
}
