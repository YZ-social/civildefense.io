const { L, jdenticon, domtoimage, localStorage, URL, URLSearchParams, FileReader, File } = globalThis; // Leaflet namespace, for linters.
import { v4 as uuidv4 } from 'uuid';
import { s2 } from 's2js';
import { Node } from '@yz-social/kdht';
import { Int } from './translations.js';
import { networkPromise, resetInactivityTimer, delay } from './main.js';
import { Hashtags } from './hashtags.js';
import { getContainingCells, findCoverCellsByCenterAndPoint } from './s2.js';

export let map; // Leaflet map object.
const ttl = 24 * 60 * 60e3; // 24 hours

const infoBanner = document.getElementById('info');
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
    setTimeout(() => infoBanner.style.display = 'none', 4000);
  }
}

async function dataURL2file(url, name) {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], name, {type: blob.type});
}
export async function share(properties) {  // Invoke platform share API on properties.
  if (!navigator.share) {
    showMessage(navigator.userAgent.includes('Firefox') ? Int`In Firefox, sharing must be explicitly enabled through the <a target="civildefense_help" href="https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Experimental_features#webshare_api">dom.webshare.enabled</a> preference in about:config.` : Int`This browser does not support sharing.`);
    return;
  }
  if (properties.files) {
    if (!navigator.canShare) {
      showMessage(Int`This browser does not support file sharing.`);
      return;
    }
    if (!navigator.canShare({files: properties.files})) {
      showMessage(Int`This browser does not support sharing this type of file.`);
      return;
    }
  }
  if (!properties.files) {
    const target = document.getElementById('mapCapture');
    const icon = target.lastElementChild;
    icon.style = 'opacity: 1';
    const capture = await domtoimage.toPng(target);
    icon.style = '';
    const file = await dataURL2file(capture, 'map.png');
    console.log({capture, file});
    properties.files = [file];
  }
  navigator.share({title: "CivilDefense.io", ...properties})
    .catch(error => { if (!['AbortError', 'InvalidStateError'].includes(error.name)) throw error; });
}

const usertag = localStorage.getItem('usertag') || uuidv4();
localStorage.setItem('usertag', usertag);

function makeEventName(cell, hash) { // Include the outgoing hashtag (first of hashtags) in the pubsub eventName
  return `s2:${cell}:${Hashtags.canonicalTag(hash)}`;
}
export function getShareableURL(subject = null, tags = Hashtags.getSubscribe().toString()) { // Answer a url that reflects application state.
  const params = new URLSearchParams(location.search);
  const zoom = map.getZoom();
  const { lat, lng } = map.getCenter();

  params.set('tags', tags);
  if (lat !== null) params.set('lat', lat);
  if (lng !== null) params.set('lng', lng);
  if (zoom !== null) params.set('z', zoom);
  if (subject !== null) params.set('sub', subject);
  return new URL(`?${params.toString()}`, location);
}

let subscriptions = []; // array of stringy keys s2:<cellID>:<hashtag>
// We do not record exactly where you were looking across sessions, but we do record the containing level 9 cell.
let lastLevel9Cell; // S2 level 9 cells average a radius of about 10km ~ 6.5 miles.
export function updateSubscriptions(oldKeys = subscriptions) { // Update current subscriptions to the new map bounds.
  // A value of [] passed for oldKeys is used to start things off fresh (i.e., without supressing subscription of any carry-overs).
  if (!networkPromise) { console.warn("No network through which to subscribe."); return; } // Does this ever happen? Why?
  const center = map.getCenter();
  const bounds = map.getBounds();
  const northEast = bounds.getNorthEast();
  const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
  const newKeys = newCells.flatMap(cell => Hashtags.getSubscribe().map(hash => makeEventName(cell, hash)));

  // Record a zoomed-out cell id in case next session does not have geolocation services.
  let level9Cell = getContainingCells(center.lat, center.lng)[9];
  if (level9Cell !== lastLevel9Cell) localStorage.setItem('level9Cell', lastLevel9Cell = level9Cell);

  console.log('subscribing', {newKeys, length: newKeys.length, oldKeys});
  const subscribe = (key, handler, autoRenewal = false) =>
	networkPromise.then(async contact => contact.subscribe({eventName: key, handler, autoRenewal}));

  // For each entry in the new subscription set that was not previously subscribed, subscribe now.
  for (const key of newKeys) oldKeys.includes(key) || subscribe(key, data => Marker.ensure(data), true);

  // For each existing subscription, if it does not appear in the new set then unsubscribe.
  for (const key of oldKeys) newKeys.includes(key) || subscribe(key, null);

  subscriptions = newKeys;
}

