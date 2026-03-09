const { L, jdenticon, localStorage, URL, URLSearchParams } = globalThis; // Leaflet namespace, for linters.
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
  infoBanner.innerHTML = message;
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
export function getShareableURL() { // Answer a url that reflects application state.
  const params = new URLSearchParams(location.search);
  const zoom = map.getZoom();
  const { lat, lng } = map.getCenter();

  params.set('tags', Hashtags.getSubscribe().toString());
  if (lat !== null) params.set('lat', lat);
  if (lng !== null) params.set('lng', lng);
  if (zoom !== null) params.set('z', zoom);
  return new URL(`?${params.toString()}`, location);
}

let subscriptions = []; // array of stringy keys s2:<cellID>:<hashtag>
export function updateSubscriptions(oldKeys = subscriptions) { // Update current subscriptions to the new map bounds.
  // A value of [] passed for oldKeys is used to start things off fresh (i.e., without supressing subscription of any carry-overs).
  if (!networkPromise) { console.warn("No network through which to subscribe."); return; } // Does this ever happen? Why?
  const center = map.getCenter();
  const bounds = map.getBounds();
  const northEast = bounds.getNorthEast();
  const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
  const newKeys = newCells.flatMap(cell => Hashtags.getSubscribe().map(hash => makeEventName(cell, hash)));
  console.log('subscribing', {newKeys, oldKeys});
  const subscribe = (key, handler, autoRenewal = false) =>
	networkPromise.then(async contact => contact.subscribe({eventName: key, handler, autoRenewal}));

  // For each entry in the new subscription set that was not previously subscribed, subscribe now.
  for (const key of newKeys) oldKeys.includes(key) || subscribe(key, data => Marker.ensure(data), true);

  // For each existing subscription, if it does not appear in the new set then unsubscribe.
  for (const key of oldKeys) newKeys.includes(key) || subscribe(key, null);

  subscriptions = newKeys;
}

let last = null; // Last published lat, lng, subject
async function publish({lat, lng, message, // Publish the given data to all applicable eventNames, promising subject.
			originalPosting = undefined,
			hashtag = Hashtags.getPublish(),
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
      await contact.publish({eventName: makeEventName(cell, hashtag), subject, payload: null, issuedTime: time, hashtag, act, immediate, ...rest});
    }
  }

  const cells = getContainingCells(lat, lng);
  last = payload && {lat, lng, hashtag, subject}; // Capture the new subject and eventName data for next time.
  for (const cell of cells) {
    const _level = s2.cellid.level(cell); // add _level for debugging
    const eventName = makeEventName(cell, hashtag);
    await contact.publish({eventName, subject, payload, _level, issuedTime, hashtag, act, immediate, ...rest});
  }
  console.log('published', {cells, hashtag, subject, payload, oldCells, oldHash, oldSubject});
  return subject;
}

export class Marker { // A wrapper around L.marker
  // When we resubscribe to different cells covering the same place, we will get the same
  // sticky data. We don't want to change the marker. Fortunately, the publication to each
  // of the cells (at different scales) are all published with the same data.
  static markers = {}; // subject => Marker
  static noMessage = Int`No additional information.`;
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
    if (remaining < 0) return wrapper?.destroy();  // Expired.

