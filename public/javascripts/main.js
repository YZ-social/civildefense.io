import { Int } from './translations.js';
import { NetworkClass } from './pubSub.js';
import { getPointInCell } from './s2.js';
import { Marker, map, getShareableURL, showMessage, updateLocation, updateSubscriptions, recenterMap, share } from './map.js';
import './service-manager.js'; // Comment this out and kill service-workers for reload-to-get-latest behavior during development.
const { QRCodeStyling, GeolocationPositionError, localStorage, BigInt, URL, appVersion } = globalThis; // For linters.

document.getElementById('appVersion').textContent = appVersion;

const RETRY_SECONDS = 90;
const INACTIVITY_SECONDS = 5 * 60; // five minutes

var qrDisplayContainer = document.getElementById('qrDisplayContainer');
var qrDisplay = document.getElementById('qrDisplay');
document.getElementById('qrButton').onclick = () => { // generate (and display) qr code on-demand (in case url changes)
  resetInactivityTimer();
  const qr = new QRCodeStyling({
    width: 300,
    height: 300,
    type: "svg",
    data: getShareableURL().href,
    dotsOptions: {
      color: "#0A2E7C",
      type: "rounded"
    },
    backgroundOptions: {
      color: "#e9ebee",
    },
    image: "images/civil-defense-240.png",
    imageOptions: {
      crossOrigin: "anonymous",
      margin: 10
    }
  });
  qrDisplay.innerHTML = '';
  qr.append(qrDisplay);
  qrDisplayContainer.classList.toggle('hidden', false);
}
qrDisplayContainer.onclick = () => {
  resetInactivityTimer();
  qrDisplayContainer.classList.toggle('hidden', true);
}
document.getElementById('share').onclick = () => share({text: "CivilDefense.io", url: getShareableURL().href });

document.getElementById('recenterButton').onclick = recenterMap;

export function delay(ms = 1e3) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let inactivityTimer, reconnectCountdown, networkPromise = null;
export { networkPromise };
export async function resetInactivityTimer(clearMessage = true) { // if !network, initialize(false), else disconnect after INACTIVITY_SECONDSif not restarted
  //console.log('resetInactivityTimer, networkPromise:', networkPromise);
  if (clearMessage) showMessage('');
  clearTimeout(inactivityTimer);
  clearInterval(reconnectCountdown);
  if (!networkPromise) return initialize(false);
  return inactivityTimer = setTimeout(() => {
    networkPromise?.then(contact => contact.disconnect());
  }, INACTIVITY_SECONDS * 1e3);
}

function checkOnline() { //true if online and visible, else cancel reconnectCountdown and inactivityTimeout, and show "offline"
  //console.log('checkOnline', navigator.onLine && !document.hidden);
  if (navigator.onLine && !document.hidden) return true;
  clearTimeout(inactivityTimer);
  clearInterval(reconnectCountdown);
  if (navigator.onLine) showMessage(Int`No network connection.`, 'error');
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

let positionWatch, subscribeOneShot;
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
    let zoom = 14;
    if (lat === undefined) {
      const level9Cell = localStorage.getItem('level9Cell');
      if (level9Cell) { // Zoomed out near where we last where, but not too exact for security.
	zoom = 12;
	[lat, lng] = getPointInCell(BigInt(level9Cell));
      } else {
	zoom = 13;
	[lat, lng] = [37.7749, -122.4194]; // San Fransisco
      }
    }
    updateLocation(lat, lng, zoom);
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
}

let checking = false; // For debouncing.
async function initialize(event) { // Ensure there is a network promise and map, and reset geolocation:
  // debounce
  // if !checkOnline(), return
  // set network to promise a new Contact, set ondisconnect, and connect.
  // delay if asked
  // initializeGeolocation
  if (checking) return;
  checking = true;
  try {
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
	contact.detachment.then(onPurpose => {
	  networkPromise = null;
	  const message = onPurpose ? Int`Connection closed due to inactivity. Will reconnect on use.` :
		(navigator.onLine ? Int`The service connection has closed. Please reload.` : Int`No network connection.`);
	  console.log('contact detached', {onPurpose, onLine: navigator.onLine});
	  // If/when we reconnect, we will make a new network object with a new GUID,
	  // so as not to confuse other nodes that have given up on the unresponsive old GUID.
	  showMessage(message, 'error');
	});
	const portals = [new URL('/kdht', window.location).href, 'https://civildefense.io/kdht', 'https://ki1r0y.com/kdht'];
	contact.connect(...portals).then(() => console.log('connected'));
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
//initText('div.about-text', 'About');
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

initialize(false);
document.querySelector('head > title').innerHTML = `CivilDefense @${location.hostname}`;
