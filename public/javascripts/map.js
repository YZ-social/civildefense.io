const { L, jdenticon, localStorage } = globalThis; // Leaflet namespace, for linters.
import { v4 as uuidv4 } from 'uuid';
import { s2 } from 's2js';
import { Int } from './translations.js';
import { networkPromise, resetInactivityTimer } from './main.js';
import { Hashtags } from './hashtags.js';
import { getContainingCells, findCoverCellsByCenterAndPoint } from './s2.js';

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

const usertag = localStorage.getItem('usertag') || uuidv4();
localStorage.setItem('usertag', usertag);

function makeEventName(cell, hash) { // Include the outgoing hashtag (first of hashtags) in the pubsub eventName
  return `s2:${cell}:${hash}`;
}
export function updateQueryParameters({params = new URLSearchParams(location.search), lat = params.get('lat'), lng = params.get('lng'), zoom = params.get('z')} = {}) { // Update url to reflect application state.
  params.set('tags', Hashtags.getSubscribe().toString());
  if (lat !== null) params.set('lat', lat);
  if (lng !== null) params.set('lng', lng);
  if (zoom !== null) params.set('z', zoom);    
  history.replaceState(null, '', `?${params.toString()}`);
}

let subscriptions = []; // array of stringy keys s2:<cellID>:<hashtag>
export function updateSubscriptions(oldKeys = subscriptions) { // Update current subscriptions to the new map bounds.
  // A value of [] passed for oldKeys is used to start things off fresh (i.e., without supressing subscription of any carry-overs).
  if (!networkPromise) { console.warn("No network through which to subscribe."); return; } // Does this ever happen? Why?
  const center = map.getCenter();
  const zoom = map.getZoom();
  updateQueryParameters({zoom, ...center});
  const bounds = map.getBounds();
  const northEast = bounds.getNorthEast();
  const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
  const newKeys = newCells.flatMap(cell => Hashtags.getSubscribe().map(hash => makeEventName(cell, hash)));
  console.log('subscribing', {newKeys, oldKeys});
  const subscribe = (key, value, autoRenewal = false) =>
	networkPromise.then(async contact => contact.subscribe({eventName: key, handler: value, autoRenewal}));

  // For each entry in the new subscription set that was not previously subscribed, subscribe now.
  for (const key of newKeys) oldKeys.includes(key) || subscribe(key, data => Marker.ensure(data), true);

  // For each existing subscription, if it does not appear in the new set then unsubscribe.
  for (const key of oldKeys) newKeys.includes(key) || subscribe(key, null);

  subscriptions = newKeys;
}

let last = null; // Last published lat, lng, subject
async function publish({lat, lng, message, // Publish the given data to all applicable eventNames, promising subject.
		  originalPosting = undefined,
		  subject  = uuidv4(), // For recognizing locally executed events and for cancelling. Not a user tag!
		  payload = {lat, lng, message, originalPosting}, // If payload is null (cancels subject), lat & lng are still used to generate eventNames.
		  cancel = last, // First unpublish the specified data, if any.
		  issuedTime = Date.now(),
		  immediate = true,  // Whether to act locally before sending.
		  ...rest
		 }) {
  const contact = await networkPromise; // subtle: The rest of this all happens synchronously, with any null payloads definitely first.
  let oldCells = null, oldHash, oldSubject = null, act = usertag;
  if (cancel) {
    const {lat, lng, hashtag, subject} = cancel;
    const time = issuedTime - 1;
    oldCells = getContainingCells(lat, lng);
    oldHash = hashtag; oldSubject = subject;
    for (const cell of oldCells) {
      contact.publish({eventName: makeEventName(cell, hashtag), subject, payload: null, issuedTime: time, hashtag, act, immediate, ...rest});
    }
  }

  const hashtag = Hashtags.getPublish();
  const cells = getContainingCells(lat, lng);
  last = payload && {lat, lng, hashtag, subject}; // Capture the new subject and eventName data for next time.
  for (const cell of cells) {
    const _level = s2.cellid.level(cell); // add _level for debugging
    const eventName = makeEventName(cell, hashtag);
    contact.publish({eventName, subject, payload, _level, issuedTime, hashtag, act, immediate, ...rest});
  }
  console.log('publishing', {cells, hashtag, subject, payload, oldCells, oldHash, oldSubject});
  return subject;
}

