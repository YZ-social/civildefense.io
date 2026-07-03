const { domtoimage, localStorage, URL, File, URLSearchParams, getComputedStyle } = globalThis;
import * as L from 'leaflet';
import { Int } from './translations.js';
import { consume, openDisplay } from './display.js';
import { alertTopic } from './versions.js';
import { Agent } from './agent.js';
import { P2PWebNetwork } from './p2pWebNetwork.js';
import { networkPromise, resetInactivityTimer, delay, notificationsAllowed, openAbout } from './main.js';
import { Hashtags } from './hashtags.js';
import { getContainingCells, findCoverCellsByCenterAndPoint } from './s2.js';

export let map; // Leaflet map object.
const ttl = 24 * 60 * 60e3; // 24 hours

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

export async function dataURL2file(url, name) { // Promise a File object corresponding to the given dataURL and file name string.
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
    Marker.closePopup();
    await delay(500); // Allow popup time to close. It doesn't render well because of the web component style sheets.
    const target = document.getElementById('mapCapture');
    const icon = target.lastElementChild;
    const subPopoverControls = document.getElementById('subPopoverControls');
    const leafletControls = document.querySelector('.leaflet-control-container');
    subPopoverControls.style = leafletControls.style = 'opacity: 0;';
    icon.style = 'opacity: 1;';
    const capture = await domtoimage.toPng(target);
    subPopoverControls.style = leafletControls.style = icon.style = '';
    const file = await P2PWebNetwork.dataURL2blob(capture, 'map.png');
    trackMap();
    properties.files = [file];
  }
  navigator.share({title: "CivilDefense.io", ...properties})
    .catch(error => { if (!['AbortError', 'InvalidStateError'].includes(error.name)) throw error; });
}

export function makeEventName(cell, hash) { // Include the outgoing hashtag (first of hashtags) in the pubsub eventName
  return `civildefense.io:${Agent.networkVersion}:${cell}:${Hashtags.canonicalTag(hash)}`;
}
export function getShareableURL(subject = null, tags = Hashtags.getSubscribe()) { // Answer a url that reflects application state.
  const params = new URLSearchParams(location.search);
  const zoom = map.getZoom();
  const { lat, lng } = map.getCenter();

  params.set('tags', tags.map(tag => encodeURIComponent(tag)).join(','));
  if (lat !== null) params.set('lat', lat);
  if (lng !== null) params.set('lng', lng);
  if (zoom !== null) params.set('z', zoom);
  if (subject !== null) params.set('sub', subject);
  return new URL(`?${params.toString()}`, location);
}

let subscriptions = []; // array of stringy keys <mumble>:<cellID>:<hashtag>
let subscriptionsRegion;
// We do not record exactly where you were looking across sessions, but we do record the containing level 9 cell.
let lastLevel9Cell; // S2 level 9 cells average a radius of about 10km ~ 6.5 miles.
export function updateSubscriptions(oldKeys = subscriptions, newKeys) { // Update current subscriptions to the new map bounds.
  // A value of [] passed for oldKeys is used to start things off fresh (i.e., without supressing subscription of any carry-overs).
  if (!networkPromise) { console.warn("No network through which to subscribe."); return; } // Does this ever happen? Why?
  let region;
  if (!newKeys) { // None specified. Compute them.
    const center = map.getCenter();
    const bounds = map.getBounds();
    const northEast = bounds.getNorthEast();
    const newCells = findCoverCellsByCenterAndPoint(center.lat, center.lng, northEast.lat, northEast.lng); // array of cell IDs (BigInts)
    region = P2PWebNetwork.regionCode(center.lat, center.lng);
    newKeys = newCells.flatMap(cell => Hashtags.getSubscribe().map(hash => alertTopic(cell, hash)));
    Agent.current.trackPublicChanges(region);
    // Record a zoomed-out cell id in case next session does not have geolocation services.
    let level9Cell = getContainingCells(center.lat, center.lng)[9];
    if (level9Cell !== lastLevel9Cell) localStorage.setItem('level9Cell', lastLevel9Cell = level9Cell);
  }

  const subscribe = (key, region, handler) =>
	networkPromise.then(async contact => contact.subscribe({eventName: key, region, handler}));

  // For each entry in the new subscription set that was not previously subscribed, subscribe now.
  for (const key of newKeys) oldKeys.includes(key) || subscribe(key, region, data => Marker.ensure(data));

  // For each existing subscription, if it does not appear in the new set then unsubscribe.
  for (const key of oldKeys) newKeys.includes(key) || subscribe(key, subscriptionsRegion, null);
  console.log('Subscribed', {newKeys, region, length: newKeys.length, oldKeys, subscriptionsRegion});

  subscriptions = newKeys;
  subscriptionsRegion = region;
}