let last = null; // Last published lat, lng, subject
async function publish({lat, lng, // Publish the given data to all applicable eventNames, promising subject.
			originalPosting = undefined,
			hashtag = Hashtags.getPublish(),
			subject  = uuidv4(), // For recognizing locally executed events and for cancelling. Not a user tag!
			payload = {lat, lng, originalPosting}, // If payload is null (cancels subject), lat & lng are still used to generate eventNames.
			cancel = last, // First unpublish the specified data, if any.
			issuedTime = Date.now(),
			immediate = true,  // Whether to act locally before sending.
			...rest
		       }) {
  // We call all the publishing at once and return subject, without waiting for each to occur.
  // However, the 'unpublishing' (if any) is invoked first.
  // To do this, we must hash the eventName ourselves.

  const contact = await networkPromise; // subtle: The rest of this all happens synchronously, with any null payloads definitely first.
  const act = usertag;
  let oldCells = null, oldHash, oldSubject = null; // Recorded for logging, below.
  if (cancel) {
    const {lat, lng, hashtag, subject} = cancel;
    const time = issuedTime - 1;
    oldCells = getContainingCells(lat, lng);
    oldHash = hashtag; oldSubject = subject;
    for (const cell of oldCells) {
      const eventName = makeEventName(cell, hashtag);
      const key = await Node.key(eventName);
      // Note: we cannot unpublish replies by others, but they expire after a while anyway.
      contact.publish({eventName, key, subject, payload: null, issuedTime: time, hashtag, act, immediate, ...rest});
    }
  }

  const cells = getContainingCells(lat, lng);
  last = payload && {lat, lng, hashtag, subject}; // Capture the new subject and eventName data for next time.
  for (const cell of cells) {
    const _level = s2.cellid.level(cell); // add _level for debugging
    const eventName = makeEventName(cell, hashtag);
    const key = await Node.key(eventName);
    contact.publish({eventName, key, subject, payload, _level, issuedTime, hashtag, act, immediate, ...rest});
  }
  console.log('published', {cells, n: cells.length, hashtag, subject, payload, oldCells, oldHash, oldSubject});
  return subject;
}