export class Marker { // A wrapper around L.marker
  //static icon = L.icon({iconUrl: "images/Achtung.png", iconSize: [40, 35]});
  // When we resubscribe to different cells covering the same place, we will get the same
  // sticky data. We don't want to change the marker. Fortunately, the publication to each
  // of the cells (at different scales) are all published with the same data.
  static markers = {}; // subject => Marker
  static noMessage = `No additional information.`; // fixme Int
  static closePopup() { // Close any open popup.
    map.closePopup();
  }
  static openPopup(subject) { // Open the marker specified by subject.
    const wrapper = this.markers[subject];
    wrapper?.marker.openPopup();
  }
  static ensure(data) { // Add marker at position with appropriate fade if not already present.
    const { payload, subject, issuedTime, act, hashtag, immediateLocalAction = false } = data;
    let wrapper = this.markers[subject]; // We are relying on the "same" data hashing in the same way as a property indicator.
    console.log('handling event', {wrapper, subject, payload, act, usertag, immediateLocalAction, data});

    if (!payload) return wrapper?.destroy();
    const now = Date.now(),
	  expiration = issuedTime + ttl,
          remaining = expiration - now;
    if (remaining < 0) return wrapper?.destroy();  // expired.

    wrapper ||= this.markers[subject] = new this();
    const {lat, lng, message, originalPosting} = payload;
    const isOurs = act === usertag;
    const content = isOurs ?
	  `${wrapper.attribution({act, issuedTime, originalPosting, hashtag})}
<div class="post-input">
  <md-outlined-text-field type="textarea" label="message"${message ? `value="${message}"` : ''}></md-outlined-text-field>
  <form></form>
</div>
<div class="actions">
  <md-outlined-button><md-icon slot="icon" class="material-icons">delete</md-icon> remove</md-outlined-button>
  <md-filled-button><md-icon slot="icon" class="material-icons">check</md-icon> update</md-filled-button>
</div>` :
	  `${wrapper.attribution({act, issuedTime, originalPosting, hashtag})}<p>${message || Marker.noMessage}</p>`;
    let {marker} = wrapper;
    let existingPopup = marker?.getPopup();
    if (!marker) {
      marker = L.marker([lat, lng], {icon: L.divIcon({html: Hashtags.markerHTML(hashtag), className: 'alert-pin'}), autoPan: false}).addTo(map);
      marker.bindPopup(content, {className: 'alert'})
	.on('popupopen',
	    event => {
	      if (!isOurs) return;
	      const popup = event.popup;
	      const popupElement = popup.getElement();
	      Hashtags.resetPublisherDisplay(popupElement); // Lay out publishing hashtag buttons
	      popupElement.querySelector('md-outlined-button').onclick = event=> { // Cancel button clicked.
		event.stopPropagation();
		publish({lat, lng, subject, payload: null, cancel: null});
	      };
	      popupElement.querySelector('md-filled-button').onclick = event=> { // Update button clicked.
		event.stopPropagation();
		popup.close();
		wrapper.maybeUpdate(popupElement);
	      };
	    });
    } else if (content !== existingPopup.getContent()) { // If changed after creation.
      existingPopup.setContent(content);
    }
    Object.assign(wrapper, {marker, lat, lng, subject, message, originalPosting, issuedTime, hashtag});
    wrapper.startFader(remaining); // After marker is set.
    return wrapper;
  }
  attribution({act, issuedTime, originalPosting, hashtag = null}) {
    return `<div class="attribution">
  <minidenticon-svg username="${act}"></minidenticon-svg>
  <div class="times">
    <div>posted ${new Date(originalPosting || issuedTime).toLocaleString()}</div>
    ${originalPosting ? `<div>updated ${new Date(issuedTime).toLocaleString()}</div>` : ''}
  </div>
  ${hashtag ? `<div><span>${Hashtags.pubtagHTML(hashtag)}</span></div>` : ''}
</div>`;
  }
  maybeUpdate(displayElement) { // If data has changed, republish.
    const {lat, lng, hashtag, subject, message = '', issuedTime, originalPosting = issuedTime} = this;
    let newMessage = displayElement.querySelector('md-outlined-text-field').value;
    const newHashtag = displayElement.querySelector('span').textContent;
    const isNewHashtag = newHashtag !== hashtag;
    console.log({lat, lng, subject, message, newMessage, hashtag, newHashtag, isNewHashtag});
    resetInactivityTimer();
    if (newMessage === message && !isNewHashtag) return;
    let cancel = null;
    if (isNewHashtag) {
      Hashtags.setPublish(newHashtag);
      Hashtags.onchange();
      cancel = {lat, lng, hashtag, subject};
    }
    publish({lat, lng, subject, message: newMessage, originalPosting, cancel}); // immediate for canceled and new, before we remove old hash
  }
  startFader(remaining) {
        // Set up or update fader.
    // It would be nice to use CSS transitions, but, that's not the API presented by L.marker.
    const interval = 1000, // milliseconds per adjustment (a tiny increment at a time)
          fade = interval / ttl, // Change in opacity per adjustment.
	  { marker } = this;
    let opacity = remaining / ttl; // Do not start at 1 if it was reported some time ago.
    marker.setOpacity(opacity);
    clearInterval(this.fader);
    this.fader = setInterval(() => {
      marker.setOpacity(opacity -= fade);
      if (opacity > 0) return;
      this.destroy();
    }, interval);
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
  //console.log({latLng, yourLocation, bounds: map.getBounds(), map});
  yourLocation.setLatLng(latLng);
}

export function recenterMap() {
  resetInactivityTimer();
  Marker.closePopup();
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
    minZoom: 2,
    zoomControl: navigator.maxTouchPoints === 1, // Only when no multi-touch.
    maxBounds: [[90, 180], [-90, -180]]
  }).stopLocate(); // Just in case some library version initates this.

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  // Add a marker at user's current location
  yourLocation = L.marker([lat, lng], {autoPan: false})
    .addTo(map)
    .bindPopup(Int`Your Location`, {className: 'alert'})
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
  map.on('click', async function(e) {
    resetInactivityTimer();
    const { lat, lng } = e.latlng;
    Marker.openPopup(await publish({lat, lng}));
  });

  showMessage(Int`Tap anywhere to mark a concern. Markers fade after 10 minutes.`, 'instructions');
}

export function defaultInit() { // After two seconds, show San Fransisco.
  setTimeout(() => {
    updateLocation(37.7749, -122.4194);
  }, 2000);
}

