const { QRCodeStyling, GeolocationPositionError, localStorage, BigInt, URL, Notification, appVersion } = globalThis; // For linters.
import { Int } from './translations.js';
import { openDisplay } from './display.js';
import { Agent} from './agent.js';
import { NetworkClass } from './pubSub.js';
import { getPointInCell } from './s2.js';
import { Marker, map, getShareableURL, showMessage, updateLocation, updateSubscriptions, recenterMap, share } from './map.js';
import './service-manager.js'; // Comment this out and kill service-workers for reload-to-get-latest behavior during development.

document.getElementById('appVersion').textContent = appVersion;

const RETRY_SECONDS = 90;
const INACTIVITY_SECONDS = 5 * 60; // five minutes

export function delay(ms = 800, value = undefined) { // Promise resolves to value after specified milliseconds.
  return new Promise(resolve => setTimeout(resolve, ms, value));
}

var inactivityTimer = null, reconnectCountdown, networkPromise = null;
export { networkPromise };
export async function resetInactivityTimer(clearMessage = true) { // if !network, initialize(false), else disconnect after INACTIVITY_SECONDSif not restarted
  //console.log('resetInactivityTimer, networkPromise:', networkPromise);
  if (clearMessage) showMessage('');
  clearTimeout(inactivityTimer);
  clearInterval(reconnectCountdown);
  if (!networkPromise) return initialize(false);
  // return inactivityTimer = setTimeout(() => {
  //   networkPromise?.then(contact => contact.disconnect());
  // }, INACTIVITY_SECONDS * 1e3);
}

function isWebView() { return /CriOS|(WebView|wv|(iPhone|iPod|iPad)(?!.*Safari))/.test(navigator.userAgent); }
function isApple() { return navigator.platform.startsWith('Mac') || ['iPhone', 'iPad'].includes(navigator.platform); }
function isMobile() { return navigator.userAgentData?.mobile || /iPhone|iPad|iPod|Mobile/.test(navigator.userAgent); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches; }
function osName() { return navigator.userAgentData?.platform || navigator.userAgent.match(/Android/)?.[0] || navigator.platform; }
function mobilePlatformName() { return isMobile() && (isApple() ? 'iOS' : 'Android'); }
function mobileVendorName() { return isMobile() && (isApple() ? 'Apple' : 'Android'); }
function mobileBrowserName() { return isApple() ? 'Safari' : 'Chrome'; }
function browserName() {
  if (navigator.userAgent.includes("Firefox")) return "Firefox";
  if (navigator.userAgent.includes("Edg")) return "Edge";
  if (navigator.userAgent.includes("Chrome")) return "Chrome";
  if (navigator.userAgent.includes("CriOS")) return "Chrome";
  if (navigator.userAgent.includes("Safari")) return "Safari";
  return '';
}

