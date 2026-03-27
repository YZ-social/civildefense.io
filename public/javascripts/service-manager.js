const { Request, appVersion } = globalThis;
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


function getServiceVersion(registration) { // Ask the service worker to send back it's version, which will trigger a compare.
  registration.active.postMessage({method: 'version', params: appVersion});
}

navigator.serviceWorker // without waiting
  .register("/service-worker.js", {updateViaCache: 'none'}) // Always check host.
  .then(registration => {
    const checkButton = document.getElementById('checkForUpdates');
    const updateText = document.getElementById('updateStatus');
    console.log('registered', registration, navigator.serviceWorker, navigator.serviceWorker.controller);
    checkButton.onclick = async event => {
      resetInactivityTimer();
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
	  const downloadButton = document.getElementById('downloadUpdates');
	  const downloadButton2 = document.getElementById('downloadUpdates2');
	  const dialog = document.getElementById('uploadAvailable');
	  checkButton.classList.toggle('hidden', true);
	  downloadButton.classList.toggle('hidden', false);
	  updateText.textContent = `Update available.`;
	  // No need to reset button/status on click, because we will be reloading.
	  downloadButton.onclick = () => getServiceVersion(registration); // We don't know the new version here yet.

	  // And now the popup
	  dialog.classList.toggle('hidden', false);
	  downloadButton2.onclick = event => {
	    console.log('starting version exchange');	    
	    event.stopPropagation();
	    getServiceVersion(registration);
	  };
	  dialog.onclick = () => {
	    resetInactivityTimer();
	    dialog.classList.toggle('hidden', true);
	  };
	}
      };
    };
    // addEventListener, allowing other code to listen for other messages.
    navigator.serviceWorker.addEventListener('message', async event => {
      const {method, params} = event.data;
      if (method !== 'version') return;
      console.log('got message from service worker', event.data);
      console.log('Comparing service worker version', params, 'to app version', appVersion);
      if (params === appVersion) {
	console.log('Checked version', appVersion);
      } else {
	await caches.delete(appVersion);
	//fixme await downloadSource(params);
	alert(`About to reload from ${appVersion} to ${params}.`); // fixme remove
	location.reload();
      }
    });
  });