let openOnReceive = null;
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
  static makeIcon(hashtag) { // Return a Leaflet icon
    return L.divIcon({
      html: Hashtags.formatMarker(hashtag),
      iconSize: [40, 40],
      popupAnchor: [0, 0],
      className: 'alert-pin'
    });
  }
  static updateMarkers(canonicalHashtag, extendedHashtag) { // Update markers becase we have discovered an extendedHashtag that we have only had as canonical.
    for (const wrapper of Object.values(this.markers)) {
      const { hashtag, marker, act } = wrapper;
      if (hashtag !== canonicalHashtag) continue;
      const newIcon = this.makeIcon(extendedHashtag);
      const popup = marker.getPopup();
      marker.setIcon(newIcon);
      wrapper.hashtag = extendedHashtag;
      wrapper.needsRedisplay = true; // See comment for initializeHandlers. We need to clear and rebuild content on re-open.
      if (!popup.isOpen()) continue;
      // Fix what's showing now without flashing everything. Make sure menu works.
      const popupAttribution = popup.getElement().querySelector('.attribution');
      const attributionActions = popupAttribution.lastElementChild;
      attributionActions.lastChildElement.remove();
      popupAttribution.insertAdjacentHTML('beforeend', this.formatAttributionHashtag(act, extendedHashtag));
      wrapper.initChangeHashtag(popupAttribution);
    }
  }
  static ensure(data) { // Add marker at position with appropriate fade if not already present.
    let { payload, subject, issuedTime, act, hashtag, immediateLocalAction = false } = data;
    let wrapper = this.markers[subject]; // We are relying on the "same" data hashing in the same way as a property indicator.
    console.log('handling event', {wrapper, subject, payload, act, usertag, immediateLocalAction, data});

    if (!payload) return wrapper?.destroy();
    const now = Date.now(),
	  expiration = issuedTime + ttl,
          remaining = expiration - now;
    if (remaining < 0) return wrapper?.destroy();  // Expired.

    hashtag = Hashtags.add(hashtag); // We already have it and are subscribing, but this updates our extended form if needed.
    wrapper ||= this.markers[subject] = new this();
    const {lat, lng, originalPosting} = payload;
    Object.assign(wrapper, {lat, lng, subject, originalPosting, issuedTime, hashtag, act});
    let {marker} = wrapper;
    if (!marker) {
      const icon = this.makeIcon(hashtag);
      marker = wrapper.marker = L.marker([lat, lng], {icon, autoPan: false}).addTo(map);
      marker.bindPopup('', {className: 'alert'})
	.on('popupopen', event => wrapper.ensureContent(event.popup, remaining));
      // Subscribe to replies to this subject, now that we're set up to receive them.
      networkPromise.then(async contact => contact.subscribe({eventName: subject, autoRenewal: true, handler: data => wrapper.handleReply(data)}));
      if (subject === openOnReceive) {
	openOnReceive = false;
	marker.openPopup();
      }
    } else {
      wrapper.needsRedisplay = true;
      wrapper.ensureContent();
    }
    wrapper.startFader(remaining); // From the new value of remaining, after marker is set in wrapper, regardless of popup/dirty state.
    return wrapper;
  }
  needsRedisplay = true;
  ensureContent(popup = this.marker.getPopup()) { // Set content and handlers in popup if/as needed.
    if (!popup.isOpen()) return;
    if (!this.needsRedisplay) {
      this.initializeHandlers(popup);
      return;
    }
    this.needsRedisplay = false;
    const {issuedTime, originalPosting, hashtag, act}  = this;
    let content = this.formatAttribution({act, issuedTime, originalPosting, hashtag});
    content += this.formatReplies();
    popup.setContent(content);
    this.initializeHandlers(popup);
  }
  initializeHandlers(popup) { // subtle: Leaflet pupup will recreate from last setContent string. Need to re-establish handlers.
    const popupElement = popup.getElement();
    const replyInput = popupElement.querySelector('.reply-input');
    const replyButton = replyInput.querySelector('md-filled-icon-button');
    const replyAttachButton = replyInput.querySelector('md-tonal-icon-button');
    const fileChooser = popupElement.querySelector('input[type="file"]');
    replyInput.oninput = event => { replyButton.removeAttribute('disabled'); };
    replyButton.onclick = event => { this.postReply(event); };
    replyAttachButton.onclick = event => { resetInactivityTimer(); fileChooser.click(); };
    fileChooser.onchange = event => {
      resetInactivityTimer();
      replyButton.removeAttribute('disabled');
      let filenameDisplay = popupElement.querySelector('.attachment-preview');
      filenameDisplay.textContent = fileChooser.files.length ? (fileChooser.files[0].name || 'image') : '';
    };
    this.initChangeHashtag(popupElement);
    for (const deleter of popupElement.querySelectorAll('.reply .attribution md-outlined-button')) {
      deleter.onclick = event => { // Delete reply.
	event.stopPropagation();
	this.deleteReply(event.currentTarget.closest('.reply'));
      };
    }
    const shareable = popupElement.querySelectorAll('.share');
    for (const element of shareable) element.onclick = event => this.share(event);
  }
  initChangeHashtag(someParent) { // Init handler on the menu button, if any
    const changeHashtag = someParent.querySelector('.changeHashtag');
    if (!changeHashtag) return;
    const menu = document.getElementById('popoverMenu');
    menu.anchorElement = changeHashtag;
    changeHashtag.onclick = event => {
      resetInactivityTimer();
      event.stopPropagation();
      menu.open = !menu.open;
    }; // Must be onlick rather than addEventListener.
    menu.onclick = event => { event.stopPropagation(); };
    menu.addEventListener('close-menu', this.menuCloser); // Must be addEventListener because there's no onclosemenu.
  }
  menuCloser = event => this.updatePost(event.detail.initiator.dataset.tag);
  static formatAttributionHashtag(act, hashtag) { // Answer HTML for the hashtag button/display in an a post attribution.
    // It will be either a simple HTML element with pubtag.
    const pubtag = Hashtags.formatPubtag(hashtag);
    if (act !== usertag) return `<span>${pubtag}</span>`;

    // ... or an HTML button, with a side-effect of populating the popoverMenu with the choices to display when the button is pressed.
    document.getElementById('popoverMenu').innerHTML = `
   ${Hashtags.getSubscribe().map(tag => `<md-menu-item class:"pubtag-choice" data-tag="${tag}"><div slot="headline">${Hashtags.formatPubtag(tag)}</div></md-menu-item>`).join('')}
   <md-divider></md-divider>
   <md-menu-item data-tag="" class="remove">
     <md-icon slot="end" class="material-icons">delete_forever</md-icon>
     <div slot="headline">${Int`remove`}</div>
     <div slot="supporting-text">${Int`cancel alert`}</div></md-menu-item>
`;
    return `<md-outlined-button class="changeHashtag">${pubtag}</md-outlined-button>`;
  }
  formatAttributionActions({act, hashtag}) { // Anser div HTML containing: [deleter] sharer [hashtag]
    // Where deletere appears if it our reply (no hashtag), and hashtag if present is a button if ours (and otherwise just text).
    const deleter = !hashtag && act === usertag ? `<md-outlined-button><md-icon class="material-icons">delete_forever</md-icon></md-outlined-button>` : '';
    const sharer = `<md-outlined-button class="share"><md-icon class="material-icons">ios_share</md-icon></md-outlined-button>`;
    const pubtag = hashtag ? this.constructor.formatAttributionHashtag(act, hashtag) : '';
    return `<div>${deleter} ${sharer} ${pubtag}</div>`;
  }
  formatAttribution({act, issuedTime, originalPosting, hashtag = null}) { // Answer HTML for a row of sender/timestamp(s)/[deleter]+sharer+[hashtag]
    const actions = this.formatAttributionActions({act, hashtag});
    const dataText = hashtag ? 'data-text=""' : ''; // Used in sharing.
    return `
<div class="attribution" ${dataText}>
  <minidenticon-svg username="${act}"></minidenticon-svg>
  <div class="times">
    <div>${new Date(originalPosting || issuedTime).toLocaleString()}</div>
    ${originalPosting ? `<div>${Int`updated`} ${new Date(issuedTime).toLocaleString()}</div>` : ''}
  </div>
  ${actions}
</div>`;
  }
  updatePost(tag) { // Republish under a different hashtag, or cancel altogether if no tag (which is not allowed as a hashtag).
    resetInactivityTimer();
    const {lat, lng, hashtag, subject, issuedTime, originalPosting = issuedTime} = this;
    if (!tag) return publish({lat, lng, subject, hashtag, payload: null, cancel: null});
    if (tag === hashtag) return this.needsRedisplay = true;
    const cancel = {lat, lng, hashtag, subject};
    Hashtags.setPublish(tag);
    Hashtags.onchange({redisplaySubscribers: false, resetSubscriptions: false});
    return publish({lat, lng, subject, originalPosting, cancel}); // immediate for canceled and new, before we remove old hash
  }

  // Each reply is separately published by its author, and only they can modify/unpublish it.
  replies = [];
  handleReply(data) { // Add or update reply for this marker.
    // TODO: handle update/removal.
    const { replies } = this;
    if (data.payload) {
      replies.push(data); // TODO: when we implement edited replies, we'll have to find the existing
      replies.sort((a, b) => a.issuedTime - b.issuedTime); // Could be slightly out of order.
    } else {
      replies.splice(replies.findIndex(reply => reply.subject === data.subject), 1);
    }
    this.needsRedisplay = true;
    this.ensureContent();
  }
  async postReply(event) { // Post a reply to this marker's subject, in response to a text-field change event.
    resetInactivityTimer();
    const eventName = this.subject;
    const button = event.target;
    const inputElement = button.parentElement;
    let payload = inputElement.value.trim();
    const files = inputElement.parentElement.querySelector('input[type="file"]').files;
    if (files.length) {
      await new Promise(resolve => {
	const reader = new FileReader();
	reader.onerror = () => resolve(showMessage(reader.error.message || reader.error.name || "Error reading attachment"));
	reader.onload = () => {
	  payload = {message: payload, file: reader.result, name: files[0].name};
	  resolve();
	};
	reader.readAsDataURL(files[0]);
      });
    }
    inputElement.value = '';
    inputElement.querySelector('md-filled-icon-button').toggleAttribute('disabled', true);
    if (!payload) return;
    networkPromise.then(contact => contact.publish({eventName, payload, subject: uuidv4(), act: usertag}));
  }
  deleteReply(replyElement) {
    resetInactivityTimer();
    networkPromise.then(contact => contact.publish({eventName: this.subject, subject: replyElement.dataset.subject, payload: null, act: usertag}));
  }
  formatReplies() { // Answer HTML for the replies and input box.
    const { replies, act, originalPosting } = this;
    const formatReply = ({subject, payload, ...rest}) => {
      const {message = payload, file, name} = payload;
      let text = message.replace(/https?:\/\/\S+/g, url => `<a href="${url}" target="yz.sidebar">${url}</a>`); // show urls as links
      let attachment = '';
      if (file?.startsWith('data:image')) attachment = `<img class="attachment" src="${file}"></img>`;
      else if (file) attachment = `
<span class="attachment ${message ? '' : 'message'}">
  <md-icon class="material-icons">attachment</md-icon>
  ${name}
</span>`;
      const messageDisplay = message ? `<span class="message">${text}</span>` : '';
      let dataAttributes = `data-subject="${subject}" data-text="${message}"`;
      if (file) dataAttributes += ` data-file="${file}" data-name="${name}"`;
      return `<div class="reply" ${dataAttributes}>${this.formatAttribution(rest)}${attachment}${messageDisplay}</div>`;
    };
    const formattedReplies = replies.map(formatReply).join('');
    return `
<div class="replies">${formattedReplies}</div>
<div class="attachment-preview"></div>
<md-outlined-text-field class="reply-input" label="${Int`reply here`}">
  <md-tonal-icon-button slot="leading-icon">
    <md-icon class="material-icons">attach_file</md-icon>
  </md-tonal-icon-button>
  <md-filled-icon-button disabled slot="trailing-icon">
    <md-icon class="material-icons">send</md-icon>
  </md-filled-icon-button>
</md-outlined-text-field>
<input type="file"></input>`;
  }

  async share(event) { // Share reply or post
    resetInactivityTimer();
    // TODO: Preserve attribution data. Maybe by including the subject reply tag in the url, and metadata in the text?
    const shareable = event.currentTarget.closest('[data-text]');
    const {text, file, name = 'unknown'} = shareable.dataset;
    const {lat, lng} = this;
    console.log('share', shareable.dataset);
    const url = getShareableURL(this.subject, [this.hashtag]).href;
    let textBase = `New CivilDefense.io alert @${lat},${lng}`;
    const extendedText = text ? `${textBase}\n${text}` : textBase;
    const data = {text: extendedText, url};
    Marker.closePopup();
    if (file) data.files = [await dataURL2file(file, name)];
    else await delay(500); // Allow popup time to close. It doesn't render well because of the web component style sheets.
    share(data);
  }
  startFader(remaining) { // Set up or update fader.
    // It would be nice to use CSS transitions, but, that's not the API presented by L.marker.
    const minOpacity = 0.25;
    const interval = 2000; // milliseconds per adjustment (a tiny increment at a time)
    const fade = (1 - minOpacity) * interval / ttl; // Change in opacity per adjustment.
    const { marker } = this;
    let opacity = remaining / ttl; // Do not start at 1 if it was reported some time ago.
    marker.setOpacity(opacity);
    clearInterval(this.fader);
    clearInterval(this.destroyer);
    this.fader = setInterval(() => {
      marker.setOpacity(opacity -= fade);
      if (opacity < minOpacity) clearInterval(this.fader);
    }, interval);
    this.destroyer = setTimeout(() => this.destroy(), remaining);
  }
  destroy() { // Remove this Marker pin entirely.
    clearInterval(this.fader);
    // Unsubscribe from replies.
    networkPromise?.then(async contact => contact.subscribe({eventName: this.subject, handler: null}));
    this.marker.removeFrom(map);
    delete this.constructor.markers[this.subject];
  }
}

