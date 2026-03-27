const { Request, Response, URL, localStorage, appVersion } = globalThis;
import { resetInactivityTimer } from './main.js';
/*
  Registers and interacts with the service worker, to provide:

  cached sources with an upgrade path
  -----------------------------------
  key behaviors:
  1. New code won't be used (even on refresh) until the user agrees.
  2. Even a refreshed page does not require the web server. (Access to the DHT must still be provded. That's not handled here.)

  We use the browser's service worker update mechanism to allow the user to control caching and reload with the right version.

  This file exports a const promiseSourceReady, which resolves when we have the source cached for the desired version.
  We require the source file (e.g., the root .html) to define a global string named appVersion.
  The service worker also defines a string named serviceVersion, which will ordinarily match.
  
  Once registered, the service worker intercepts all source requests and serves them from a cache named by serviceVersion.
  However, to get things rolling before registration, this file downloads the explicitly listed files and caches them by appVerion.

  When the #checkForUpdates element is clicked, we request a service worker update from the browser,
  and then (if not altered below), the #updateStatus element is updated to indicate there are no updates at this datetime.
  Otherwise, the browser itself will look for a new version of the service worker on location.host at least every 24 hours.

  Either way, if a service worker update is available, it will be installed by the browser, and we arrange to:
  - change #updateStatus to indicate that an update is available
  - hide the #checkForUpdates button
  - reveal the #downloadUpdates button
  - popup a dismissable dialog telling the user that an update is avilable and asking if they would like to update.

  If the user says they want to update, either through the dialog, or later on through the #downloadUpdates button,
  then we post a 'version' message to the service worker, passing the appVersion.
  The service worker simply posts back its own serviceVerion. (It could potentially do other stuff, but currently does not.)
  When the code here receives that version back, if the versions match it ungates the promiseSourceReady promise, such that
  it will resolve when the source is cached. Otherwise, it deletes the cache for the old version, downloads the source
  for the new version, and reloads. When the app comes back, the cache is full for matching appVersiona and serviceVersion.

  other:
  -----
  This file exports a const serviceWorkerRegistration promise.
*/


async function cacheSource(version) { // Cache source in the given version.
  const cache = await caches.open(version);
  await cache.addAll([
    "/",  // If we don't cache root, then a request to root will pick up a new version instead of the cached one!
    "/?dht=0",
    "/?dht=1",
    `/?v=${version}`, // When updating, we cache-bust the browser by explicitly loading this.
    `/?dht=0&v=${version}`,
    `/?dht=1&v=${version}`,
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
  ]);
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
}


function getServiceVersion(registration) { // Ask the service worker to send back it's version, which will trigger a compare.
  registration.active.postMessage({method: 'version', params: appVersion});
}

const checkButton = document.getElementById('checkForUpdates');
const updateText = document.getElementById('updateStatus');
const downloadButton = document.getElementById('downloadUpdates');
const downloadButton2 = document.getElementById('downloadUpdates2');
const dialog = document.getElementById('uploadAvailable');
const newVersionAvailableKey = 'newVersionAvailable';

function newVersionAvailable() {
  // Set up all the buttons and displays in case the user declines the popup,
  // and then open the popup.
  checkButton.classList.toggle('hidden', true);
  downloadButton.classList.toggle('hidden', false);
  updateText.textContent = `Update available.`;
  dialog.classList.toggle('hidden', false);
  dialog.onclick = () => {
    resetInactivityTimer();
    dialog.classList.toggle('hidden', true);
  };
}

// First time or after clearing cache, cache latest version of app.
if (!(await caches.has(appVersion))) cacheSource(appVersion);

await navigator.serviceWorker
  .register("/service-worker.js", {updateViaCache: 'none'})
  .then(registration => {
    // No need to reset button/status on click, because we will be reloading.
    downloadButton.onclick = () => getServiceVersion(registration); // We don't know the new version here yet.
    downloadButton2.onclick = event => {
      event.stopPropagation();
      getServiceVersion(registration);
    };
    checkButton.onclick = async event => {
      resetInactivityTimer();
      event.stopPropagation();
      await registration.update();
      updateText.textContent = `No update at ${new Date().toLocaleString()}.`;
    };
    registration.onupdatefound = () => { // A new service worker has been installed because of a service worker script change.
      const newWorker = registration.installing;
      //console.log('updatefound', newWorker.state, navigator.serviceWorker, navigator.serviceWorker.controller);
      newWorker.onstatechange = () => {
	//console.log('statechange', newWorker.state, navigator.serviceWorker, navigator.serviceWorker.controller);
	// We don't want to nag/confuse the user when installing fresh/first-time. There will not be a controller that time.
	if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
	  localStorage.setItem(newVersionAvailableKey, 'true');
	  newVersionAvailable();
	}
      };
    };
    // addEventListener, allowing other code to listen for other messages.
    navigator.serviceWorker.addEventListener('message', async event => {
      const {method, params} = event.data;
      if (method !== 'version') return;
      console.log('Comparing service worker version', params, 'to app version', appVersion);
      if (params === appVersion) {
	console.log('Checked version', appVersion);
      } else {
	await cacheSource(params);
	await caches.delete(appVersion);
	localStorage.removeItem(newVersionAvailableKey);
	console.log('only cache', params, 'should exist now:', await caches.keys());
	// Reload, but convince all browsers to re-"fech" (through the new service worker that is now running).
	const url = new URL(location.href);
	url.searchParams.set('v', params);
	// For any other tabs in THIS browser:
	new BroadcastChannel('site_control').postMessage({method: 'reload', params: url.href});
	//alert(`About to reload ${url.href} from ${appVersion} to ${params}.`); // fixme remove
	window.location.assign(url.href);
      }
    });
  });
if (localStorage.getItem(newVersionAvailableKey)) newVersionAvailable();
new BroadcastChannel('site_control').onmessage = event => {
  const {method, params} = event.data;
  if (method === 'reload') window.location.assign(params);
};
