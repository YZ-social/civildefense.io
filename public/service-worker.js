const { Request, Response, URL, clients} = self;
const serviceVersion = '0.0.53';

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
  self.skipWaiting();
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

self.addEventListener('message', async event => {
  //console.log('service worker got message', event.data);
  const {method, params} = event.data;
  switch (method) {
  case 'version':
    event.waitUntil(event.source.postMessage({method: 'version', params: serviceVersion}));
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
