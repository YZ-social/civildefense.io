const { Request, Response, URL, clients} = self;
// Little point in trying to automatically pull this through package.json, as we need a byte change in THIS file to trigger a new worker.
const serviceVersion = '4.3.0';

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
    // Put clone of response in cache (so that original can be returned.
    // Tell event to keep worker open while we put it, even though we return response immediately.
    const cache = await caches.open(serviceVersion);
    event.waitUntil(cache.put(request, responseFromNetwork.clone()));
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
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(cacheFirst({request: event.request, event}));
});

async function cacheSource(version, event) { // Cache source in the given version.
  console.log(`service-worker ${serviceVersion} is caching source in cache ${version}.`);
  const cache = await caches.open(version);
  await cache.addAll([
    "/",
    "/index.html", // Just in case anyone is specifying that.
    "favicon.ico",
    "manifest.json",
    "package.json",

    "javascripts/versions.js",
    "javascripts/main.js",
    "javascripts/display.js",
    "javascripts/map.js",
    "javascripts/hashtags.js",
    "javascripts/s2.js",
    "javascripts/agent.js",
    "javascripts/translations.js",
    "javascripts/service-manager.js",
    "javascripts/p2pWebNetwork.js",

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
    "leaflet/images/marker-icon.png",
    "leaflet/images/marker-icon-2x.png",
    "leaflet/images/marker-shadow.png",

    "pica/pica.min.js",
    "minidenticons/minidenticons.min.js",
    "s2js/s2js.esm.js",
    "bigfloat/esm/index.js",
    "bigfloat/esm/BigFloat32",
    "bigfloat/esm/BigFloat53",
    "bigfloat/esm/BigComplex",
    "bigfloat/esm/BaseInfo32",
    "bigfloat/esm/util",

    // TODO: the libraries
  ].map(name => new Request(name, {cache: 'no-store'}))); // Might not be necessary, but if any browsers insist on their own caching...
  await Promise.all([
    // These are referenced within material web, but missing. Turns out we don't need them,
    // but let's cache empty responses to keep the console cleaner.
    "https://esm.run/npm/lit@3.3.1/+esm",
    "https://esm.run/npm/tslib@2.8.1/+esm",
    "https://esm.run/npm/lit@3.3.1/static-html.js/+esm",
    "https://esm.run/npm/lit@3.3.1/decorators.js/+esm",
    "https://esm.run/npm/lit@3.3.1/directives/style-map.js/+esm",
    "https://esm.run/npm/lit@3.3.1/directives/class-map.js/+esm",
    "https://esm.run/npm/lit@3.3.1/directives/when.js/+esm",
    "https://esm.run/npm/lit@3.3.1/directives/live.js/+esm",
  ].map(url => cache.put(new Request(url),
                         new Response("", {headers: { "Content-Type": "text/javascript" }}))));
  return version;
}


self.addEventListener('message', async event => {
  const {method, params} = event.data;
  switch (method) {
  case 'version':
    event.waitUntil(event.source.postMessage({method: 'version', params: serviceVersion}));
    break;
  case 'cacheSource': // Cache source in the given version.
    event.waitUntil(cacheSource(params, event)
		    .then(version => event.source.postMessage({method: 'cached', params: version})));
    break;
  default:
    console.warn(`Unrecognized service worker message: "${event.data}".`);
  }
});

self.addEventListener('notificationclick', event => {
  const {notification} = event;
  const {title, body, tag, data} = notification;
  notification.close();
  if (!data) return console.log('no data in notification', notification);
  // This looks to see if the current is already open and focuses if it is. Else opens one.
  event.waitUntil(
    clients
      .matchAll({type: 'window', includeUncontrolled: true})
      .then(async clientList => {
	console.log('notification', {title, body, data, clientList});
        for (const client of clientList) {
	  console.log('notification click found client');
	  return client.focus().then(() => client.postMessage({method: 'go', params: {subject: tag, ...data}}));
        }
	// Client has been closed. Open one.
	console.log('notification click opening client', data.url);
	return clients.openWindow(data.url);
      }),
  );
});