let last = []; // Last published lat, lng, subject
const maxPublish = 5;
// Publish an alert to all applicable eventNames, canceling as required. Promises subject (msgId).
let publishing = false;
async function publishAlert({lat, lng,
			     originalPosting = undefined,
			     hashtag = Hashtags.getPublish(),
			     payload = {lat, lng, originalPosting}, // If payload is null (cancels subject), lat & lng are still used to generate eventNames.
			     cancel = undefined, // First unpublish the specified data, if any. Complicated default.
			     issuedTime = Date.now(), subject,
			     throttleMS = 0,
			     ...rest
			    }) {
  // We call all the publishing at once and return subject, without waiting for each to occur.
  // However, the 'unpublishing' (if any) is invoked first.
  // To do this, we must hash the eventName ourselves.
  //console.log('publishAlert', {lat, lng, hashtag, payload, cancel, subject, issuedTime, rest});
  if (publishing) { console.log('skiping overlappying publish'); return; } // do not stack them up.
  try {
    publishing = true;

    const contact = await networkPromise; // subtle: The rest of this all happens synchronously, with any null payloads definitely first.
    let oldCells = null, oldHash, oldSubject = null; // Recorded for logging, below.
    let lastFillIn;
    if (payload) {
      lastFillIn = {lat, lng, hashtag, issuedTime};
      last.push(lastFillIn); // Capture the added data.
      const periodStart = Date.now() - (maxPublish * 60e3); // maxPublish minutes ago.
      last = last.filter(past => past.issuedTime >= periodStart);
      if (cancel === undefined && last.length > maxPublish) { // Unless specified otherwise, cancel oldest over maxPublish.
	showMessage(Int`Too many posts. (5 allowed every 5 minutes.) Removing oldest from this period.`);
	cancel = last.shift();
      }
    }
    if (cancel) {
      const {lat, lng, hashtag, subject} = cancel;
      oldCells = getContainingCells(lat, lng);
      oldHash = hashtag; oldSubject = subject;
      const region = P2PWebNetwork.regionCode(lat, lng);
      for (const cell of oldCells) {
	const eventName = alertTopic(cell, hashtag);
	// Note: we cannot unpublish replies by others, but they expire after a while anyway.
	await contact.publish({eventName, region, subject, payload: null});
	throttleMS && await P2PWebNetwork.delay(throttleMS);
      }
    }

    const cells = getContainingCells(lat, lng);
    const region = P2PWebNetwork.regionCode(lat, lng);
    for (const cell of cells) {
      const eventName = alertTopic(cell, hashtag);
      if (payload) {
	const msgId = await contact.publish({eventName, region, payload, issuedTime, hashtag, ...rest});
	if (subject && subject !== msgId) throw new Error(`msgId is drifting: ${subject} => ${msgId}`);
	subject = msgId;
	if (lastFillIn) {
	  lastFillIn.subject = subject;
	  lastFillIn = null;
	}
      } else {
	await contact.publish({eventName, region, subject, payload: null});
	throttleMS && await P2PWebNetwork.delay(throttleMS);
      }
    }
    if (!payload) {
      const index = last.findIndex(past => past.subject === subject);
      if (index >= 0) last.splice(index, 1);
    }
    console.log('Published', {cells, n: cells.length, region, hashtag, subject, payload, oldCells, oldHash, oldSubject});
    return subject;
  } finally {
    publishing = false;
  }
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
    wrapper?.openPopup();
  }
  async openPopup() { // Open this wrapper's popup, and resolve any waiting promise.
    const { resolveGo } = this; // A handy hook for scripting.
    if (resolveGo) {
      resolveGo(this);
      delete this.resolveGo;
      await delay(100);
    }
    this.marker.openPopup();
  }
  static makeIcon(hashtag) { // Return a Leaflet icon
    return L.divIcon({
      html: `<div class="alert-commented"></div><div class="alert-pin">${Hashtags.formatMarker(hashtag)}</div>`,
      iconSize: [40, 40],
      popupAnchor: [0, 0],
      className: 'alert-marker'
    });
  }
  static updateMarkers(canonicalHashtag, extendedHashtag) { // Update markers becase we have discovered an extendedHashtag that we have only had as canonical.
    for (const wrapper of Object.values(this.markers)) {
      const { hashtag, marker, agent } = wrapper;
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
      attributionActions.lastElementChild.remove();
      attributionActions.insertAdjacentHTML('beforeend', this.formatAttributionHashtag(agent, extendedHashtag));
      wrapper.initChangeHashtag(popupAttribution);
    }
  }
  static ensure(data) { // Add marker at position with appropriate fade if not already present.
    let { payload, subject, issuedTime, agent, hashtag} = data;
    let wrapper = this.markers[subject]; // We are relying on the "same" data hashing in the same way as a property indicator.
    console.log('Handling event', {wrapper, hashtag, subject, payload, agent, usertag: Agent.tag, data});

    if (!payload) return wrapper?.destroy();
    const now = Date.now(),
	  expiration = issuedTime + ttl,
          remaining = expiration - now;
    if (remaining < 0) return wrapper?.destroy();  // Expired.

    hashtag = Hashtags.add(hashtag); // We already have it and are subscribing, but this updates our extended form if needed.
    wrapper ||= this.markers[subject] = new this();
    const {lat, lng, originalPosting} = payload;
    // TODO: Now that msgId is the same at each level, there's no reason for a separate GUID subject.
    const region = P2PWebNetwork.regionCode(lat, lng);
    Object.assign(wrapper, {lat, lng, subject, originalPosting, issuedTime, hashtag, agent, region});
    let {marker} = wrapper;
    if (!marker) {
      const icon = this.makeIcon(hashtag);
      marker = wrapper.marker = L.marker([lat, lng], {icon, autoPan: false}).addTo(map);
      marker.bindPopup('', {className: 'alert'})
	.on('popupopen', event => wrapper.ensureContent(event.popup));
      // Subscribe to replies to this subject, now that we're set up to receive them.
      networkPromise.then(async contact => contact.subscribe({eventName: subject, region, handler: data => wrapper.handleReply(data)}));
      if (subject === openOnReceive) {
	openOnReceive = false;
	wrapper.openPopup();
      }
      wrapper.showNotification({tag: subject, agent, issuedTime});
    } else {
      wrapper.needsRedisplay = true;
    }
    wrapper.startFader('.alert-pin', remaining); // From the new value of remaining, after marker is set in wrapper, regardless of popup/dirty state.
    wrapper.destroyer = setTimeout(() => wrapper.destroy(), remaining);
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
    const {issuedTime, originalPosting, hashtag, agent}  = this;
    this.clearAvatars(popup);
    let content = this.formatAttribution({agent, issuedTime, originalPosting, hashtag});
    content += this.formatReplies();
    popup.setContent(content);
    delay(100).then(() => {
      this.marker.getPopup().update();
      this.initializeHandlers(popup);
    });
    console.warn(`latitude: ${this.lat}, longitude: ${this.lng}`);
  }
  clearAvatars(popup = this.marker?.getPopup()) {
    popup?.getElement()?.querySelectorAll('.correspondent[data-tag]')
      .forEach(element => Agent.ensure({tag: element.dataset.tag}).removeElement(element, 'mixed', element.classList.contains('avatar') ? 'avatar' : 'handle'));
  }
  initializeHandlers(popup) { // subtle: Leaflet pupup will recreate from last setContent string. Need to re-establish handlers.
    const popupElement = popup.getElement();
    const replyInput = popupElement.querySelector('.reply-input');
    const replyButton = replyInput.querySelector('md-filled-icon-button');
    const replyAttachButton = replyInput.querySelector('md-tonal-icon-button');
    const fileChooser = popupElement.querySelector('input[type="file"]');
    replyInput.oninput = event => {
      replyButton.removeAttribute('disabled');
      const input = event.currentTarget;
      const textarea = input.shadowRoot.querySelector('textarea');
      const internalHighWater = Math.round(textarea.scrollHeight / parseFloat(getComputedStyle(textarea).lineHeight));
      input.rows = internalHighWater;
    };
    replyButton.onclick = event => { this.postReply(event); };
    replyAttachButton.onclick = event => { resetInactivityTimer(); fileChooser.click(); };
    fileChooser.onchange = event => {
      resetInactivityTimer();
      replyButton.removeAttribute('disabled');
      let filenameDisplay = popupElement.querySelector('.attachment-preview');
      filenameDisplay.textContent = fileChooser.files.length ? (fileChooser.files[0].name || 'camera') : '';
    };
    this.initChangeHashtag(popupElement);
    for (const correspondent of popupElement.querySelectorAll('.correspondent')) {
      const tag = correspondent.dataset.tag;
      const agent = Agent.ensure({tag, region: this.region});
      const isAvatar = correspondent.classList.contains('avatar');
      if (agent.addElement(correspondent, 'mixed', isAvatar ? 'avatar' : 'handle')) {
	correspondent.onclick = event => {
	  if (tag === Agent.tag) openAbout(event);
	  else agent.describe(event);
	};
      }
    }
    for (const deleter of popupElement.querySelectorAll('.reply .attribution > div:last-child md-outlined-icon-button')) {
      deleter.onclick = event => { // Delete reply.
	consume(event);
	this.deleteReply(event.currentTarget.closest('.reply'));
      };
    }
    const shareable = popupElement.querySelectorAll('.share');
    for (const element of shareable) element.onclick = event => this.share(event);
  }
  initChangeHashtag(someParent) { // Init handler on the menu button, if any, as (re-) init of menu for open popup
    const changeHashtag = someParent.querySelector('.changeHashtag');
    if (!changeHashtag) return;
    const menu = document.getElementById('popoverMenu');
    menu.anchorElement = changeHashtag;
    changeHashtag.onclick = event => {
      consume(event);
      menu.open = !menu.open;
      menu.onclick = consume; // Must be onlick rather than addEventListener.
      const handler = event => {
	menu.removeEventListener('close-menu', handler);
	this.updatePost(event.detail.initiator.dataset.tag);
      };
      menu.addEventListener('close-menu', handler); // Must be addEventListener because there's no onclosemenu.
    };
  }
  static formatAttributionHashtag(agent, hashtag) { // Answer HTML for the hashtag button/display in an a post attribution.
    // It will be either a simple HTML element with pubtag.
    const pubtag = Hashtags.formatPubtag(hashtag);
    if (agent !== Agent.tag) return `<span>${pubtag}</span>`;

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
  formatAttributionActions({agent, hashtag}) { // Anser div HTML containing: [deleter] sharer [hashtag]
    // Where deletere appears if it our reply (no hashtag), and hashtag if present is a button if ours (and otherwise just text).
    const isOurs = agent === Agent.tag;
    const deleter = !hashtag && isOurs ? `<md-outlined-icon-button><md-icon class="material-icons">delete_forever</md-icon></md-outlined-icon-button>` : '';
    const pubtag = hashtag ? this.constructor.formatAttributionHashtag(agent, hashtag) : '';
    if (isOurs && !this.replies.length) showMessage(Int`Change the topic or remove the alert with the topic button in the upper right of the conversation dialog.`, 'instructions');
    return `<div>${deleter} ${pubtag}</div>`;
  }
  formatAttribution({agent, issuedTime, originalPosting, hashtag = null}) { // Answer HTML for a row of sender/timestamp(s)/[deleter]+sharer+[hashtag]
    const sharer = `<md-outlined-icon-button class="share"><md-icon class="material-icons">ios_share</md-icon></md-outlined-icon-button>`;
    const actions = this.formatAttributionActions({agent, hashtag});
    const dataText = hashtag ? 'data-text=""' : ''; // Used in sharing.
    return `
<div class="attribution" ${dataText}>
  ${sharer}
  <md-outlined-icon-button class="correspondent avatar" data-tag="${agent}"></md-outlined-icon-button>
  <div class="attribution-metadata">
    <div class="correspondent handle" data-tag="${agent}"></div>
    <div>${new Date(originalPosting || issuedTime).toLocaleString()}</div>
    ${originalPosting ? `<div>${Int`updated`} ${new Date(issuedTime).toLocaleString()}</div>` : ''}
  </div>
  ${actions}
</div>`;
  }
  updatePost(tag) { // Republish under a different hashtag, or cancel altogether if no tag (which is not allowed as a hashtag).
    resetInactivityTimer();
    const {lat, lng, hashtag, subject, issuedTime, originalPosting = issuedTime} = this;
    if (!tag) return publishAlert({lat, lng, subject, originalPosting, hashtag, payload: null, cancel: null}); // Remove post with null payload, cancel.
    if (tag === hashtag) return this.needsRedisplay = true;
    const cancel = {lat, lng, subject, hashtag}; // Cancel old hashtag as we publish new tag, below.
    Hashtags.setPublish(tag);
    Hashtags.onchange({redisplaySubscribers: false, resetSubscriptions: false});
    return publishAlert({lat, lng, hashtag: tag, originalPosting, cancel}); // Publish new alert w/cancellation.
  }

  // Each reply is separately published by its author, and only they can modify/unpublish it.
  replies = [];
  async handleReply(data) { // Add or update reply for this marker.
    // TODO: handle update/removal.
    const { replies, marker } = this;
    if (data.payload) {
      const existing = replies.find(reply => reply.subject === data.subject);
      if (existing) return; // Until we do editing.

      const {agent, issuedTime, payload} = data;
      const {file} = payload;
      if (file) {
	data.fileTopic = file;
	const contact = await networkPromise;
	// Before pushing data on to replies.
	const {dataURL, name} = await contact.assembleChunkedDataURL(file);
	payload.file = dataURL;
	payload.name = name;
      }
      replies.push(data); // TODO: when we implement edited replies, we'll have to find the existing
      replies.sort((a, b) => a.issuedTime - b.issuedTime); // Could be slightly out of order.
      const element = this.startFader('.alert-commented', issuedTime + ttl - Date.now());
      element.style.display = 'block';
      // Restart the pulse animation by setting animationName to something it isn't.
      element.style.animationName = element.style.animationName === 'pulse2' ? 'pulse' : 'pulse2';
      if (replies[replies.length - 1] !== data) return; // Replies could come out of order.
      this.showNotification({agent, issuedTime, body: payload.message || payload.name || payload});
    } else {
      replies.splice(replies.findIndex(reply => reply.subject === data.subject), 1);
    }
    this.needsRedisplay = true;
    this.ensureContent();
  }
  showNotification({issuedTime = this.issuedTime, body = '', agent = this.agent, tag = this.subject, lat = this.lat, lng = this.lng, hashtag = this.hashtag}) {
    // Give OS notification that comes back to here, unless act is us.
    if (agent == Agent.tag || !notificationsAllowed()) return;
    navigator.serviceWorker.ready.then(registration => {
      const timestamp = issuedTime;
      const icon = new URL('./images/civil-defense-192.png', location.href).href;
      const url = getShareableURL(tag, [hashtag]).href; // For opening page when it has been closed.
      const data = {lat, lng, url};
      const options = {icon, timestamp, tag, body, data};
      console.log('showNotification', hashtag, options);
      registration.showNotification(hashtag, options);
    });
  }
  async postReply(event) { // Post a reply to this marker's subject, in response to a text-field change event.
    resetInactivityTimer();
    event.stopPropagation();
    const button = event.target;
    const inputElement = button.parentElement;
    let payload = inputElement.value.trim();
    const {subject, hashtag, region} = this;
    const files = inputElement.parentElement.querySelector('input[type="file"]').files;
    if (!payload && !files.length) return;
    inputElement.value = '';
    inputElement.querySelector('md-filled-icon-button').toggleAttribute('disabled', true);
    const contact = await networkPromise;
    if (files.length) {
      const file = await contact.chunkifyBlob({blob: files[0], region});
      payload = {message: payload, file};
    }
    await contact.publish({eventName: subject, region, payload}); // Publish the new reply.
    Agent.current.persistPublicMetadata(region);
  }
  deleteReply(replyElement) {
    resetInactivityTimer();
    const {region} = this;
    networkPromise.then(async contact => contact.publish({eventName: this.subject, region, subject: replyElement.dataset.subject, payload: null}));
  }
  formatReplies() { // Answer HTML for the replies and input box.
    const { replies, agent, originalPosting } = this;
    const formatReply = ({subject, payload, ...rest}) => {
      const {message = payload, file, name} = payload;
      let text = message
	  .replace(/https?:\/\/\S+\.(mp3|aac|ogg|oga|opus|m4a|m3u8|mpd)$/ig, url => `<audio controls src="${url}"></audio>`) // show audio urls as players
	  .replace(/https?:\/\/\S+\.(mp4|mov|webm)$/ig, url => `<video controls src="${url}"></video>`) // show video urls as players
	  .replace(/(?<!")https?:\/\/\S+/g, url => `<a href="${url}" target="yz.sidebar">${url}</a>`); // show urls as links
      let attachment = '';
      if (file?.startsWith('data:image')) attachment = `<a href="${file}" download="${name}"><img class="attachment" src="${file}"></img></a>`;
      else if (file?.startsWith('data:audio')) attachment = `<a href="${file}" download="${name}"><audio controls class="attachment" src="${file}"></audio></a>`;
      else if (file?.startsWith('data:video')) attachment = `<a href="${file}" download="${name}"><video controls class="attachment" src="${file}"></video></a>`;
      else if (file) attachment = `
<div class="attachment file">
  <a href="${file}" download="${name}">
    <md-icon class="material-icons">attachment</md-icon>
    ${name}
  </a>
</div>`;
      const messageDisplay = message ? `<span class="message">${text}</span>` : '';
      let dataAttributes = `data-subject="${subject}" data-text="${message}"`;
      if (file) dataAttributes += ` data-file="${file}" data-name="${name}"`;
      return `<div class="reply" ${dataAttributes}>${this.formatAttribution(rest)}${attachment}${messageDisplay}</div>`;
    };
    const formattedReplies = replies.map(formatReply).join('');
    return `
<div class="replies">${formattedReplies}</div>
<div class="attachment-preview"></div>
<md-outlined-text-field class="reply-input" type="textarea" rows="1" label="${Int`reply here`}">
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
    console.log('Share', shareable.dataset);
    const url = getShareableURL(this.subject, [this.hashtag]).href;
    let textBase = `New CivilDefense.io alert @${lat},${lng}`;
    const extendedText = text ? `${textBase}\n${text}` : textBase;
    const data = {text: extendedText, url};
    if (file) data.files = [await P2PWebNetwork.dataURL2blob(file, name)];
    share(data);
  }
  startFader(selector, remaining) { // Set up or update fader on the specified marker element, returning that element.
    const { marker } = this;
    const element = marker.getElement().querySelector(selector);
    const fraction = remaining / ttl; // Start at 1 and go to 0, but we may be some way along that.
    const endOpacity = 0.5; // Fully transparent is 0, but that's too hard to see. :-)
    const endGrayscale = 1; // Fully gray.
    let opacity = Math.max(endOpacity, fraction);
    let grayscale = 1 - fraction;
    element.style.filter = `grayscale(${grayscale})`;
    element.style.opacity = opacity;
    // I'd like to let css transitions do the work, but as we zoom, we make different subscriptions and thus start
    // the "same" marker over again. This initial setup clashes with zooming if done with a next-tick step opacity+filter value.
    const interval = 2e3; // Milliseconds / step
    const opacityFade = (endOpacity - opacity) *  interval / remaining; // change / step
    const grayscaleFade = (endGrayscale - grayscale) * interval / remaining;
    clearInterval(this[selector]);
    this[selector] = setInterval(() => {
      element.style.filter = `grayscale(${grayscale += grayscaleFade})`;
      element.style.opacity = (opacity += opacityFade);
    }, interval);
    return element;
  }
  destroy() { // Remove this Marker pin entirely.
    clearInterval(this['.alert-pin']);
    clearInterval(this['.alert-commented']);
    clearInterval(this.destroyer);
    this.clearAvatars();
    // Unsubscribe from replies.
    networkPromise?.then(async contact => contact.subscribe({eventName: this.subject, region: this.region, handler: null}));
    this.marker.removeFrom(map);
    delete this.constructor.markers[this.subject];
  }
}

export function go({lat = null, lng = null, zoom = null, subject = null}) { // Go to specified location (if any) and open marker (if any).
  if (lat !== null && lng !== null) {
    if (zoom) map.flyTo({lat, lng}, zoom);
    else map.flyTo({lat, lng});
  }
  openOnReceive = null;
  if (subject) {
    Marker.openPopup(subject) || (openOnReceive = subject);
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
  Marker.closePopup();
  const latLng = [lastLatitude, lastLongitude];
  map.flyTo(latLng);
}

var trackMap;

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
    updateSubscriptions();
    updateLocation(lastLatitude, lastLongitude); // Might now be within map.
  });

  // Add click event to note position
  map.on('click', async function(e) {
    resetInactivityTimer();
    if (document.getElementById('map').querySelector('.leaflet-popup')) return; // Ignore clicks with popup open.
    const { lat, lng } = e.latlng;
    Marker.openPopup(await publishAlert({lat, lng}));
    Agent.current.persistPublicMetadata(P2PWebNetwork.regionCode(lat, lng));
  });
}
