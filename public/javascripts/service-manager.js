const { Request, appVersion } = globalThis;
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


const sources = [
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

  "uuid/index.js"
  // TODO: the libraries
];
/*
async function downloadSource(cacheName) { // Promise to get latest version of all sources into cacheName IFF cacheName exists.
  const cache = await caches.open(cacheName);
  if (await caches.has(cacheName)) {
    const keys = await cache.keys();
    console.log('Cache', cacheName, 'contains', keys);
    if (keys.length >= sources.length) return;
  } else {
    console.log('no cache', cacheName, 'yet');
  }
  await cache.addAll(sources.map(name => new Request(name, {cache: 'no-store'})));
  console.log('Captured source', cacheName);
}

// There are a few things that have to happen before we can check storageVersion and synchronize.
const {promise:promiseAppVersion, resolve:checkedAppVersion} = Promise.withResolvers();
export const promiseSourceReady = Promise.all([ // Resolves when the source is ready.
  downloadSource(appVersion),  // Start it now.
  promiseAppVersion            // app.html and other source matches the service worker.
]);
*/
export const promiseSourceReady = true; // fixme and references
function getServiceVersion(registration) { // Ask the service worker to send back it's version, which will trigger a compare.
  registration.active.postMessage({method: 'version', params: appVersion});
}
//export const serviceWorkerRegistration =
navigator.serviceWorker // without waiting
  .register("/service-worker.js", {updateViaCache: 'none'})
  .then(registration => {
    const checkButton = document.getElementById('checkForUpdates');
    const updateText = document.getElementById('updateStatus');
    console.log('registered', registration, navigator.serviceWorker, navigator.serviceWorker.controller);
    checkButton.onclick = async event => {
      event.stopPropagation();
      await registration.update();
      updateText.textContent = `No update at ${new Date().toLocaleString()}.`;
    };    
    registration.onupdatefound = () => { // A new service worker has been installed because of a service worker script change.
      const newWorker = registration.installing;
      console.log('updatefound', newWorker.state, navigator.serviceWorker, navigator.serviceWorker.controller);
      newWorker.onstatechange = () => {
	console.log('statechange', newWorker.state, navigator.serviceWorker, navigator.serviceWorker.controller);
	// We don't want to nag/confuse the user when installing fresh/first-time. There will not be a controller that time.
	if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
	  // FIXME: At this point, we should be running out of the old appVersion cache, but we're not if there was a reload.

	  // Set up all the buttons and displays in case the user declines the popup.
	  checkButton.style = 'display:none;';
	  const downloadButton = document.getElementById('downloadUpdates');
	  downloadButton.style = '';
	  updateText.textContent = `Update available.`;
	  // No need to reset button/status on click, because we will be reloading.
	  downloadButton.onclick = () => getServiceVersion(registration); // We don't know the new version here yet.

	  // And now the popup.
	  if (confirm("New version available" + '\n' + "Would you like to update now? (You can update later through the button in About.)")) {
	    getServiceVersion(registration);
	  }
	}
      };
    };
    navigator.serviceWorker.addEventListener('controllerchange', event => { // just for debugging, confirming that this page has a new controller.
      console.log("Page: The controller of current browsing context has changed.", navigator.serviceWorker.controller, navigator.serviceWorker.controller === registration.active);
    });
    // addEventListener, allowing other code to listen for other messages.
    navigator.serviceWorker.addEventListener('message', async event => {
      const {method, params} = event.data;
      if (method !== 'version') return;
      console.log('got message from service worker', event.data);
      console.log('Comparing service worker version', params, 'to app version', appVersion);
      if (params === appVersion) {
	console.log('Checked version', appVersion);
	//fixme checkedAppVersion(true);
      } else {
	await caches.delete(appVersion);
	//fixme await downloadSource(params);
	alert(`About to reload from ${appVersion} to ${params}.`); // fixme remove
	location.reload();
      }
    });
  });