let yourLocation; // marker
let lastLatitude, lastLongitude;

export function updateLocation(lat, lng, zoom) { // initMap if necessary, and set our position.
  //console.log('updateLocation', lat, lng);
  // Can't call getCurrentPosition while watching. So set it here for use in recenterMap.
  lastLatitude = lat;
  lastLongitude = lng;

  if (!map) {
    initMap(lat, lng, zoom);

    const params = new URL(location).searchParams;
    params.get('tags')?.split(',').forEach(tag => Hashtags.add(tag));
    Hashtags.onchange({resetSubscriptions: false}); // Too early to subscribe, but will be done during initialization.
    if (params.has('lat') && params.has('lng')) {
      map.flyTo({lat: params.get('lat'), lng: params.get('lng')}, params.get('z'));
    }
    openOnReceive = null;
    const subject = params.get('sub');
    if (subject) Marker.openPopup(subject) || (openOnReceive = subject);
    // We don't need the query parameters now. Get rid of them. They're annoying. But preserve dht, if any.
    const copy = new URL(location);
    const dht = copy.searchParams.get('dht');
    if (copy.searchParams.size > (dht ? 1 : 0)) {
      copy.search = dht ? `?dht=${dht}` : '';
      history.replaceState(null, '', copy);
    }

    return;
  }
  // Otherwise just update the yourLocation marker if appropriate (and not update zoom).

  // setLatLng can cause the map to autoPan to put the marker within bounds.
  // It seems like that shouldn't happen with autoPan:false, above, but it does.
  // So let's not even update it if it is outside the displayed area.
  // However, that means we will need to updateLocation from the last position on map moveend.
  if (!map.getBounds().contains(L.latLng(lat, lng))) return;

  const latLng = [lat, lng];
  setTimeout(() => yourLocation.setLatLng(latLng), 100); // It seems that yourLocation can be set, but not yet ready to be moved?
}

