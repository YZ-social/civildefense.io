const { Request, Response, URL, clients} = self;
// Little point in trying to automatically pull this through package.json, as we need a byte change in THIS file to trigger a new worker.
const serviceVersion = '5.4.12';
const releaseNotesURL = 'https://docs.google.com/document/d/1-r20C6UVdHxO5kD3DvTknnO6OcpZqbEALVJ4nJ5rf5c/edit?usp=sharing';

function delay(ms) { // Promise to resolve in the specified number of milliseconds.
  return new Promise(resolve => setTimeout(resolve, ms));
}

const cacheList = [ // The files we need.
  "/",
  "/index.html", // Just in case anyone is specifying that.
  "favicon.ico",
  "manifest.json",
  "package.json",

  "javascripts/versions.js",
  "javascripts/main.js",
  "javascripts/display.js",
  "javascripts/conversation.js",
  "javascripts/alert.js",
  "javascripts/map.js",
  "javascripts/hashtags.js",
  "javascripts/s2.js",
  "javascripts/agent.js",
  "javascripts/translations.js",
  "javascripts/service-manager.js",
  "javascripts/p2pWebNetwork.js",
  "javascripts/protocol.js",
  "javascripts/pubsub.js",

  "stylesheets/style.css",

  "images/qr-scan.svg",
  "images/share.svg",
  "images/recenter.svg",
  "images/civil-defense-122.png",
  "images/civil-defense-192.png",
  "images/civil-defense-240.png",
  "images/civil-defense-512.png",

  "axona-protocol/src/index.js",
  "axona-protocol/src/errors.js",
  "axona-protocol/src/connect.js",
  "axona-protocol/src/bridgeDirectory.js",
  "axona-protocol/src/contracts/Transport.js",
  "axona-protocol/src/contracts/DHT.js",
  "axona-protocol/src/contracts/BootstrapService.js",
  "axona-protocol/src/identity/index.js",
  "axona-protocol/src/identity/nodeid.js",
  "axona-protocol/src/pow/pow.js",
  "axona-protocol/src/dht/AxonaPeer.js",
  "axona-protocol/src/dht/AxonaDomain.js",
  "axona-protocol/src/dht/DHTNode.js",
  "axona-protocol/src/dht/NeuronNode.js",
  "axona-protocol/src/dht/Synapse.js",
  "axona-protocol/src/dht/Subscription.js",
  "axona-protocol/src/pubsub/AxonaManager.js",
  "axona-protocol/src/pubsub/authorClass.js",
  "axona-protocol/src/pubsub/ids.js",
  "axona-protocol/src/pubsub/dispatch.js",
  "axona-protocol/src/pubsub/durability.js",
  "axona-protocol/src/pubsub/rootClaim.js",
  "axona-protocol/src/pubsub/constants.js",
  "axona-protocol/src/pubsub/topicStore.js",
  "axona-protocol/src/pubsub/rootElection.js",
  "axona-protocol/src/pubsub/syncEngine.js",
  "axona-protocol/src/pubsub/repairPlane.js",
  "axona-protocol/src/pubsub/wireHandlers.js",
  "axona-protocol/src/pubsub/writeFlight.js",
  "axona-protocol/src/pubsub/ackProof.js",
  "axona-protocol/src/pubsub/kill.js",
  "axona-protocol/src/pubsub/touch.js",
  "axona-protocol/src/pubsub/post.js",
  "axona-protocol/src/pubsub/unpub.js",
  "axona-protocol/src/pubsub/envelope.js",
  "axona-protocol/src/pubsub/ed25519.js",
  "axona-protocol/src/pubsub/metrics.js",
  "axona-protocol/src/utils/region-names.js",
  "axona-protocol/src/utils/geo.js",
  "axona-protocol/src/utils/s2.js",
  "axona-protocol/src/utils/hexid.js",
  "axona-protocol/src/transport/handshake.js",
  "axona-protocol/src/transport/handshake-auth.js",
  "axona-protocol/src/transport/wire.js",
  "axona-protocol/src/transport/web/index.js",
  "axona-protocol/src/transport/web/mesh.js",
  "axona-protocol/src/transport/web/mesh-auth.js",
  "axona-protocol/src/transport/web/webrtc.js",
  "axona-protocol/src/transport/web/bridge.js",
  "axona-protocol/src/transport/web/composite.js",
  "axona-protocol/src/transport/sim/index.js",
  "axona-protocol/src/transport/sim/network.js",
  "axona-protocol/src/transport/sim/transport.js",
  "axona-protocol/src/persistence/interface.js",
  "axona-protocol/src/crypto/noble-ed25519.js",
  "axona-protocol/std/index.js",
  "axona-protocol/std/chunk.js",

  "leaflet/leaflet.css",
  "leaflet/leaflet-src.esm.js",
  "leaflet/leaflet-src.esm.js.map",
  "leaflet/images/marker-icon.png",
  "leaflet/images/marker-icon-2x.png",
  "leaflet/images/marker-shadow.png",

  "pica/pica.min.js",
  "minidenticons/minidenticons.min.js",
  "marked/marked.esm.js",
  "marked/marked.esm.js.map",
  "dompurify/purify.es.mjs",
  "dompurify/purify.es.mjs.map",
  "s2js/s2js.esm.js",
  "s2js/s2js.esm.js.map",
  "bigfloat/esm/index.js",
  "bigfloat/esm/BigFloat32",
  "bigfloat/esm/BigFloat53",
  "bigfloat/esm/BigComplex",
  "bigfloat/esm/BaseInfo32",
  "bigfloat/esm/util",

  // TODO: the libraries
];

