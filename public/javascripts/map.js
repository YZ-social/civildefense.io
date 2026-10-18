const { localStorage, URL, URLSearchParams } = globalThis;
import * as L from 'leaflet';
import { Int, language } from './translations.js';
import { consume, teach } from './display.js';
import { Agent } from './agent.js';
import { networkPromise, closeAll } from './main.js';
import { P2PWebNetwork } from './p2pWebNetwork.js';
import { Alert, go } from './alert.js';
import { resetInactivityTimer, tooltip } from './main.js';
import { Hashtags } from './hashtags.js';

export let map; // Leaflet map object.

function  flashElement(selector) {
  const element = document.querySelector(selector);
  setTimeout(() => element.style.animation = 'pulse20border ease 2s 1', 100);
}

// LOCATIONS
//
// Intrinsic:
// geoLocation [lat,lng] as reported periodically by navigator.geolocation.watchPosition callback when available/permitted.
// mapCenter [lat,lng,zoom] as reported by map moveend event.
//      Starts session with same value as end of previous session, if any, else geoLocation if any, else San Fransisco.
// destination [lat,lng,zoom?] as requested by following a url or touching a notification, if any.
//      After showing startup mapCenter to orient user, map flies to destination, if any.
//
// Derived:
// home [lat, lng] that the map recenter button flies to:
//      Updates with geoLocation if available, else initialized at startup to startup mapCenter
//      Shown on map (while in bounds) as a location marker, labeled as "Your location" or "Default location. Geolocation unavailable."
// node location [lat, lng] for computing region using value of home at start of session

let home; // Used by recenter button.
let homeMarker; // Marks location of home.
let startupMapCenter = null;
export async function updateHome(location = null) { // initMap if necessary, and set our position.
  startupMapCenter ||= JSON.parse(localStorage.getItem('mapCenter')) || location || [37.7749, -122.4194, 13]; // San Fransisco
  //console.log('updateHome', {location, startupMapCenter, home});
  home = location || home || startupMapCenter;
  if (!map) {
    const [lat, lng] = home;
    P2PWebNetwork.setSessionLocation({lat, lng}); // TODO: Arrange to capture an updated value whenever a new node is created
    initMap(startupMapCenter);

    const url = new URL(window.location);
    const params = url.searchParams;
    const tags = params.get('tags');
    const tagsArray = tags?.split(',') || [];
    const decodedTagsArray = tagsArray.map(decodeURIComponent);
    const highlight = params.get('highlight');
    if (decodedTagsArray.length) {
      const subscribed = Hashtags.getSubscribe();
      const extra = subscribed.filter(tag => !decodedTagsArray.includes(tag));
      if (extra.length) {
	const {promise, resolve} = Promise.withResolvers();
	const listFormatter = new window.Intl.ListFormat(language, { type: "conjunction" });
	const format = tags => listFormatter.format(tags.map(tag => `"${tag}"`));
	window.linkHad.textContent = Int`The link recommends only the topics ${format(decodedTagsArray)}.`;
	window.linkCTA.textContent = Int`What should be done with your additional existing topics?`;
	window.linkOff.textContent = Int`Toggle off extra topics for now`;
	window.linkOffExplanation.textContent = Int`You can toggle ${format(extra)} on again later.`;
	window.linkRemove.textContent = Int`Remove extra topics entirely`;
	window.linkRemoveExplanation.textContent = Int`You can add them again later with "add topic".`;
	window.linkKeep.textContent = Int`Leave them alone`;
	window.linkKeepExplanation.textContent = Int`You can toggle them off individually yourself.`;
	const dialog = window.hashtagDisposition;
	dialog.classList.toggle('hidden', false);  // Do not use openDisplay, as the user might accidentally dismiss by clicking anywhere.
	const close = action => {
	  dialog.classList.toggle('hidden', true);
	  resolve(action);
	};
	window.linkOff.onclick = () => close('toggle');
	window.linkRemove.onclick = () => close('remove');
	window.linkKeep.onclick = () => close('keep');
	const answer = await promise;
	switch (answer) {
	case 'toggle':
	  extra.forEach(tag => Hashtags.toggleChip(Hashtags.getChip(tag), false));
	  break;
	case 'remove':
	  extra.forEach(tag => Hashtags.remove(Hashtags.getChip(tag)));
	  break;
	default:
	}
      }
    }
    decodedTagsArray.forEach(tag => Hashtags.add(tag));
    Hashtags.onchange({resetSubscriptions: false}); // Too early to subscribe, but will be done during initialization.
    // We start the map at the lat/lng/zoom specied by caller (e.g., geo or previous session) in order to orient the user,
    // and then if there was a location specified in the URL, fly there.
    go({lat: params.get('lat'), lng: params.get('lng'), zoom: params.get('z'), alert: params.get('alert')});
    // We don't need the query parameters now. Get rid of them. They're annoying.
    if (params.size > 0) {
      ['tags', 'lat', 'lng', 'z', 'alert', 'highlight'].forEach(key => params.delete(key));
      history.replaceState(null, '', url);
    }
    if (highlight) flashElement(highlight);
  }

  // setLatLng can cause the map to autoPan to put the marker within bounds.
  // It seems like that shouldn't happen with autoPan:false, above, but it does.
  // So let's not even update it if it is outside the displayed area.
  // However, that means we will need to updateLocation from the last position on map moveend.
  if (!map.getBounds().contains(home)) return;
  if (homeMarker) {
    homeMarker.setLatLng(home);
    return;
  }
  // Add a marker at user's current location
  L.Icon.Default.prototype.options.crossOrigin = 'anonymous'; // Set default prop, as it is used on next line.
  const label = location ? Int`Your Location` : Int`Default location. Geolocation unavailable.`;
  homeMarker = L.marker(home, {autoPan: false})
    .addTo(map)
    .bindPopup(label)
    .openPopup();
}

