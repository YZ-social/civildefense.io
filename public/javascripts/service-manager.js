const { Request, Response, URL, localStorage, BroadcastChannel, appVersion } = globalThis;
import { resetInactivityTimer } from './main.js';
import { go } from './map.js';
import { Int } from './translations.js';

/*
  Registers and interacts with the service worker, to provide:

  cached sources with an upgrade path
  -----------------------------------
  key behaviors:
  1. New code won't be used (even on refresh) until the user agrees.
  2. Even a refreshed page does not require the web server. (Access to the DHT must still be provded. That's not handled here.)
  3. Any and all tabs are updated to new version.

  We use the browser's service worker update mechanism to allow the user to control caching and reload with the right version.

  The service WORKER does NOT fill any cache on installation, nor delete old on activation (as many service worker examples do).
  Instead, if the service MANAGER sees that the appVersion cache does not exist yet, it explicitly fills it with the host's current source.

  The service WORKER handles requests from any cache version, rather than just serviceVersion, but stores missing items in serviceVersion.
  Thus the explicitly filled source is from the one-time filling by the service MANAGER.
  Other requests on the web (such as map tiles) are cached to serviceVersion, responded from there, and do not get updated until cache is cleared or new app version installed.

  New service workers on host are picked up and installed, either by the user pressing a button that asks the browser to try to
  update the service worker registration (by looking for a new version on host), or by the browser doing this automatically every 24 hours.
  Either way, it still responds with any resources that have already been cached, including all old source and external resources that have already been cached.
  New external resources that have not yet been cached (e.g. map tiles for areas not yet visited) are fetched and cached under new serviceVersion going forward.
  The user is informed (in About and in a popup), and we persist a marker in storage in case the user reloads (which would not otherwise see a new serviceVersion
  because it already has it).

  When user says to update, the service MANAGER deletes the appVersion cache (so that next step doesn't use old dat), explicitly fills the new serviceVersion cache,
  and then we reload with new v=version parameter.
  This busts the browser's caching so that it reloads index.html from the new cache.
  (The v parameter is stripped on load so that it doesn't hang around. Other parameters such as dht=1 are not affected.)
  The service WORKER responds with the new cached source, and external resources have been pulled no earlier than the host's service worker release.
  We also broadcast to any other open tabs at the same host, so that they reload to the new v as well.
  
  If the user clears cache and reloads (even if there is no source/worker update, or a stale worker), they get the currently hosted versions.
*/


async function cacheSource(version) { // Cache source in the given version.
  const cache = await caches.open(version);
  await cache.addAll([
    "/",
    "/index.html", // Just in case anyone is specifying that.
    "favicon.ico",
    "manifest.json",

    "javascripts/main.js",
    "javascripts/map.js",
    "javascripts/hashtags.js",
    "javascripts/s2.js",
    "javascripts/translations.js",
    "javascripts/service-manager.js",
    "javascripts/pubSub.js",

    "stylesheets/style.css",

    "images/qr-scan.svg",
    "images/share.svg",
    "images/recenter.svg",
    "images/civil-defense-122.png",
    "images/civil-defense-192.png",
    "images/civil-defense-240.png",
    "images/civil-defense-512.png",

    "kdht/index.js",
    "kdht/contacts/contact.js",
    "kdht/contacts/simulations.js",
    "kdht/contacts/webrtc.js",
    "kdht/nodes/helper.js",
    "kdht/nodes/kbucket.js",
    "kdht/nodes/storageBag.js",
    "kdht/nodes/nodeUtilities.js",
    "kdht/nodes/nodeKeys.js",
    "kdht/nodes/nodeRefresh.js",
    "kdht/nodes/nodeStorage.js",
    "kdht/nodes/nodeConnections.js",
    "kdht/nodes/nodeContacts.js",
    "kdht/nodes/nodeMessages.js",
    "kdht/nodes/nodeProbe.js",
    "kdht/nodes/nodePubSub.js",
    "kdht/nodes/node.js",

    "webrtc/index.js",

    "leaflet/leaflet.css",
    "leaflet/leaflet-src.esm.js",
    "leaflet/images/marker-icon.png",
    "leaflet/images/marker-icon-2x.png",
    "leaflet/images/marker-shadow.png",

    "minidenticons/minidenticons.min.js"

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
      updateText.textContent = `${Int`No update at`} ${new Date().toLocaleString()}.`;
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
      switch (method) {
      case 'version':
	console.log('Comparing service worker version', params, 'to app version', appVersion);
	if (params === appVersion) {
	  //console.log('Checked version', appVersion);
	} else {
	  await caches.delete(appVersion); // Must be before cacheSource, or we'll just recache the same files!
	  await cacheSource(params);
	  localStorage.removeItem(newVersionAvailableKey);
	  // Reload, but convince all browsers to re-"fetch" (through the new service worker that is now running).
	  const url = new URL(location.href);
	  url.searchParams.set('v', params); // Preserving any other searchParams.
	  // For any other tabs in THIS browser:
	  new BroadcastChannel('site_control').postMessage({method: 'reload', params: url.href});
	  window.location.assign(url.href);
	}
	break;
      case 'go':
	go(params);
	break;
      default:
	console.error('Unrecognized message from service worker', event.data);
      }
    });
  });
if (localStorage.getItem(newVersionAvailableKey)) newVersionAvailable();
new BroadcastChannel('site_control').onmessage = event => {
  const {method, params} = event.data;
  if (method === 'reload') window.location.assign(params);
};
