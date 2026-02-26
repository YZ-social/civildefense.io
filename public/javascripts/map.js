import { Int } from './translations.js';
import { s2 } from 'https://esm.sh/s2js';
import { v4 as uuidv4 } from 'uuid';
import { networkPromise, resetInactivityTimer } from './main.js';
import { getContainingCells, findCoverCellsByCenterAndPoint } from './s2.js';
const { L, URLSearchParams } = globalThis; // Leaflet namespace, for linters.

export let map; // Leaflet map object.
const ttl = 10 * 60e3; // Ten minutes

const infoBanner = document.getElementById('info');
export function showMessage(message, type = 'loading', errorObject) { // Show loading/instructions/error message.
  if (errorObject || errorObject) console.error(message, errorObject);
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

// We subscribe to the cartesian product of the list of non-overlapping cells and all hashes.
// We publish to just the first of these.
let hashtags = new URLSearchParams(location.search).get('tags')?.split(',') || ['all'];
function updateHashtags(newTag, oldTag = null) { // Add newTag as the first, and remove oldTag if present. Update url.
  hashtags = [newTag, ...hashtags.filter(tag => ![newTag, oldTag].includes(tag))];
  updateQueryParameters();
  updateSubscriptions();
}
function makeEventName(cell, hash = hashtags[0]) { // Include the outgoing hashtag (first of hashtags) in the pubsub eventName
  return `s2:${cell}:${hash}`;
}
function updateQueryParameters({params = new URLSearchParams(location.search), lat = params.get('lat'), lng = params.get('lng'), zoom = params.get('z')} = {}) { // Update url to reflect application state.
  params.set('tags', hashtags.toString());
  if (lat !== null) params.set('lat', lat);
  if (lng !== null) params.set('lng', lng);
  if (zoom !== null) params.set('z', zoom);    
  history.replaceState(null, '', `?${params.toString()}`);
}

let subscriptions = []; // array of stringy keys s2:<cellID>:<hashtag>
export function updateSubscriptions(oldKeys = subscriptions) { // Update current subscriptions to the new map bounds.
  // A value of [] passed for oldKeys is used to start things off fresh (i.e., without supressing subscription of any carry-overs).
  const center = map.getCenter();
  const zoom = map.getZoom();
  updateQueryParameters({zoom, ...center});
  const bounds = map.getBounds();
  const northEast = bounds.getNorthEast();
  const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
  const newKeys = newCells.flatMap(cell => hashtags.map(hash => makeEventName(cell, hash)));
  console.log('subscribing to', newKeys, 'and dropping', oldKeys);
  const subscribe = (key, value, autoRenewal = false) =>
	networkPromise.then(async contact => contact.subscribe({eventName: key, handler: value, autoRenewal}));

  // For each entry in the new subscription set that was not previously subscribed, subscribe now.
  for (const key of newKeys) oldKeys.includes(key) || subscribe(key, data => Marker.ensure(data), true);

  // For each existing subscription, if it does not appear in the new set then unsubscribe.
  for (const key of oldKeys) newKeys.includes(key) || subscribe(key, null);

  subscriptions = newKeys;
}

let last = null; // Last published lat, lng, subject
function publish({lat, lng, message, // Publish the given data to all applicable eventNames.
		  subject  = uuidv4(), // For recognizing locally executed events and for cancelling. Not a user tag!
		  payload = {lat, lng, message}, // If payload is null (cancels subject), lat & lng are still used to generate eventNames.
		  cancel = last, // First unpublish the specified data, if any.
		  issuedTime = Date.now(),
		  immediate = true,  // Whether to act locally before sending.
		  ...rest
		 }) {

  if (cancel) {
    const {lat, lng, hashtag, subject} = cancel;
    const time = issuedTime - 1;
    const cells = getContainingCells(lat, lng);
    for (const cell of cells) {
      networkPromise.then(contact =>
	contact.publish({eventName: makeEventName(cell, hashtag), subject, payload: null, issuedTime: time, hashtag, act: contact.name, immediate, ...rest}));
    }
    console.log('revoking (e.g.)', {cell: cells[0], hashtag, subject});
  }

  const hashtag = hashtags[0];
  const cells = getContainingCells(lat, lng);
  last = payload && {lat, lng, hashtag, subject}; // Capture the new subject and eventName data for next time.
  for (const cell of cells) {
    const _level = s2.cellid.level(cell); // add _level for debugging
    const eventName = makeEventName(cell, hashtag);
    networkPromise.then(contact =>
      contact.publish({eventName, subject, payload, _level, issuedTime, hashtag, act: contact.name, immediate, ...rest}));
  }
  console.log('publishing to (e.g.)', {cell: cells[0], hashtag, subject, payload});
}

class Marker { // A wrapper around L.marker
  static icon = L.icon({iconUrl: "images/Achtung.png", iconSize: [40, 35]});
  // When we resubscribe to different cells covering the same place, we will get the same
  // sticky data. We don't want to change the marker. Fortunately, the publication to each
  // of the cells (at different scales) are all published with the same data.
  static markers = {}; // subject => Marker
  static noMessage = `No additional information.`; // fixme Int
  static ensure(data) { // Add marker at position with appropriate fade if not already present.
    const { payload, subject, issuedTime, act, hashtag, immediateLocalAction = false, suppressReopen = false } = data;
    const ourTag = globalThis.contact.name;
    let wrapper = this.markers[subject]; // We are relying on the "same" data hashing in the same way as a property indicator.
    console.log('handling event', {wrapper, subject, payload, act, ourTag, immediateLocalAction, data});

    if (!payload) return wrapper?.destroy();
    const now = Date.now(),
	  expiration = issuedTime + ttl,
          remaining = expiration - now;
    if (remaining < 0) return wrapper?.destroy();  // expired.

    wrapper ||= this.markers[subject] = new this();
    const {lat, lng, message} = payload;
    const isOurs = act === ourTag;
    const timestamp = new Date(issuedTime).toLocaleString();
    const messageText = message || Marker.noMessage;
    const content = isOurs ?
	  `${timestamp}<br>you (${act})<br><p contenteditable>${messageText}</p>#<span contenteditable>${hashtags[0]}</span> <button>cancel alert</button>` :
	  `${timestamp}<br>node ${act}<br><p>${messageText}</p>#${hashtag}`;
    let {marker} = wrapper;
    let existingPopup = marker?.getPopup();
    if (!marker) {
      marker = L.marker([lat, lng], {icon: this.icon, autoPan: false}).addTo(map);
      marker.bindPopup(content)
	.on('popupopen', event => { // Set up handlers.
	  if (!isOurs) return;
	  const popupElement = event.popup.getElement();
	  popupElement.querySelector('button').onclick = event=> {
	    event.stopPropagation();
	    publish({lat, lng, subject, payload: null, cancel: null});
	  };
	})
	.on('popupclose', event => isOurs && wrapper.maybeUpdate(event.popup.getElement()));
      console.log({subject, hashtag, last});
      if (!(isOurs && suppressReopen)) marker.openPopup(); // hack guard to not re-open what we just closed when changing hashtags
    } else if (content !== existingPopup.getContent()) {
      existingPopup.setContent(content);
    }

    // Set up or update fader.
    // It would be nice to use CSS transitions, but, that's not the API presented by L.marker.
    const interval = 1000, // milliseconds per adjustment (a tiny increment at a time)
          fade = interval / ttl; // Change in opacity per adjustment.
    let opacity = remaining / ttl; // Do not start at 1 if it was reported some time ago.
    marker.setOpacity(opacity);
    clearInterval(wrapper.fader);
    const fader = setInterval(() => {
      marker.setOpacity(opacity -= fade);
      if (opacity > 0) return;
      wrapper.destroy();
    }, interval);

    Object.assign(wrapper, {marker, lat, lng, subject, message, issuedTime, hashtag, fader});
    return wrapper;
  }
  maybeUpdate(displayElement) { // If data has changed, republish.
    const {lat, lng, hashtag, subject, message} = this;
    let newMessage = displayElement.querySelector('p').innerHTML;
    if (newMessage === Marker.noMessage) newMessage = undefined;
    const newHashtag = displayElement.querySelector('span').textContent;
    const isNewHashtag = newHashtag !== hashtag;
    //console.log({lat, lng, subject, message, newMessage, hashtag, newHashtag, isNewHashtag});
    if (newMessage === message && !isNewHashtag) return;
    let cancel = null;
    if (isNewHashtag) {
      updateHashtags(newHashtag); // Don't rememove the old hashtag until we cancel old alert.
      cancel = {lat, lng, hashtag, subject};
    }
    publish({lat, lng, subject, message: newMessage, cancel, suppressReopen: isNewHashtag}); // immediate for canceled and new, before we remove old hash
    if (isNewHashtag) {
      updateHashtags(newHashtag, hashtag); // Now remove old hashtag.
    }
  }
  destroy() {
    clearInterval(this.fader);
    this.marker.removeFrom(map);
    delete this.constructor.markers[this.subject];
  }
}

let yourLocation; // marker
let lastLatitude, lastLongitude;

export function updateLocation(lat, lng) { // initMap if necessary, and set our position.
  //console.log('updateLocation', lat, lng);
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
  // Then show initial message and updateSubscriptions.

  showMessage(Int`Getting your location...`);

  // Map will be centered at the given current location marker, unless overriden by query parameters.
  let center = {lat, lng}, zoom = 14;
  const queryParameters = new URLSearchParams(location.search);
  if (queryParameters.has('lat')) center.lat = queryParameters.get('lat');
  if (queryParameters.has('lng')) center.lng = queryParameters.get('lng');
  if (queryParameters.has('z')) zoom = queryParameters.get('z');

  map = L.map('map', { // Ensuring the default values, in case they have changed in some library version.
    worldCopyJump: false,
    center,
    zoom,
    //zoomSnap: 0,
    maxBounds: null
  }).stopLocate(); // Just in case some library version initates this.

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
    updateSubscriptions();
    updateLocation(lastLatitude, lastLongitude); // Might now be within map.
  });

  // Add click event to note position
  map.on('click', function(e) {
    resetInactivityTimer();
    const { lat, lng } = e.latlng;
    publish({lat, lng});
  });

  showMessage(Int`Tap anywhere to mark a concern. Markers fade after 10 minutes.`, 'instructions');
}

export function defaultInit() { // After two seconds, show San Fransisco.
  setTimeout(() => {
    updateLocation(37.7749, -122.4194);
  }, 2000);
}

