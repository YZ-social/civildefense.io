import * as L from 'leaflet';
import { P2PWebNetwork } from './p2pWebNetwork.js';
import { Int } from './translations.js';
import { map, trackMap, showMessage } from './map.js';
import { networkPromise, resetInactivityTimer, notificationsAllowed, tooltip, clickTip, openAbout, delay, osName } from './main.js';
import { consume } from './display.js';
import { Hashtags } from './hashtags.js';
import { Agent } from './agent.js';
import { Conversation, Reply } from './conversation.js';
import { alertTopic, topicRegion, cellHex, topicCell } from './versions.js';
import { getContainingCells, getSmallestCellId, getSubdivision, findCoverCellsByMinMaxLatLng, cellContains, pointFromLatLng, cellFromCellID } from './s2.js';
const { localStorage, getComputedStyle, URL, URLSearchParams, domtoimage } = globalThis;


export function getShareableURL(tag = null, tags = Hashtags.getSubscribe()) { // Answer a url that reflects application state.
  const params = new URLSearchParams(location.search);
  const zoom = map.getZoom();
  const { lat, lng } = map.getCenter();

  if (tags.length) params.set('tags', tags.map(tag => encodeURIComponent(tag)).join(','));
  if (lat !== null) params.set('lat', lat);
  if (lng !== null) params.set('lng', lng);
  if (zoom !== null) params.set('z', zoom);
  if (tag !== null) params.set('alert', tag);
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
    const target = document.getElementById('mapCapture'); // For capturing a screen shot.
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
export function go({lat = null, lng = null, zoom = null, alert = null}) { // Go to specified location (if any) and open marker (if any).
  if (lat !== null && lng !== null) {
    lat = parseFloat(lat);
    lng = parseFloat(lng);
    if (zoom) map.flyTo({lat, lng}, parseFloat(zoom));
    else map.flyTo({lat, lng});
  }
  openOnReceive = null;
  if (alert) {
    Alert.openPopup(alert);
  }
}

class AlertReply extends Reply {
  async initialize(properties) { // Set properties of this AlertReply.
    // Currently, this waits for any attachment to be fetched. (Conversation.ensure() will wait as long as we need.)
    // This means that the alert will not show up until we have the attachments, and then it shows up all at once with the text,
    // attribution, and attachment. (There's no img or video "loading" period because the attachment comes through as a complete
    // data url.)  This is convenient for the formatReply function, because until the chunked attachment is re-assembled, we won't
    // know which kind of player to use, and we won't be able to assign the containing A[href].
    //
    // Alternatively, we could in the future choose to have the attributions and text appear right away, with a "spinner"
    // placeholder that turns into the appropriate A/player when the attachment resolves. To do that, we would need to record here
    // a promise to reassemble the attachment, have formatReply create a findable placeholder to later replace with the A element
    // and contents, and then have ensureContent() arrange in its delayed followup to replace the placeholder when the promise
    // resolves.
    await super.initialize(properties);
    const {container, agent, issuedTime, payload} = properties;
    const {file:attachmentTopic} = payload;
    if (attachmentTopic) {
      const contact = await networkPromise;
      // Before pushing data on to replies.
      const {dataURL:file, name, msgIds} = await contact.assembleChunkedDataURL(attachmentTopic);
      Object.assign(payload, {file, name, attachmentTopic, msgIds});
    }
    container.showNotification({agent, issuedTime, body: payload.message || payload.name || payload});
    return this;
  }
  update() { } // TODO: are we really getting multiple reply events for the same data?
}

import { s2 } from 's2js';
export class Alert extends Conversation { // A wrapper around L.marker
  // For each hashtag, we subscribe to a set of non-overlapping cells at varying S2 levels that cover the current map.
  // An Alert is made when a subscription handler fires, and it keeps information that is (mostly) true regardless of
  // which cell brought it in. E.g., each alert has a bookkeeping tag that identifies that map-click, which is
  // the same at all S2 levels, and forms the topic for replies to that alert. When the map changes and the subscriptions
  // are updated, we try to re-use the same Alerts so that the markers don't flash and we don't create garbage.

  // INSTANCE MANAGEMENT
  // When there are "too many" instances in a cell (at any level), we replace the individual Alerts with a single larger aggregate.
  // This allows us to handle any any quantity of Alerts in memory and visual clutter, and to not mislead users in the presence
  // of publication topic "rollover". However, it greatly complicates insance management.

  // Conversation.ensure is the subscription handler, and it keeps track of the instances by tag, initializing a new one if needed.
  initialize({topic, payload, hashtag, tag, agent, issuedTime, ...rest}) { // Make appropriate instance for a new individual tag, or update aggregate.

    if (!Hashtags.isSubscribed(hashtag)) return null; // A subscribed event may have been in flight while unsubscribing. Caller destroys instance.
    const now = Date.now(),
	  expiration = issuedTime + ttl,
          remaining = expiration - now;
    if (remaining < 0) return null;  // Network shouldn't send us expired, but if it does, let its instance be destroyed.

    const eventName = topic.name;
    let keep = this; // Instance to be kept as marker.
    let aggregate = this.constructor.getAggregate(eventName); // If we already have one for this eventName

    // Each new initialization gets counted, which may be more than the network rollover.
    // We do not "back up" for deletions and expirations - i.e., subtract and possibly go back to individual alerts.
    // Note that initialize() will not be called for an event handler that has a tag (msgId) the same as one we have already seen for a different cell scale.
    this.constructor.subscriptions[eventName]++;
    
    if (aggregate) {
      keep = null; // This new instance is superfluous. Tell ensure() to destroy it...
      aggregate.lerp(eventName, payload.lat, payload.lng); // ...but nudge the existing aggregate towards us.
    } else { // Does not exist yet
      let {lat, lng, originalPosting} = payload;
      lat = parseFloat(lat);
      lng = parseFloat(lng);
      if (this.constructor.cellCountOverLimit(eventName)) aggregate = this; // If now over, treat this marker as an aggregate.
      const icon = this.constructor.makeIcon(hashtag, tag, aggregate);
      const marker = this.marker = L.marker([lat, lng], {icon, autoPan: false}).addTo(map);
      const region = P2PWebNetwork.regionCode(lat, lng);
      hashtag = Hashtags.add(hashtag); // We already have it and are subscribing, but this updates our extended form if needed.
      super.initialize({payload, hashtag, tag, agent, lat, lng, issuedTime, originalPosting, ...rest});
      if (aggregate) {
	// Destroy existing eventName markers and add their positions to the aggregate we are creating.
	this.becomeAggregate(eventName);
	this.constructor.clearEventMarkers(eventName, aggregate);
      } else {
	this.noteEventName(eventName);
	marker.bindPopup('', {className: 'alert'}).on('popupopen', event => this.ensureContent(event.popup));
	tooltip(marker.getElement(), Int`Show conversation for this ${hashtag} alert.`);
	if (tag === openOnReceive) { // Bug! How can we handle URLs to an alert that has been aggregated?
	  openOnReceive = false;
	  this.openPopup();
	}
	networkPromise.then(async contact => { // Subscribe to replies to this tag, now that we have an alert for them to go to.
	  contact.subscribe({eventName: tag, region, handler: data => this.ensure(data)});
	});
      }
    }
    const alert = aggregate || this;
    alert.startExpiration('.alert-pin', remaining);
    alert.showNotification({agent, issuedTime});
    return keep;
  }
  update({topic, ts, ...rest}) { // Called when handling an existing Conversation. super confirms that nothing immutable has changed.
    return super.update({...rest}); // topic and ts vary with level, and so must not be part of ensure/update checks.
  }
  async destroy(markerDelayMS = 400) { // Remove this Alert pin entirely, either through unpublish, expiration, or conversion of a cell to aggregate.
    // We do not decrement Alert.subscriptions[this.eventName] and unaggregate into individual markers.
    // That won't happen until the user completely unsubscribes from this cell and resubscribes (by toggle or map movement).
    clearInterval(this['.alert-pin']);
    clearInterval(this['.alert-commented']);
    clearInterval(this.destroyer);
    this.clearAvatars();
    const {isAggregate, marker, tag, region} = this;
    // Unsubscribe from replies.
    if (!isAggregate) networkPromise?.then(async contact => contact.subscribe({eventName: tag, region, handler: null}));
    this.cellBorder?.removeFrom(map);
    super.destroy();
    if (markerDelayMS) {
      marker.closePopup();
      marker.unbindPopup(); // It would be confusing if it happens to be open, or clicked on while being removed.
      marker.setOpacity(0);
      await P2PWebNetwork.delay(markerDelayMS);
    }
    marker.removeFrom(map);
  }

  static subscriptionQueue = Promise.resolve(); // Serialize updates so they don't overlap each other.
  static async updateSubscriptions({newKeys, oldKeys, throttleMS = 20} = {}) { // Update current subscriptions.
    // A value of {} passed for oldKeys is used to start things off fresh (i.e., without supressing subscription of any carry-overs).
    return this.subscriptionQueue = this.subscriptionQueue.then(async () => {
      oldKeys ||= this.subscriptions;
      newKeys ||= this.subscriptionFromMap();

      if (!newKeys) return; // e.g., wacky computation. Don't change anything.
      const contact = await networkPromise;
      const dropped = [], added = [];
      if (!contact) { console.warn("No network through which to subscribe."); return; } // Does this ever happen? Why?
      this.subscriptions = newKeys; // Before subscribing.
      const subscribe = async (eventName, handler) => {
	if (!eventName) console.log('sub to no eventName', {oldKeys, newKeys, dropped, added, handler});
	const region = topicRegion(eventName);
	if (handler) Agent.current?.trackPublicChanges(region); // Background. No need to await.
	await contact.subscribe({eventName, region, handler}).then(() => throttleMS && P2PWebNetwork.delay(throttleMS));
      };
      for (const key in newKeys) oldKeys.hasOwnProperty(key) || added.push(key);
      for (const key in oldKeys) newKeys.hasOwnProperty(key) || dropped.push(key);
      console.log('updating subscriptions', {added, dropped, newKeys, oldKeys});

      // Before subscribing, as that that may bring in an alert with the same tag as one being cleared.
      if (this.aggregateLimit) this.transferOrClearEventMarkers(added, dropped, newKeys, oldKeys); 

      for (const key of added) await subscribe(key, data => Alert.ensure(data));
      for (const key of dropped) await subscribe(key, null);

      // for (const alert of this.items) { // fixme remove
      // 	if (this.subscriptions[alert.eventName] == undefined) {
      // 	  let kind = added.includes(alert.eventName) && 'added';
      // 	  kind ||= dropped.includes(alert.eventName) && 'dropped';
      // 	  kind ||= Object.keys(newKeys).includes(alert.eventName) && 'new';
      // 	  kind ||= Object.keys(oldKeys).includes(alert.eventName) && 'old';
      // 	  throw new Error(`${kind} ${alert.eventName} has no count after subscription update.`);
      // 	}
      // }
    });
  }

  // Instance Management Internals
  // In general here, a key is an eventName - i.e., a string <mumble>:<cellID>:<hashtag>.
  // newKeys/oldKeys are a map of the currently subscribed eventName and the count of events for that cell+hashtag
  static subscriptions = {}; // maps currently active eventNames (<mumble>:<cellID>:<hashtag>) to count of event received for it.
  static get aggregateLimit() { // How many individuals are allowed before we aggregate.
    return parseInt(minAggregate.value);
  }
  static cellCountOverLimit(eventName, countsDictionary = this.subscriptions) { // Have we received enough that we must show an aggregate?
    return countsDictionary[eventName] >= this.aggregateLimit;
  }
  static getAggregate(eventName) { // Answer the existing aggregate for this cell, if any.
    return this.getItem(eventName); // While individual Alerts are stored in items/conversations by tag, the tag for aggregate is the eventName.
  }
  logAlert(label = '') { // For debugging, when an individual or aggregate marker is clicked, show the alert, cell, and count in console.
    const {lat, lng, eventName} = this;
    console.warn(`${label} lat: ${lat}, lng: ${lng}, ${eventName}: ${this.constructor.subscriptions[eventName]}`);
  }
  noteEventName(eventName) { // Be a part of the specified grouping.
    if (this.eventName === eventName) return;
    this.eventName = eventName;
    if (!this.isAggregate) return;
    this.cellBorder?.removeFrom(map);
    const cell = cellFromCellID(topicCell(eventName));
    const radiansToDegrees = 180 / Math.PI;
    const corners = Array.from({ length: 4 }, (_, i) => {
      const point = cell.vertex(i);
      const latLng = s2.LatLng.fromPoint(point);
      return [latLng.lat * radiansToDegrees, latLng.lng * radiansToDegrees];
    });
    const border = this.cellBorder = L.polygon(corners, {color: 'red'});
    border.addTo(map);
  }
  static forEachAlertOf(eventName, callback, alerts = this.items) { // Apply callback to each of alerts matching eventName.
    // TODO? Record a cell's Alert's more efficiently, so that we don't have to cycle through everything.
    alerts.forEach((alert, index, alerts) => (alert.eventName === eventName) && callback(alert, index, alerts));
  }
  static clearEventMarkers(eventName, aggregate = null, alerts = this.items) { // destroy each, but
    // if aggregate is specified, keep the aggregate and average all position into the aggregate.
    if (!aggregate) return this.forEachAlertOf(eventName, alert => alert.destroy(), alerts);
    const eachExceptAggregate = cb => this.forEachAlertOf(eventName, alert => (alert === aggregate) || cb(alert), alerts);
    let lat = aggregate.lat, lng = aggregate.lng, count = 1;
    if (aggregate.eventName != eventName) { // Loading from another eventName. Keep existing weight.
      count = this.subscriptions[aggregate.eventName];
      lat *= count;
      lng *= count;
    }
    eachExceptAggregate(alert => { lat += alert.lat; lng += alert.lng; count++; });
    lat /=  count;
    lng /= count;
    return this.forEachAlertOf(eventName, alert => {
      alert.reposition(lat, lng);
      if (alert !== aggregate) alert.destroy(400); // May or may not be default. Half the translation transition time.
    }, alerts);
  }
  becomeAggregate(eventName) { // Make an individual alert be an aggregate
    const {tag, marker, hashtag, region} = this;
    const element = marker.getElement();
    const pin = element.querySelector('.alert-pin');
    this.isAggregate = true;
    pin.classList.toggle('aggregate', true); pin.classList.toggle('starting', true);
    setTimeout(() => pin.classList.toggle('starting', false), 100);
    marker.unbindPopup();
    marker.off('click');
    marker.on('click', event => this.logAlert('FIXME go down one level'));
    tooltip(element, Int`Zoom in on multiple ${hashtag} alerts.`); // fixme Int.
    this.noteEventName(this.tag = eventName);
    if (tag !== eventName) {
      networkPromise.then(async contact => contact.subscribe({eventName: tag, region, handler: null})); // Unsubscribe from replies.
      this.items = [];
      clearInterval(this['.alert-commented']);
      element.querySelector('.alert-commented').style = "opacity: 0;";
      this.constructor.removeItem(tag);
    }
    this.constructor.setItem(eventName, this);
  }
  static handleAggregation(droppedEventName, addedEventName, newCounts, alerts) { // Return aggregate if over limit, setting it up if necessary. Else null.
    // If over limit, converts an addedEventName Alert if needed and clears the rest, and then clears all droppedEventName Alerts.
    if (!this.cellCountOverLimit(addedEventName, newCounts)) return null;
    let aggregate = this.getAggregate(addedEventName);
    if (!aggregate) { // If no existing aggregate:
      aggregate = alerts.find(alert => alert.eventName === droppedEventName); // Pick a dropped individual to become aggregate. There will be one, by construction.
      aggregate.becomeAggregate(addedEventName);
      this.clearEventMarkers(addedEventName, aggregate, alerts); // Kill the rest, adding their positions to the aggregate.
    }
    return aggregate;
  }
  static transferOrClearEventMarkers(added, dropped, newCounts, oldCounts) { // Clear dropped alerts as necessary,
    // but try to preserve (individual and aggregated) alerts so that the markers don't flash.
    const addedCells = added.map(topicCell); // List of BigInt, in same order as added eventNames.
    const alerts = this.items;
    dropped.sort((a, b) => oldCounts[b] - oldCounts[a]);  // So that we always process aggregates before related individuals.
    dropped.forEach(droppedEventName => {
      const droppedCell = topicCell(droppedEventName);
      // Whether zooming in or out, each dropped cell may have added cells that contain it, or vice versa.
      // We don't have to worry about cells that are neither added nor dropped, because those will not overlap added or dropped.

      // Find the one added cell (if any) that contains the dropped cell. (Typically when zooming out.)
      const containerIndex = addedCells.findIndex(added => cellContains(added, droppedCell));
      if (containerIndex >= 0) {
	const addedContainingEventName = added[containerIndex];
	newCounts[addedContainingEventName] += oldCounts[droppedEventName]; // It all goes to the container, which may have already started filling.
	const aggregate = this.handleAggregation(droppedEventName, addedContainingEventName, newCounts, alerts);
	if (aggregate) {
	  this.clearEventMarkers(droppedEventName, aggregate, alerts); // Absorb the discarded. Their distinctiveness will be added to our own.
	  return;
	}
	this.forEachAlertOf(droppedEventName, alert => alert.noteEventName(addedContainingEventName)); // Label the dropped individual alerts for new container.
	return;
      }

      const aggregate = this.getAggregate(droppedEventName);
      if (aggregate) { // We don't know how mucch of this will be included in any added subregion, and cannot reconstruct where they were.
	aggregate.destroy();
	return;
      }

      // Find the 0-4 added cells that are contained by the dropped cell. (Typically when zooming in.)
      const addedSubCells = addedCells.filter(added => cellContains(droppedCell, added));
      // We don't know how many oldCounts to distribute to each subcell, so we have to work with each dropped alert's location.
      if (addedSubCells.length) {
	const addedS2Cells = addedSubCells.map(cellFromCellID);
	this.forEachAlertOf(droppedEventName, alert => {
	  const point = pointFromLatLng(alert.lat, alert.lng);
	  const addedS2Cell = addedS2Cells.find(cell => cell.containsPoint(point));
	  if (addedS2Cell) {
	    const includedIndex = addedCells.indexOf(addedS2Cell.id);
	    const addedIncludedEventName = added[includedIndex];
	    newCounts[addedIncludedEventName] += 1;
	    if (this.handleAggregation(droppedEventName, addedIncludedEventName, newCounts, alerts)) return;
	    alert.noteEventName(addedIncludedEventName); // Leave this alert in place, but label where it belongs.
	  } else {
	    alert.destroy(); // This alert is not within an added subcell.
	  }
	}, alerts);
	return;
      }

      // Otherwise, no overlap, so clear the (individual and aggregate) markers of the dropped cell.
      this.clearEventMarkers(droppedEventName);
    });
  }
  lerp(eventName, additionaLatitude, additionalLongitude) { // Move this Alert towards this location, inversely weight by count in cell.
    const count = this.constructor.subscriptions[eventName];
    const k = 1 / count;
    const k1 = 1 - k;
    const {lat, lng} = this;
    this.reposition(k1 * lat + k * additionaLatitude,
		    k1 * lng + k * additionalLongitude);
  }
  reposition(lat, lng) { // Update the marker's position for new data.
    this.lat = lat;
    this.lng = lng;
    this.marker.setLatLng([lat, lng]);
    this.startExpiration('.alert-pin', Date.now() + ttl);
  }

  // We do not record exactly where you were looking across sessions, but we do record the containing level 9 cell.
  static lastLevel9Cell = null; // S2 level 9 cells average a radius of about 10km ~ 6.5 miles.
  static subscriptionFromMap() { // Generate new subscriptions list ({eventName => count}) for current map bounds.
    const center = map.getCenter();
    const bounds = map.getBounds();
    const northEast = bounds.getNorthEast();
    const southWest = bounds.getSouthWest();
    const zoom = map.getZoom();
    const newCells = findCoverCellsByMinMaxLatLng({
      full: zoom <= map.options.minZoom,
      minLat: southWest.lat,
      maxLat: northEast.lat,
      minLng: southWest.lng,
      maxLng: northEast.lng
    });
    if (!newCells) return null;
    const newKeys = {};
    newCells.forEach(cell => Hashtags.getSubscribe().forEach(hash => { // Populate count with existing count (exctly carried over cell sizes), else 0.
      const eventName = alertTopic(cell, hash);
      newKeys[eventName] = this.subscriptions[eventName] || 0;
    }));
    // Record a zoomed-out cell id in case next session does not have geolocation services.
    let level9Cell = getSmallestCellId(center.lat, center.lng, 9);
    if (level9Cell !== this.lastLevel9Cell) localStorage.setItem('level9Cell', this.lastLevel9Cell = level9Cell);
    return newKeys;
  }

  // PUBLISHING NEW ALERTS
  // Each map click publishes to that point at each supported S2 level that contains it, so that any map display of
  // non-overlapping cells will catch it. (Network subscriptions are much more expensive than publishing, and the app
  // users watch more than they publish, so we minimize the number of subscriptions that a user has at any moment.)

  // The app (not the network) restricts the user to publish up to maxPublish alerts over the last maxPublish minutes.
  // I.e., one / minute, but allowing bursts up to maxPublish. After that, one can still publish, but kill the oldest.
  // We keep enough data in memory that we can reproduce what to kill,m even if Alert has since scrolled off the map and been destroyed.
  static maxPublish = 5;
  static publishing = false;
  static lastPublished = []; // Last published lat, lng, hashtag
  // Publish an alert to all applicable eventNames, canceling as required. Promises tag (msgId).
  static async publish({lat, lng,
			originalPosting = undefined,
			hashtag = Hashtags.getPublish(true),
			payload = {lat, lng, originalPosting}, // If payload is null (cancels tag), lat & lng are still used to generate eventNames.
			cancel = undefined, // First unpublish the specified data, if any. Complicated default.
			issuedTime = Date.now(), tag,
			throttleMS = 0,
			...rest
		       }) {
    // We call all the publishing at once and return tag, without waiting for each to occur.
    // However, the 'unpublishing' (if any) is invoked first.
    // To do this, we must hash the eventName ourselves.
    //console.log('publish', {lat, lng, hashtag, payload, cancel, tag, issuedTime, rest});
    if (this.publishing) { console.log('skiping overlapping publish'); return null; } // do not stack them up.
    try {
      this.publishing = true;

      const contact = await networkPromise; // subtle: The rest of this all happens synchronously, with any null payloads definitely first.
      let oldCells = null, oldHash, oldTag = null; // Recorded for logging, below.
      let lastFillIn;
      if (payload) {
	lastFillIn = {lat, lng, hashtag, issuedTime};
	this.lastPublished.push(lastFillIn); // Capture the added data.
	const periodStart = Date.now() - (this.maxPublish * 60e3); // maxPublish minutes ago.
	this.lastPublished = this.lastPublished.filter(past => past.issuedTime >= periodStart);
	if (cancel === undefined && this.lastPublished.length > this.maxPublish) { // Unless specified otherwise, cancel oldest over maxPublish.
	  showMessage(Int`Too many posts. (5 allowed every 5 minutes.) Removing oldest from this period.`, 'instructions');
	  cancel = this.lastPublished.shift();
	}
      }
      if (cancel) {
	const {lat, lng, hashtag, tag} = cancel;
	oldCells = getContainingCells(lat, lng);
	oldHash = hashtag; oldTag = tag;
	const region = P2PWebNetwork.regionCode(lat, lng);
	for (const cell of oldCells) {
	  const eventName = alertTopic(cell, hashtag);
	  // Note: we cannot unpublish replies by others, but they expire after a while anyway.
	  await contact.publish({eventName, region, killTag: tag, payload: null});
	  throttleMS && await P2PWebNetwork.delay(throttleMS);
	}
      }

      const cells = getContainingCells(lat, lng);
      const region = P2PWebNetwork.regionCode(lat, lng);
      for (const cell of cells) {
	const eventName = alertTopic(cell, hashtag);
	if (payload) {
	  // The Axona message will be {hashtag, issuedTime, payload:{lat, lng, originalPosting}}
	  // and when combined with the publisher's authorId will be unique to this user/time/hashtag,
	  // and yet the same for each of the individual publications at the different s2 scales.
	  const msgId = await contact.publish({eventName, region, payload, issuedTime, hashtag, ...rest});
	  if (tag && tag !== msgId) throw new Error(`msgId is drifting: ${tag} => ${msgId}`);
	  tag = msgId;
	  if (lastFillIn) {
	    lastFillIn.tag = tag;
	    lastFillIn = null;
	  }
	} else {
	  await contact.publish({eventName, region, killTag: tag, payload: null});
	  throttleMS && await P2PWebNetwork.delay(throttleMS);
	}
      }
      if (!payload) {
	const index = this.lastPublished.findIndex(past => past.tag === tag);
	if (index >= 0) this.lastPublished.splice(index, 1);
      }
      console.log('Published', {cells, n: cells.length, region, hashtag, tag, payload, oldCells, oldHash, oldTag});
      return tag;
    } finally {
      this.publishing = false;
    }
  }
  
  static noMessage = Int`No additional information.`;
  static closePopup() { // Close any open popup.
    map.closePopup();
    Hashtags.closeSelector();
  }
  static openPopup(alertTag) { // Open the marker specified by tag.
    const wrapper = this.getItem(alertTag);
    wrapper?.openPopup() || (openOnReceive = alertTag);
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
  static makeIcon(hashtag, tag, isAggregate = false) { // Return a Leaflet icon. 
    // tag is handy for debugging. TODO: are these cacheable and reusable?
    return L.divIcon({
      html: `<div class="alert-commented"></div><div class="alert-pin${isAggregate ? ' aggregate' : ''}" data-debug="${tag}">${Hashtags.formatAlert(hashtag)}</div>`,
      iconSize: [40, 40],
      popupAnchor: [0, 0],
      className: 'alert-marker'
    });
  }
  static updateAlerts(canonicalHashtag, extendedHashtag) { // Update markers becase we have discovered an extendedHashtag that we have only had as canonical.
    this.items.forEach(wrapper => {
      const { hashtag, marker, agent } = wrapper;
      if (hashtag !== canonicalHashtag) return;
      const newIcon = this.makeIcon(extendedHashtag, wrapper.tag);
      marker.setIcon(newIcon);
      wrapper.hashtag = extendedHashtag;
      wrapper.needsRedisplay = true; // See comment for initializeHandlers. We need to clear and rebuild content on re-open.
      const popup = marker.getPopup();
      if (!popup?.isOpen()) return; // Either an aggregate or closed.
      // Fix what's showing now without flashing everything. Make sure menu works.
      const popupAttribution = popup.getElement().querySelector('.attribution');
      const attributionActions = popupAttribution.lastElementChild;
      attributionActions.lastElementChild.remove();
      attributionActions.insertAdjacentHTML('beforeend', this.formatAttributionHashtag(agent, extendedHashtag));
      wrapper.initChangeHashtag(popupAttribution);
    });
  }

  needsRedisplay = true;
  ensureContent(popup = this.marker.getPopup()) { // Set content and handlers in popup if/as needed.
    if (!popup.isOpen()) return;
    this.logAlert();
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
      const region = P2PWebNetwork.regionCode(this.lat, this.lng);
      const agent = Agent.ensure({tag, region: region});
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
	this.updatePost(event.detail.initiator.dataset.tag); // initiator is a hashtag menu item and dataset.tag is a hashtag.
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
    if (isOurs && !this.items.length) showMessage(Int`Change the topic or remove the alert with the topic button in the upper right of the conversation dialog.`, 'instructions');
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
  updatePost(newHashtag) { // Republish under a different hashtag, or cancel altogether if no newHashtag (which is not allowed as a hashtag).
    resetInactivityTimer();
    const {lat, lng, hashtag, tag, issuedTime, originalPosting = issuedTime} = this;
    console.log("updatePost", {newHashtag, lat, lng, hashtag, tag, issuedTime, originalPosting, self:this});
    if (!newHashtag) return Alert.publish({lat, lng, tag, originalPosting, hashtag, payload: null, cancel: null}); // Remove post with null payload, cancel.
    if (newHashtag === hashtag) return this.needsRedisplay = true;
    const cancel = {lat, lng, tag, hashtag}; // Cancel old hashtag as we publish newHashtag, below.
    Hashtags.setPublish(newHashtag);
    Hashtags.onchange({redisplaySubscribers: false, resetSubscriptions: false});
    return Alert.publish({lat, lng, hashtag: newHashtag, originalPosting, cancel}); // Publish new alert w/cancellation.
  }

  // Each reply is separately published by its author, and only they can modify/unpublish it.
  get itemKind() { // Answer class of reply items.
    return AlertReply;
  }
  async ensure(data) { // Add or update reply for this reply.
    const remaining = data.issuedTime + ttl - Date.now();
    if (remaining < 0) return null;
    const reply = await super.ensure(data);
    if (reply) {
      if (reply === this.items[0]) { // If first sorted reply, and there's a message, update the tooltip.
	const message = reply.payload?.message || (!reply.payload.file && reply.payload);
	const markerElement = message && this.marker.getElement();
	if (markerElement) tooltip(markerElement, message);
      }
      if (reply === this.items[this.items.length - 1]) { // If last reply so far (even if first), show ring and update fader.
	const ringElement = this.startFader('.alert-commented', remaining);
	if (ringElement) {
	  ringElement.style.display = 'block';
	  // Restart the pulse animation by setting animationName to something it isn't.
	  ringElement.style.animationName = ringElement.style.animationName === 'pulse2' ? 'pulse' : 'pulse2';
	}
      }
    }
    this.needsRedisplay = true;
    this.ensureContent();
    return reply;
  }
  async postReply(event) { // Post a reply to this marker's tag, in response to a text-field change event.
    resetInactivityTimer();
    event.stopPropagation();
    const button = event.target;
    const inputElement = button.parentElement;
    let payload = inputElement.value.trim();
    const {tag, hashtag, lat, lng} = this;
    const region = P2PWebNetwork.regionCode(lat, lng);
    const files = inputElement.parentElement.querySelector('input[type="file"]').files;
    if (!payload && !files.length) return;
    inputElement.value = '';
    inputElement.querySelector('md-filled-icon-button').toggleAttribute('disabled', true);
    const contact = await networkPromise;
    if (files.length) {
      const {topic:file, msgIds} = await contact.chunkifyBlob({blob: files[0], region});
      payload = {message: payload, file};
    }
    await contact.publish({eventName: tag, region, payload}); // Publish the new reply.
    Agent.current.persistPublicMetadata();
  }
  deleteReply(replyElement) {
    resetInactivityTimer();
    const {lat, lng, tag} = this;
    const region = P2PWebNetwork.regionCode(lat, lng);
    const killTag = replyElement.dataset.tag;
    networkPromise.then(async contact => {
      // We won't be here unless we are the signer.
      await contact.publish({eventName: tag, region, killTag, payload: null});
      // IFF there's an attachment AND we're given msgIds by receiveChunkedBytes, then delete the attachment.
      const reply = this.getItem(killTag);
      const {attachmentTopic, msgIds = []} = reply?.payload || {};
      if (msgIds.length) {
	const {name, owner, region} = attachmentTopic;
	for (const killTag of msgIds) {
	  await contact.publish({eventName: name, region, owner, killTag, payload: null});
	}
      }
    });
  }
  showNotification({issuedTime = this.issuedTime, body = '', agent = this.agent, alert = this.tag, lat = this.lat, lng = this.lng, hashtag = this.hashtag}) {
    // Give OS notification that comes back to here, unless act is us.
    // All notifications on the same alert (e.g., the post and each reply) have the same tag, so OS can collapse them.
    if (agent === Agent.tag || !notificationsAllowed()) return;
    navigator.serviceWorker.ready.then(registration => {
      const timestamp = issuedTime;
      const icon = new URL('./images/civil-defense-192.png', location.href).href;
      const url = getShareableURL(alert, [hashtag]).href; // For opening page when it has been closed.
      const data = {lat, lng, url};
      // It appears that on 8/14/26:
      // Safari ignores tag/renotify, and ALWAYS tells the user and displays each notification separately, without consolidating by tag.
      // Chrome ignores renotify, and ALWAYS consolidates by tag, replacing old body with new, and NEVER renotifies the user (for the same tag).
      // So... we could get uniform behavior by skipping the tag, but for now we'll try using it as intended, in case the browsers ever start to comply.
      const options = {icon, timestamp, tag: alert, body, data, renotify: true};
      console.log('showNotification', hashtag, options);
      registration.showNotification(hashtag, options);
    });
  }
  // Each reply element is a DIV.reply with data-tag and data-text attributes that are used in sharing.
  // It contains an attribution header with controls, zero or one attachments, and then the message text.
  // If present the attachment will be an A element with download attribute, surrounding either an IMG, A/V player, or an attachment icon followed by the file name.
  formatReplies() { // Answer HTML for the replies and input box.
    const { items, agent, originalPosting } = this;
    const formatReply = ({tag, payload, ...rest}) => {
      const {message = payload, file, name} = payload || {}; // Message text converts recognized urls to A/V players or links.
      let text = message
	  .replace(/https?:\/\/\S+\.(mp3|aac|ogg|oga|opus|m4a|m3u8|m3u|mpu|mpd)$/ig, url => `<audio controls src="${url}" crossorigin="anonymous"></audio>`) // show audio urls as players
	  .replace(/https?:\/\/\S+\.(mp4|mov|webm)$/ig, url => `<video controls src="${url}" crossorigin="anonymous"></video>`) // show video urls as players
	  .replace(/(?<!")https?:\/\/\S+/g, url => `<a href="${url}" target="yz.sidebar">${url}</a>`); // show urls as links
      let attachment = '';
      if (file?.startsWith?.('data:image')) attachment = `<a href="${file}" download="${name}"><img class="attachment" src="${file}"></img></a>`;
      else if (file?.startsWith?.('data:audio')) attachment = `<a href="${file}" download="${name}"><audio controls class="attachment" src="${file}"></audio></a>`;
      else if (file?.startsWith?.('data:video')) attachment = `<a href="${file}" download="${name}"><video controls class="attachment" src="${file}"></video></a>`;
      else if (file) attachment = `
<div class="attachment file">
  <a href="${file}" download="${name}">
    <md-icon class="material-icons">attachment</md-icon>
    ${name}
  </a>
</div>`;
      const messageDisplay = message ? `<span class="message">${text}</span>` : '';
      let dataAttributes = `data-tag="${tag}" data-text="${message}"`;
      if (file) dataAttributes += ` data-file="${file}" data-name="${name}"`;
      return `<div class="reply" ${dataAttributes}>${this.formatAttribution(rest)}${attachment}${messageDisplay}</div>`;
    };
    const formattedReplies = items.map(formatReply).join('');
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
    // TODO: Preserve attribution data. Maybe by including the tag reply tag in the url, and metadata in the text?
    const shareable = event.currentTarget.closest('[data-text]');
    const {text, file, name = 'unknown'} = shareable.dataset;
    const {lat, lng} = this;
    console.log('Share', shareable.dataset);
    const url = getShareableURL(this.tag, [this.hashtag]).href;
    let textBase = `New CivilDefense.io alert @${lat},${lng}`;
    const extendedText = text ? `${textBase}\n${text}` : textBase;
    const data = {text: extendedText, url};
    if (file) data.files = [await P2PWebNetwork.dataURL2blob(file, name)];
    share(data);
  }
  startExpiration(selector, remaining) { // Setup or update fader and destroy-on-expiration.
    clearTimeout(this.destroyer);
    this.destroyer = setTimeout(() => this.destroy(), remaining);
    this.startFader(selector, remaining);
  }
  startFader(selector, remaining) { // Set up or update fader on the specified marker element, returning that element.
    const { marker } = this;
    const markerElement = marker.getElement();
    if (!markerElement) return null; // removed (e.g., if expired).
    const element = markerElement.querySelector(selector);
    const fraction = remaining / ttl; // Start at 1 and go to 0, but we may be some way along that.
    const endOpacity = 0.5; // Fully transparent is 0, but that's too hard to see. :-)
    const endGrayscale = 1; // Fully gray.
    let opacity = Math.max(endOpacity, fraction);
    let grayscale = 1 - fraction;
    element.style.filter = `grayscale(${grayscale})`;
    element.style.opacity = opacity;
    // I'd like to let css transitions do the work, but as we zoom, we make different subscriptions and thus start
    // the "same" marker over again. This initial setup clashes with zooming if done with a next-tick step opacity+filter value.
    const interval = 10e3; // Milliseconds / step
    const opacityFade = (endOpacity - opacity) *  interval / remaining; // change / step
    const grayscaleFade = (endGrayscale - grayscale) * interval / remaining;
    clearInterval(this[selector]);
    this[selector] = setInterval(() => {
      element.style.filter = `grayscale(${grayscale += grayscaleFade})`;
      element.style.opacity = (opacity += opacityFade);
    }, interval);
    return element;
  }
}
globalThis.Alert = Alert; // for debugging