var showNotifications = document.getElementById('showNotifications');
var showNotificationsLabel = document.getElementById('showNotificationsLabel');
function disabledNotifications() { return localStorage.getItem('disabledNotifications'); }
export function disableNotifications(force) { localStorage.setItem('disabledNotifications', force ? '1' : ''); }
export function notificationsAllowed() { return (Notification?.permission === 'granted') && !disabledNotifications(); }
function noteNotificationPermission(permission) {
  if (isWebView()) {
    showNotifications.indeterminate = true;
    showNotifications.toggleAttribute('disabled', true);
    showNotificationsLabel.innerHTML = `${mobileVendorName()} ${Int`does not support notifications on WebViews embedded in other programs. Please use CivilDefense.io in native`} ${mobileBrowserName()}.`;
    return;
  }
  if (isMobile() && isApple() && !isStandalone()) {
    showNotifications.indeterminate = true;
    showNotifications.toggleAttribute('disabled', true);
    showNotificationsLabel.innerHTML = `${Int`Apple only supports mobile notifications for web pages that have been`} <a href="https://www.google.com/search?q=iphone+install+web+page+to+home+screen" target="yz.sidebar">${Int`installed to the home screen`}</a>.`;
    return;
  }
  switch (permission) {
  case 'default':
    showNotifications.indeterminate = true;
    showNotifications.toggleAttribute('disabled', false);
    showNotificationsLabel.innerHTML = Int`Enable notifications`;
    break;
  case 'granted':
    showNotifications.checked = !disabledNotifications();
    showNotifications.toggleAttribute('disabled', false);
    showNotificationsLabel.innerHTML = Int`Allow notifications`;
    break;
  default:
    showNotifications.checked = false;
    showNotifications.toggleAttribute('disabled', true);
    const isApp = isStandalone();
    const search = isApp ?
	  `https://www.google.com/search?q=${osName()}+open+app+settings` :
	  `https://www.google.com/search?q=open+site+settings+${browserName() || `"${navigator.userAgent}"`}`;
    const label = isApp ? `CivilDefense.io ${Int`app`}` : Int`browser site settings`;
    showNotificationsLabel.innerHTML = `${Int`Permissions can be re-enabled through the`} <a href="${search}" target="yz.sidebar">${label}</a>.`;
    break;
  }
}
showNotifications.parentElement.onclick = event => {
  resetInactivityTimer();
  event.stopPropagation();
}
showNotifications.onchange = () => {
  if (window.Notification?.permission === 'granted') {
    disableNotifications(!showNotifications.checked);
  } else {
    window.Notification?.requestPermission().then(noteNotificationPermission);
  }
};
// Safari never fires 'change': https://webkit.org/b/259432
navigator.permissions.query({ name: 'notifications'})
  .then(status => status.onchange = () => noteNotificationPermission(window.Notification?.permission));

export function openAbout(event) {
  openDisplay('aboutContainer', event);
  noteNotificationPermission(window.Notification?.permission);
}
document.getElementById('aboutButton').onclick = event => { // open about
  Marker.closePopup();
  openAbout(event);
};
document.getElementById('wipe').onclick = async event => {
  await networkPromise?.then(contact => contact.disconnectTransports());
  localStorage.clear();
  await caches.keys().then(keys => Promise.all(keys.map(key => caches.delete(key))));
  await navigator.serviceWorker.getRegistrations().then(registrations => Promise.all(registrations.map(r => r.unregister())));
  window.location.replace('https://yz.social/civildefense.html');
};
document.getElementById('scriptChooser').onchange = event => { // Run a script module chosen by the user. e.g., for testing.
  const file = event.currentTarget.files[0];
  if (!file) return;
  const script = document.createElement('script');
  script.type = "module";
  script.src = URL.createObjectURL(file);
  document.body.appendChild(script);
};

document.getElementById('qrButton').onclick = event => { // generate (and display) qr code on-demand (in case url changes)
  const content = openDisplay('qrContainer', event, '');
  const qr = new QRCodeStyling({
    width: 300,
    height: 300,
    margin: 0,
    type: "svg",
    data: getShareableURL().href,
    dotsOptions: {
      color: "#0A2E7C",
      type: "rounded"
    },
    cornersSquareOptions: {type: "dot"},
    cornersDotOptions: {type: "dot"},
    backgroundOptions: {
      color: "white",
    },
    image: "images/civil-defense-240.png",
    imageOptions: {
      crossOrigin: "anonymous",
      margin:2
    }
  });
  qr.append(content);
};
document.querySelector('#correspondentContainer md-outlined-text-field').onclick = event => {
  resetInactivityTimer();
  event.stopPropagation();
};

document.getElementById('share').onclick = event => {
  event.stopPropagation();
  share({text: "CivilDefense.io", url: getShareableURL().href });
};

document.getElementById('recenterButton').onclick = recenterMap;

