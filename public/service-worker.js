const { Request, Response, clients} = self;
const serviceVersion = '0.0.40';

async function cacheFirst({request, event}) {
  // Handle request from our serviceVersion cache, else fetch and store it.
  const cache = await caches.open(serviceVersion);

  // First try to get the resource from the cache.
  const responseFromCache = await cache.match(request);
  if (responseFromCache) return responseFromCache;

  // Next try to get the resource from the network.
  try {
    const responseFromNetwork = await fetch(request);
    // Put clone of response in cache (so that original can be returned.
    // Tell event to keep worker open while we put it, even though we return response immediately.
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
  console.log('install', event, serviceVersion);
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
  self.skipWaiting();
  event.waitUntil(caches.open(serviceVersion)
		  .then(cache => cache.addAll([
		      "index.html",
		      "favicon.ico",

		      "javascripts/main.js",
		      "javascripts/map.js",
		      "javascripts/hashtags.js",
		      "javascripts/s2.js",
		      "javascripts/translations.js",
		      "javascripts/service-manager.js",

		      "stylesheets/style.css",

		      "images/civil-defense-240.png",
		      "images/qr.svg",
		      "images/share.svg",
		      "images/recenter.svg",

		      // TODO: kdht, webrtc
		      "uuid/index.js"
		      // TODO: rest of uuid
		      // TODO: the libraries
		  ])));
  // These are referenced within material web, but missing. Turns out we don't need them,
  // but let's cache empty responses to keep the console cleaner.
  event.waitUntil(caches.open(serviceVersion)
		  .then(cache => Promise.all([
		    "https://esm.run/npm/lit@3.3.1/+esm",
		    "https://esm.run/npm/tslib@2.8.1/+esm",
		    "https://esm.run/npm/lit@3.3.1/static-html.js/+esm",
		    "https://esm.run/npm/lit@3.3.1/decorators.js/+esm",
		    "https://esm.run/npm/lit@3.3.1/directives/style-map.js/+esm",
		    "https://esm.run/npm/lit@3.3.1/directives/class-map.js/+esm",
		    "https://esm.run/npm/lit@3.3.1/directives/when.js/+esm",
		    "https://esm.run/npm/lit@3.3.1/directives/live.js/+esm",
		  ].map(url => cache.put(new Request(url), new Response("", {headers: { "Content-Type": "text/javascript" }}))))));
});

self.addEventListener('activate', async event => {
  console.log('activate', event);
  // Apply to running clients now, so that first fresh install sees updatefound event.
  // Otherwise, the service worker wouldn't fire until the code NEXT time the page loads after
  // registration, and thus the initial load would not see any updatefound events.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  event.respondWith(cacheFirst({request: event.request, event}));
});

self.addEventListener('message', async event => {
  console.log('service worker got message', event.data);
  const {method, params} = event.data;
  switch (method) {
  case 'version':
    event.waitUntil(event.source.postMessage({method: 'version', params: serviceVersion}));
    break;
  default:
    console.warn(`Unrecognized service worker message: "${event.data}".`);
  }
});
