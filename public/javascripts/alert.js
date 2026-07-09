import * as L from 'leaflet';
import { P2PWebNetwork } from './p2pWebNetwork.js';
import { Int } from './translations.js';
import { map, trackMap, showMessage, publishAlert } from './map.js';
import { networkPromise, resetInactivityTimer, notificationsAllowed, tooltip, clickTip, openAbout, delay, osName } from './main.js';
import { consume } from './display.js';
import { Hashtags } from './hashtags.js';
import { Agent } from './agent.js';
const { getComputedStyle, URL, URLSearchParams, domtoimage } = globalThis;

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
    Alert.closePopup();
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


const ttl = 24 * 60 * 60e3; // 24 hours
let openOnReceive = null;
export function go({lat = null, lng = null, zoom = null, subject = null}) { // Go to specified location (if any) and open marker (if any).
  if (lat !== null && lng !== null) {
    if (zoom) map.flyTo({lat, lng}, zoom);
    else map.flyTo({lat, lng});
  }
  openOnReceive = null;
  if (subject) {
    Alert.openPopup(subject) || (openOnReceive = subject);
  }
}

export class Alert { // A wrapper around L.marker
  // When we resubscribe to different cells covering the same place, we will get the same
  // sticky data. We don't want to change the marker. Fortunately, the publication to each
  // of the cells (at different scales) are all published with the same data.
  static markers = {}; // subject => Alert
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
      html: `<div class="alert-commented"></div><div class="alert-pin">${Hashtags.formatAlert(hashtag)}</div>`,
      iconSize: [40, 40],
      popupAnchor: [0, 0],
      className: 'alert-marker'
    });
  }
  static updateAlerts(canonicalHashtag, extendedHashtag) { // Update markers becase we have discovered an extendedHashtag that we have only had as canonical.
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
      networkPromise.then(async contact => {
	contact.subscribe({eventName: subject, region, handler: data => wrapper.handleReply(data)});
      });
      console.log('marker', marker, marker.getElement());
      tooltip(marker.getElement(), Int`Show conversation for this ${hashtag} alert.`);
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
    clickTip(replyButton, Int`Post your reply.`, event => this.postReply(event));
    clickTip(replyAttachButton, Int`Attach a file to your reply.`, event => { resetInactivityTimer(); fileChooser.click(); });
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
	const isMine = Agent.isMine(tag);
	clickTip(correspondent, isMine ?
		 Int`Control how others see me.` :
		 Int`Control how this person is labeled on my device.`,
		 event => {
		   if (isMine) openAbout(event);
		   else agent.describe(event);
		 });
      }
    }
    for (const deleter of popupElement.querySelectorAll('.reply .attribution > div:last-child md-outlined-icon-button')) {
      clickTip(deleter, Int`Delete your reply.`, event => { // Delete reply.
	consume(event);
	this.deleteReply(event.currentTarget.closest('.reply'));
      });
    }
    for (const downloadable of popupElement.querySelectorAll('[download]')) {
      tooltip(downloadable, Int`Click to download ${downloadable.download}.`);
    }
    const shareable = popupElement.querySelectorAll('.share');
    for (const element of shareable) clickTip(element, element.closest('.reply') ?
					      Int`Share though ${osName()} the text and attachments of this reply, with a link to open this alert.` :
					      Int`Share through ${osName()} a link to open this alert.`, event => this.share(event));
  }
  initChangeHashtag(someParent) { // Init handler on the menu button, if any, as (re-) init of menu for open popup
    const changeHashtag = someParent.querySelector('.changeHashtag');
    if (!changeHashtag) return;
    const menu = document.getElementById('popoverMenu');
    menu.anchorElement = changeHashtag;
    clickTip(changeHashtag, Int`Change the topic or delete your alert.`, event => {
      consume(event);
      menu.open = !menu.open;
      menu.onclick = consume; // Must be onlick rather than addEventListener.
      const handler = event => {
	menu.removeEventListener('close-menu', handler);
	this.updatePost(event.detail.initiator.dataset.tag);
      };
      menu.addEventListener('close-menu', handler); // Must be addEventListener because there's no onclosemenu.
    });
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
      const {topic:file} = await contact.chunkifyBlob({blob: files[0], region});
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
	  .replace(/https?:\/\/\S+\.(mp3|aac|ogg|oga|opus|m4a|m3u8|m3u|mpu|mpd)$/ig, url => `<audio controls src="${url}"></audio>`) // show audio urls as players
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
  destroy() { // Remove this Alert pin entirely.
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