function checkOnline() { //true if online and visible, else cancel reconnectCountdown and inactivityTimeout, and show "offline"
  //console.log('checkOnline', navigator.onLine && !document.hidden);
  if (navigator.onLine && !document.hidden) return true;
  clearTimeout(inactivityTimer);
  clearInterval(reconnectCountdown);
  if (!navigator.onLine) showMessage(Int`No network connection.`, 'error');
  else console.warn('hidden');
  return false;
}
function resetReconnectCountdown() { // if !checkOnline each second, show time remaining; at expiration initialize(false)
  console.log('resetReconnectCountdown');
  clearInterval(reconnectCountdown);
  let counter = RETRY_SECONDS;
  reconnectCountdown = setInterval(() => {
    if (!checkOnline()) return null;
    if (counter > 1) return showMessage(Int`Disconnected. Retrying in ` + counter-- + Int` seconds.`, 'error');
    showMessage('');
    console.log('countdown timer expired');
    clearInterval(reconnectCountdown);
    return initialize(false);
  }, 1e3);
}

export let positionWatch;
let subscribeOneShot;
const goodPositionLabel = Int`Your Location`;

function initializeGeolocation(subscribe = false) { // Arrange to constantly updateLocation, but:
  // if no support, message and defaultInit
  // if no permission, message and defaultInit
  // if !checkOnline, nothing further
  // if other error; delay and try again
  // ... and ...
  // If this was for a new node, we will be told to subscribe. That cannot meaningfully happen
  // until we get our first position, so we do so ONCE in the watch position handler.
  // Any subsequent location updates will update position in the map, but not move the map
  // nor change the subscriptions.
  const {geolocation} = navigator;  // Get user's geolocation
  console.log('Initializing geolocation.', subscribe ? 'Will subscribe.' : 'Has subscriptions.');
  subscribeOneShot = subscribe;
  const initMap = (lat, lng) => {
    let zoom = 14, positionLabel = goodPositionLabel;
    if (lat === undefined) {
      positionLabel = Int`Default location. Geolocation unavailable.`;
      const level9Cell = localStorage.getItem('level9Cell');
      if (level9Cell) { // Zoomed out near where we last where, but not too exact for security.
	zoom = 12;
	[lat, lng] = getPointInCell(BigInt(level9Cell));
      } else {
	zoom = 13;
	[lat, lng] = [37.7749, -122.4194]; // San Fransisco
      }
    }
    console.log('initializeGeolocation updateLocation');
    updateLocation(lat, lng, zoom, positionLabel);
    if (!subscribeOneShot) return;
    subscribeOneShot = false;
    resetInactivityTimer(false);
    updateSubscriptions([]); // This was for a new node, so supply and empty oldSubscriptions.
  };
  if (!geolocation) {
    showMessage(Int`Geolocation not supported. Using default location.`, 'error', 'fail');
    delay(2e3).then(() => initMap());
    return;
  }
  geolocation.clearWatch(positionWatch);
  positionWatch = geolocation.watchPosition(
    position => {
      const {latitude, longitude} = position.coords;
      console.log('Location update.', map ? 'Map exists.' : 'Will create map.', subscribeOneShot ? 'Will subscribe fresh.' : 'Has subscriptions.');
      initMap(latitude, longitude);
    }, error => {
      geolocation.clearWatch(positionWatch);
      console.warn(`Geolocation code ${error.code}. online:`, navigator.onLine, 'code:', error.code);
      if (navigator.onLine) {
	if (error.code === GeolocationPositionError.PERMISSION_DENIED) {
	  showMessage(Int`Location access denied. Using default location.`, 'error', error);
	  delay(2e3).then(() => initMap());
	} else {
	  showMessage(Int`Unable to get location.`, 'error', error);
	  delay(4e3).then(() => initializeGeolocation(subscribe));
	}
      } else {
	showMessage(Int`No network connection.`, 'error');
      }
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
  console.log('hrs set watch position', positionWatch);
}

let checking = false; // For debouncing.
// On startup, get last persisted portals list, else the portal we came in on.
let portals = new Set(JSON.parse(localStorage.getItem('portals') || `["${new URL('/kdht', window.location).href}"]`));
async function initialize(event) { // Ensure there is a network promise and map, and reset geolocation:
  // debounce
  // if !checkOnline(), return
  // set network to promise a new Contact, set ondisconnect, and connect.
  // delay if asked
  // initializeGeolocation
  if (checking)  return;
  checking = true;
  try {
    // Always close about display, because notification permissions and the like can change in the OS while we're hidden, and safari and mobile chrome don't issue change events for them.
    document.getElementById('aboutContainer').classList.toggle('hidden', true);

    // If networkPromise has not yet been set (or cleared by disconnect), we will be subscribing.
    const needsConnection = !networkPromise;
    const couldConnect = checkOnline(); // Meaning online AND visble (could be hidden)
    console.log('Initialize', appVersion, 'from', event ? event.type : 'reset', networkPromise ? 'Has network.' : 'Needs network.', couldConnect ? 'Is online+visible.' : 'Is not online+visible.');
    if (!couldConnect) {
      navigator?.geolocation.clearWatch(positionWatch);
      if (navigator.onLine) networkPromise?.then(contact => contact.replicateStorage()); // Hidden. Replicate in case we get shut down.
      return;
    }
    showMessage('');
    if (!networkPromise) {
      console.log('Creating node.');
      networkPromise = NetworkClass.create();
      networkPromise.then(contact => {
	console.log('Created node', contact.name);
	globalThis.contact = contact; // For debugging.
	// On leaving, we would like to copy stored data and politely say 'bye' (so others can clean up their connections). Alas:
	// - The events we get will be, in order: beforeunload (except iOS Safari), pagehide, visibilitychange, unload
	// - None of these will wait for any asynchronous operation.
	// - The two unload events are not fired when mobile background tabs are killed.
	// - visibilitychange is also fired when tab is switched.
	// And so the best we can do is:
	// - When tabs are switched, we try to replicate storage.
	//   I think we will always get time to complete this.
	//   But we will stay online as long as we're allowed, at which point we may be asked to store more that will not get replicated if killed.
	// - On pagehide and unload, we synchronously say 'bye' with disconnectTransports.
	//   These two are assigned now with a resolved networkPromise => contact so that we don't have to await.
	window.onpagehide = () => contact.disconnectTransports();
	window.onunload = () => contact.disconnectTransports(); // Safe if called multiple times.

	contact.detachment.then(onPurpose => {
	  networkPromise = null;
	  const message = onPurpose ? Int`Connection closed. Will reconnect on use.` :
		(navigator.onLine ? Int`The service connection has closed. Please reload.` : Int`No network connection.`);
	  console.log('contact detached', {onPurpose, onLine: navigator.onLine});
	  // If/when we reconnect, we will make a new network object with a new GUID,
	  // so as not to confuse other nodes that have given up on the unresponsive old GUID.
	  showMessage(message, 'error');
	});
	contact.connect(...portals)
	  .then(() => contact.subscribe({ // Add and persist any new portals we haven't heard about.
	    eventName: 'sys:portals',
	    handler: data => {
	      const operation = data.payload ? 'add' : 'delete';
	      const resultSet = portals[operation](data.subject);
	      localStorage.setItem('portals', JSON.stringify([...resultSet]));
	    }
	  }));
      });
    }
    if (event) await delay();
    initializeGeolocation(needsConnection);
  } finally {
    checking = false;
  }
}
document.addEventListener('visibilitychange', initialize);
window.addEventListener('online', initialize);

// Set up text for the browser language.
function initText(selector, content = selector) {
  const element = document.querySelector(selector);
  const text = Int([content]);
  element.textContent = text;
}
initText('#aboutReport');
initText('#aboutShared');
initText('#aboutFade');
initText('#aboutAnyone1');
initText('#aboutAnyone2');
initText('#aboutAnyone3');
initText('#learnMore');
initText('#version');
initText('#checkForUpdates');
initText('#downloadUpdates');
initText('#newVersionHeader');
initText('#updateNowQuestion');
initText('#updateReload');
initText('#updateDefer');
initText('#downloadUpdates2');
initText('#downloadDefer');
initText('#describePrivate1');
initText('#describePrivate2');
initText('#describePublic');
initText('#describeSystem');
initText('#pickLabels');
initText('#wipe');

initialize(false);
document.querySelector('head > title').innerHTML = `CivilDefense @${location.hostname}`;