export function recenterMap(event) {
  consume(event);
  closeAll();
  map.flyTo(home);
}

export var trackMap;

function isMouseWheel(event) { // Notch zoom is for a mouse. A trackpad keeps Leaflet's smooth zoom.
  if (event.ctrlKey || !event.deltaY) return false; // Pinch-zoom is a wheel event with ctrlKey set.
  if (event.deltaMode !== 0) return true; // Lines or pages: one mouse event is one notch.
  if (typeof event.wheelDeltaY !== 'number' || !event.wheelDeltaY) return false;
  // Chrome on Windows reports a mouse as wheelDeltaY / deltaY ≈ -1.2 (120 units per 100 pixels).
  // A two-finger swipe on this trackpad is integer pixels at -1. Chrome and Safari report a Mac trackpad near -3.
  return Math.abs(event.wheelDeltaY / event.deltaY + 1.2) < 0.08;
}

function installOneLevelWheelZoom(map) { // One mouse-wheel click changes zoom by one level.
  // Chrome reports one Windows mouse notch as about 100 pixels. Some mouse drivers spread
  // that notch across a few seconds of tiny events, and the next click continues the stream
  // with no gap. Leaflet then steps one level per batch until min or max zoom. Add the
  // pixels up and zoom once per notch. A wheel that is not recognized as a mouse stays with Leaflet.
  const notchPx = 100;
  const container = map.getContainer();
  let dir = 0;
  let credit = 0; // Pixels still covered by zooms already issued.
  let queued = 0; // Notches that arrived during Leaflet's zoom animation.
  let lastEvent = null;
  let zooming = false;
  // Same call Leaflet's scroll-wheel handler uses, so the 0.25s transform plays.
  // A zoom started while one is playing is ignored, so hold those notches until zoomend.
  const zoomBy = (event, direction) => {
    const step = map.options.zoomDelta || 1;
    const current = map.getZoom();
    const next = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), current + direction * step));
    if (next === current) return false;
    map.setZoomAround(map.mouseEventToContainerPoint(event), next);
    return true;
  };
  const requestZoom = (event, direction) => {
    lastEvent = event;
    if (zooming || map._animatingZoom) {
      queued += direction;
      return;
    }
    zooming = true;
    if (!zoomBy(event, direction)) {
      zooming = false;
      queued = 0;
    }
  };
  map.on('zoomend', () => {
    zooming = false;
    if (!queued) return;
    const direction = Math.sign(queued);
    queued -= direction;
    requestZoom(lastEvent, direction);
  });
  container.addEventListener('wheel', event => {
    if (!isMouseWheel(event)) return; // Do not preventDefault. Leaflet's scroll zoom still has to see trackpad and pinch events.
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaMode !== 0) { // A line or page event is already one notch, not 100 pixels.
      const direction = event.deltaY > 0 ? -1 : 1;
      requestZoom(event, direction);
      return;
    }
    const sign = Math.sign(event.deltaY);
    if (sign !== dir) { // A reversed wheel spends its pixels on the new direction.
      dir = sign;
      credit = 0;
    }
    const pixels = Math.abs(event.deltaY);
    const direction = sign > 0 ? -1 : 1; // Positive deltaY is wheel-down: zoom out.
    if (credit <= 0) {
      requestZoom(event, direction);
      credit = notchPx;
    }
    credit -= pixels;
    while (credit < 0) {
      requestZoom(event, direction);
      credit += notchPx;
    }
  }, {capture: true, passive: false});
}

function initMap([lat, lng, zoom]) { // Set up appropriate zoomed initial map and handlers for this position.
  // Then show initial message and updateSubscriptions.

  zoom ||= 14;
  let center = {lat, lng};

  map = L.map('map', { // Ensuring the default values, in case they have changed in some library version.
    worldCopyJump: false,
    center,
    zoom,
    minZoom: 2,
    zoomControl: navigator.maxTouchPoints <= 1, // Only when no multi-touch.
    maxBounds: [[90, 180], [-90, -180]]
  }).stopLocate(); // Just in case some library version initates this.
  installOneLevelWheelZoom(map);

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="yz.sidebar">OpenStreetMap</a> contributors',
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

  // We close the popup on move, because the map will try to keep an open popup from straddling the bounds,
  // which can be confusing. It also closes when another marker is made, so it's nice to just close it
  // upon interaction.
  map.on('movestart', () => {
    resetInactivityTimer();
    map.closePopup(homeMarker?.getPopup());
  });
  map.on('moveend', async () => {
    const {lat, lng} = map.getCenter();
    localStorage.setItem('mapCenter', JSON.stringify([lat, lng, map.getZoom()]));
    await networkPromise;
    updateHome(home); // Might now be within map.
    Alert.updateSubscriptions();
  });

  // Add click event to note position
  map.on('click', async function(e) {
    resetInactivityTimer();
    if (document.getElementById('map').querySelector('.leaflet-popup')) return; // Ignore clicks with popup open.
    const { lat, lng } = e.latlng;
    Alert.openPopup(await Alert.publish({lat, lng}));
    Agent.current.persistPublicMetadata();
  });
  if (document.querySelector('.leaflet-control-zoom')) { // Not present in mobile
    tooltip('.leaflet-control-zoom-in', Int`Zoom in to show more detail in the map.`);
    tooltip('.leaflet-control-zoom-out', Int`Zoom out to show a larger area in the map.`);
  }
}