    wrapper ||= this.markers[subject] = new this();
    const {lat, lng, message, originalPosting} = payload;
    Object.assign(wrapper, {lat, lng, subject, message, originalPosting, issuedTime, hashtag, act});
    let {marker} = wrapper;
    if (!marker) {
      const icon = L.divIcon({html: Hashtags.markerHTML(hashtag), className: 'alert-pin'});
      marker = wrapper.marker = L.marker([lat, lng], {icon, autoPan: false}).addTo(map);
      marker.bindPopup('', {className: 'alert'})
	.on('popupopen', event => wrapper.ensureContent(event.popup, remaining));
      // Subscribe to replies to this subject, now that we're set up to receive them.
      networkPromise.then(async contact => contact.subscribe({eventName: subject, autoRenewal: true, handler: data => wrapper.handleReply(data)}));
    } else {
      wrapper.needsRedisplay = true;
      wrapper.ensureContent();
    }
    wrapper.startFader(remaining); // From the new value of remaining, after marker is set in wrapper, regardless of popup/dirty state.
    return wrapper;
  }
  needsRedisplay = true;
  ensureContent(popup = this.marker.getPopup()) { // Set content and handlers in popup if/as needed.
    if (!this.needsRedisplay) return;
    if (!popup.isOpen()) return;
    this.needsRedisplay = false;
    const {act} = this;
    const isOurs = act === usertag;
    let content = isOurs ? this.formatOwnerPost() : this.formatObserverPost();
    content += this.formatReplies();
    popup.setContent(content);
    const popupElement = popup.getElement();
    const replyInput = popupElement.querySelector('.reply-input');
    replyInput.onchange = event => { resetInactivityTimer(); this.postReply(event); };
    if (!isOurs) return;
    this.initializeOwnerPopupHandlers(popup);
  }
  formatAttribution({act, issuedTime, originalPosting, hashtag = null}) { // Answer HTML for a row of sender/timestamp(s)/optional-hashtag
    return `
<div class="attribution">
  <minidenticon-svg username="${act}"></minidenticon-svg>
  <div class="times">
    <div>${Int`posted`} ${new Date(originalPosting || issuedTime).toLocaleString()}</div>
    ${originalPosting ? `<div>${Int`updated`} ${new Date(issuedTime).toLocaleString()}</div>` : ''}
  </div>
  ${hashtag ? `<div><span>${Hashtags.formatPubtag(hashtag)}</span></div>` : ''}
</div>`;
  }
  formatObserverPost() { // Answer HTML for the main post as seen by observers (not author).
    const {issuedTime, originalPosting, hashtag, act, message}  = this;
    return `${this.formatAttribution({act, issuedTime, originalPosting, hashtag})}<p>${message || Marker.noMessage}</p>`;
  }
  formatOwnerPost() { // Answer HTML for main post as seen by the author.
    const {issuedTime, originalPosting, hashtag, act, message, replies} = this;
    const messageValueAttribute = message ? `value="${message}"` : '';
    const radioDisabled = replies.length ? 'disabled' : '';
    const publishChoices = Hashtags.getSubscribe()
	  .map(tag => `<label><md-radio ${radioDisabled} name="pub" value="${tag}" ${tag === hashtag ? 'checked' : ''}></md-radio> ${tag}</label>`)
	  .join('');

    return `${this.formatAttribution({act, issuedTime, originalPosting, hashtag})}
<div class="post-input">
  <md-outlined-text-field class="post-input" type="textarea" label="${Int`post here`}"${messageValueAttribute}></md-outlined-text-field>
  <form>${publishChoices}</form>
</div>
<div class="actions">
  <md-outlined-button><md-icon slot="icon" class="material-icons">delete</md-icon> ${Int`remove`}</md-outlined-button>
  <md-filled-button disabled><md-icon slot="icon" class="material-icons">check</md-icon> ${Int`update`}</md-filled-button>
</div>`;
  }
  initializeOwnerPopupHandlers(popup) { // Set up handlers for the owner.
    const {lat, lng, subject, hashtag} = this;
    const popupElement = popup.getElement();
    const postInput = popupElement.querySelector('md-outlined-text-field');
    const publishChoices = popupElement.querySelector('form');
    const cancelButton = popupElement.querySelector('md-outlined-button');
    const updateButton = popupElement.querySelector('md-filled-button');
    postInput.addEventListener('input', event => {
      resetInactivityTimer();      
      this.enableUpdate(popupElement);
    });
    publishChoices.addEventListener('change', event => { // Do not re-publish yet, but do change tag display.
      const tag = event.target.value;
      const html = Hashtags.formatPubtag(tag);
      popupElement.querySelector('span').innerHTML = html;
      resetInactivityTimer();
      this.enableUpdate(popupElement);
    });
    cancelButton.onclick = event=> {
      resetInactivityTimer();
      event.stopPropagation();
      publish({lat, lng, subject, hashtag, payload: null, cancel: null});
    };
    updateButton.onclick = event=> {
      resetInactivityTimer();
      event.stopPropagation();
      popup.close();
      this.maybeUpdate(popupElement);
    };
  }
  enableUpdate(popupElement) { // The owner has changed something. Allow update.
    const button = popupElement.querySelector('md-filled-button');
    if (!button.hasAttribute('disabled')) return;
    button.removeAttribute('disabled');
    popupElement.querySelector('.times').insertAdjacentHTML("beforeend", Int`for update to...`);
  }
  maybeUpdate(displayElement) { // If data has changed, republish.
    const {lat, lng, hashtag, subject, message = '', issuedTime, originalPosting = issuedTime} = this;
    let newMessage = displayElement.querySelector('md-outlined-text-field').value;
    const newHashtag = displayElement.querySelector('span').textContent;
    const isNewHashtag = newHashtag !== hashtag;
    console.log({lat, lng, subject, message, newMessage, hashtag, newHashtag, isNewHashtag});
    if (newMessage === message && !isNewHashtag) return;
    let cancel = null;
    if (isNewHashtag) {
      Hashtags.setPublish(newHashtag);
      Hashtags.onchange({redisplaySubscribers: false, resetSubscriptions: false});
      cancel = {lat, lng, hashtag, subject};
    }
    publish({lat, lng, subject, message: newMessage, originalPosting, cancel}); // immediate for canceled and new, before we remove old hash
  }

  // Each reply is separately published by its author, and only they can modify/unpublish it.
  replies = [];
  handleReply(data) { // Add or update reply for this marker.
    // TODO: handle update/removal.
    const { replies } = this;
    replies.push(data);
    replies.sort((a, b) => a.issuedTime - b.issuedTime); // Could be slightly out of order.
    this.needsRedisplay = true;
    this.ensureContent();
  }
  postReply(event) { // Post a reply to this marker's subject, in response to a text-field change event.
    const eventName = this.subject;
    const reply = event.target.value.trim();
    event.target.value = '';
    if (!reply) return;
    networkPromise.then(async contact => contact.publish({eventName, payload: reply, subject: uuidv4(), act: usertag}));
  }
  formatReplies() { // Answer HTML for the replies and input box.
    const { replies, act, originalPosting } = this;
    const isEnabled = act !== usertag || originalPosting || replies.length;
    const formattedReplies = replies
	  .map(({subject, payload, ...rest}) =>
	    `<div class="reply ${subject}">${this.formatAttribution(rest)}<span class="message">${payload}</span><div>`)
	  .join('');
    return `
<div class="replies">${formattedReplies}</div>
<md-outlined-text-field class="reply-input" ${isEnabled ? '' : 'disabled'} label="${Int`reply here`}"></md-outlined-text-field>`;
  }

  startFader(remaining) { // Set up or update fader.
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
  destroy() { // Remove this Marker pin entirely.
    clearInterval(this.fader);
    // Unsubscribe from replies.
    networkPromise.then(async contact => contact.subscribe({eventName: this.subject, handler: null}));
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
  setTimeout(() => yourLocation.setLatLng(latLng), 100); // It seems that yourLocation can be set, but not yet ready to be moved?
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
    zoomControl: navigator.maxTouchPoints <= 1, // Only when no multi-touch.
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