async function cacheFirst({request, event}) {
  // Handle request from any cache, else fetch and store it in serviceCache.

  // First try to get the resource from the cache (any version).
  const url = new URL(request.url);
  const ignoreSearch = url.pathname === '/'; // Regardless of lat/lng, tags, etc. Hopefully no external map or font resources are on root!
  const responseFromCache = await caches.match(request, {ignoreSearch});
  if (responseFromCache) return responseFromCache;

  // Next try to get the resource from the network.
  try {
    const responseFromNetwork = await fetch(request);
    if (request.method !== 'GET' || request.cache === 'no-store') return responseFromNetwork; // Cache shouldn't allow anyway.
    const mime = responseFromNetwork.headers.get("Content-Type");
    if (/^(audio|video)\//.test(mime)) return responseFromNetwork; // Do not cache streamable media.
    // Put clone of response in cache (so that original can be returned.
    // Tell event to keep worker open while we put it, even though we return response immediately.
    const cache = await caches.open(serviceVersion);
    event.waitUntil(cache.put(request, responseFromNetwork.clone())
		    .catch(error => console.error(request.url, mime, error)));
    return responseFromNetwork;
  } catch (error) {
    console.error(request.url, error);
    // There is nothing we can do, but we must always return a Response object
    return new Response("Network error", {
      status: 408,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

// EVENT HANDLERS

// Install all the resources we need, so that we can work offline.
// (Users, groups, and media are cached separately in indexeddb.)
self.addEventListener('install', event => {
  console.log('Install service worker', serviceVersion);
  // IF a service worker is updated, the old service worker is active, and by default,
  // the new one will not be activated until the old one dies. This is our only chance to
  // tell the browser to skipWaiting, and activate the new service worker right away,
  // allowing restarted main code to compare versions and bootstrap itself onto the new main code.
  //
  // However, even though skipWaiting answers a promise, we do NOT want to waitUntil it resolves
  // (as for claim in activate, below), because on Safari, that causes the new worker to activate
  // BEFORE the main script's 'installed' state change fires, thus executing with a non-null
  // serviceWorker.controller, and thus telling the user that there is a download available.
  // Fortunately, leaving out the waitUntil seems to get the expected activation timing. And indeed,
  // the MDN doc for skipWaiting does not use waitUntil either.
  //
  // Alas, there's still a screw case in Safari: The panic button unregisters service workers,
  // but in Safari, the service worker stays running until the page is closed. Even a reload
  // or setting location.href will keep the old service worker around. This means that a reload
  // after panic will cause a harmless but confusing "new version available" popup. Instead,
  // one must manually close the tab after panic.
  let p = self.skipWaiting();
  event.waitUntil(p);
});

self.addEventListener('activate', async event => {
  console.log('Activate service worker', serviceVersion);
  // Apply to running clients now, so that first fresh install sees updatefound event.
  // Otherwise, the service worker wouldn't fire until the code NEXT time the page loads after
  // registration, and thus the initial load would not see any updatefound events.
  event.waitUntil(self.clients.claim().then(() => expireStaleAlerts(0, 'activate')));
});

self.addEventListener('fetch', event => {
  event.respondWith(cacheFirst({request: event.request, event}));
});

async function cacheSource(version, event) { // Cache source in the given version.
  console.log(`service-worker ${serviceVersion} is caching source in cache ${version}.`);
  const cache = await caches.open(version);
  await Promise.all([
    // These are referenced within material web, but missing. Turns out we don't need them,
    // but let's cache empty responses to keep the console cleaner.
    "https://esm.run/npm/tslib@2.8.1/+esm",
    "https://esm.run/npm/lit@3.3.3/+esm",
    "https://esm.run/npm/lit@3.3.3/static-html.js/+esm",
    "https://esm.run/npm/lit@3.3.3/decorators.js/+esm",
    "https://esm.run/npm/lit@3.3.3/directives/style-map.js/+esm",
    "https://esm.run/npm/lit@3.3.3/directives/class-map.js/+esm",
    "https://esm.run/npm/lit@3.3.3/directives/when.js/+esm",
    "https://esm.run/npm/lit@3.3.3/directives/live.js/+esm",
  ].map(url => cache.put(new Request(url),
                         new Response("", {headers: { "Content-Type": "text/javascript" }}))));

  await Promise.all(cacheList.map(file => cache.add(file)
				  .catch(error => console.error(file + ' ' + error.message))));

  return version;
}

// The service worker is stopped and restarted for events, and so we can't keep an in-memory set of issued alerts.
// Here we keep it in cache, and manually clean up expired entries.
const alertCache = 'seenNotifications';
const ALERT_EXPIRATION_MS = 24 * 60 * 60e3;
async function issuableAlert(notificationTag, issuedTime) { // Returns true IFF we are not expired and have not previously asked.
  const now = Date.now();
  const expiration = now - ALERT_EXPIRATION_MS;
  const cache = await caches.open(alertCache);
  if (issuedTime < expiration) { // Check BEFORE consulting cache, which doesn't keep expired stuff.
    await cache.delete(notificationTag);
    return false;
  }
  const response = await cache.match(notificationTag);
  console.log('issueableAlert', {notificationTag, response});
  if (response) return false;
  await cache.put(notificationTag, Response.json(issuedTime));
  return true;
}
async function expireStaleAlerts(increment = 0, source) { // Maintenance: declutter notifications and cache storage.
  const now = Date.now();
  const expiration = now - ALERT_EXPIRATION_MS;
  const cache = await caches.open(alertCache);
  const notifications = await self.registration.getNotifications();

  // Remove stale cache data.
  for (const key of await cache.keys()) {
    const response = await cache.match(key);
    const issued = await response.json();
    if (issued > expiration ) continue;
    console.log('removing stale seen', key);
    cache.delete(key);
  }
  // Collect stale notifications.
  const toCancel = notifications.filter(notification => notification.timestamp < expiration);
  const count = increment + notifications.length - toCancel.length;
  console.log('setAppBadge', {source, increment, notifications, toCancel, count});
  if (count > 0) await navigator.setAppBadge(count);
  else await navigator.clearAppBadge();
  // Cancel them.
  toCancel.forEach(notification => notification.close());
  return count;
}


// Chrome has a bug such that calling registration.getNotifications right after registration.showNotification will break the notification.
// The notification won't be clickable, and it won't be listed in getNotifications.
// Similarly, notification.close will still be present in getNotifications if called too soon.
// We cannot control how quickly showNotifications or canceNotification calls will happen (e.g., from opening an alert with lots of replies, or lots of pushes),
// and so we serialize each call, with a delay.
let notificationQueue = Promise.resolve();
function showNotification({lat, lng, issuedTime, hashtag, msgId, alert, body = '', force = false}) { // Promise to show a platform notification. There are two paths to here:
  // 1. The app handles data from network connections, and determines that it should alert the user.
  //    In this case, the app sends the data to this service worker.
  // 2. An upstream node would like to send the data over the network, but finds that we are not connected,
  //    and so pushes the the network envelope directly to the service worker.
  // Abstractly, this function could be in either app or service worker, but the app might not be running
  // in path 2, so it has to be here if we want to have the code in just one place.
  // Any filtering (e.g., do not show notifications for one's own alerts) happens upstream of here. (We don't know the Agent.current and the sender isn't in the notification.)
  // force could be used for special messages (e.g., that your sticky subscription is about to expire), but is not used yet.
  return notificationQueue = notificationQueue.then(async () => {
    if (!await issuableAlert(msgId, issuedTime)) return;
    const base = location.href;
    const timestamp = issuedTime;
    const icon = new URL('./images/civil-defense-192.png', base).href;
    const queryString = `./?tags=${encodeURIComponent(hashtag)}&lat=${lat}&lng=${lng}&alert=${alert}`;
    const url = new URL(queryString, base).href; // For opening page when it has been closed.
    const data = {lat, lng, alert, url};
    // If we turn on {tag: alert||msgId, renotify: true} again, beware of cancelling notifications for deleted replies.
    // See https://docs.google.com/document/d/1ZMC0JLlUbC5XnOP-oyseSUrEhByfGjPgam9mo7B9qls/edit?usp=sharing
    const options = {icon, timestamp, body, data, tag: msgId};
    // Debugging note: msgId will be alertCache from the issuableAlert test, but will not be counted in expireStaleAlerts.
    const count = await expireStaleAlerts(1, 'showNotification'); // BEFORE creating new notifications. See comment about Chrome.
    console.log('showNotification', {msgId, hashtag, options, count});
    await self.registration.showNotification(hashtag, options);
    await delay(500); // Allow chrome to get out of the way of the OS before the next one in our serialization.
  });
}

function showNotificationFromEnvelope({deleted, message, msgId}) { // We get the generic, application-independent envelope.
  console.log('received push', msgId, deleted ? 'cancel' : '');
  if (deleted) return cancelNotification(msgId);
  const {issuedTime, hashtag, payload, alert = msgId} = message;
  let {lat, lng, label = '', message:body = label, name = ''} = payload;
  body ||= name;
  return showNotification({alert, msgId, lat, lng, issuedTime, hashtag, body});
}

function cancelNotification(tag, body = '') { // Cancel those that match tag, and if body, then only those also matching body.
  return notificationQueue = notificationQueue.then(async () => {
    const notifications = await self.registration.getNotifications({tag});
    const toCancel = notifications.filter(notification => !body || (body === notification.body));
    await expireStaleAlerts(-toCancel.length, 'cancelNotification');
    // In principle, we could remove the cancelled notifications from alertCache, as we SHOULD NOT try to notify them again.
    // But it is conceivable that a network blip could cause a resubscribe to see a pub followed by a separate re-cancel, and
    // we don't want to see that in notifications. So we'll keep it in alertCache until it actually expires.
    for (const notification of toCancel) {
      notification.close();
      await delay(500);
    }
  });
}

self.addEventListener('message', event => {
  const {method, params = []} = event.data;
  switch (method) {
  case 'version':
    event.waitUntil(event.source.postMessage({method: 'version', params: {serviceVersion, releaseNotesURL}}));
    break;
  case 'cacheSource': // Cache source in the given version.
    event.waitUntil(cacheSource(params, event)
		    .then(version => event.source.postMessage({method: 'cached', params: version})));
    break;
  case 'notify':
    event.waitUntil(showNotification(params));
    break;
  case 'cancelNotification':
    event.waitUntil(cancelNotification(...params));
    break;
  case 'expireStaleAlerts':
    event.waitUntil(expireStaleAlerts(...params));
    break;
  default:
    console.warn(`Unrecognized service worker message: "${event.data}".`);
  }
});

self.addEventListener('push', event => event.waitUntil(showNotificationFromEnvelope(event.data.json())));

self.addEventListener('notificationclick', event => {
  const {notification} = event;
  const {title, body, tag, data, timestamp} = notification;
  event.waitUntil(new Promise(async resolve => {
    const expiration = Date.now() - ALERT_EXPIRATION_MS;
    const increment = timestamp < expiration ? 0 : -1;
    const update = async () => { // Used in three places.
      await expireStaleAlerts(increment, 'notificationclick');
      notification.close(); // Do not remove from alertCache, as resubscribing may try to notify again.
      resolve();
    };
    if (!data) {
      console.log('no data in notification', notification);
      await update();
      return;
    }
    // Look to see if the current is already open and focuses if it is. Else opens one.
    // Either way, we try to wake up the app before counting notifications.
    const clientList = await clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of clientList) {
      console.log('notificationclick found client', notification, clientList);
      await client.focus();
      await client.postMessage({method: 'go', params: {alert: tag, ...data}});
      await update();
      return;
    }
    // Client has been closed. Open one.
    console.log('notificationclick opening client', notification);
    await clients.openWindow(data.url);
    await update();
  }));
});