export function recenterMap() {
  resetInactivityTimer();
  Marker.closePopup();
  const latLng = [lastLatitude, lastLongitude];
  map.flyTo(latLng);
}

export function initMap(lat, lng, zoom) { // Set up appropriate zoomed initial map and handlers for this position.
  // Then show initial message and updateSubscriptions.

  showMessage(Int`Getting your location...`);

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
  const popupPane = document.querySelector('.leaflet-popup-pane');
  popupPane.insertAdjacentHTML('beforebegin', `
    <div class="about-container">
      <div class="about-text">About</div>
      <button id="aboutButton" class="about-button">
        <img src="images/civil-defense-240.png" alt="civildefense" class="about-image"></img>
      </button>;
    </div>`);
  const aboutContent = document.getElementById('aboutContent');
  const mapElement = document.querySelector('#map');
  const mapPane = document.querySelector('.leaflet-map-pane');
  const aboutContainer = document.querySelector('.about-container');
  const adjust = mapElement.clientWidth - aboutContainer.clientWidth - 10;
  map.on('move', () => {
    const rect = mapPane.getBoundingClientRect();
    aboutContainer.style = `left: ${adjust - rect.left}px; top: ${-rect.top}px;`;
  });
  document.getElementById('aboutButton').onclick = event => {
    resetInactivityTimer();
    event.stopPropagation();
    Marker.closePopup();
    aboutContent.classList.toggle('hidden', false);
  };
  aboutContent.onclick = () => {
    resetInactivityTimer();
    aboutContent.classList.toggle('hidden', true);
  };

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
  map.on('click', async function(e) {
    resetInactivityTimer();
    const { lat, lng } = e.latlng;
    Marker.openPopup(await publish({lat, lng}));
  });

  showMessage(Int`Tap anywhere to mark a concern. Markers fade after 24 hours.`, 'instructions');
}

