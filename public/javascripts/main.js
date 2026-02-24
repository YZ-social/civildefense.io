import { Int } from './translations.js';
import { NetworkClass } from './pubSub.js';
import { map, showMessage, defaultInit, updateLocation, updateSubscriptions, recenterMap } from './map.js';
const { QRCodeStyling, GeolocationPositionError } = globalThis; // For linters.

const RETRY_SECONDS = 90;
const INACTIVITY_SECONDS = 5 * 60; // five minutes

var aboutContent = document.getElementById('aboutContent');
document.getElementById('aboutButton').onclick = () => {
  resetInactivityTimer();
  aboutContent.classList.toggle('hidden', false);
};
aboutContent.onclick = () => {
  resetInactivityTimer();
  aboutContent.classList.toggle('hidden', true);
};

var qrDisplayContainer = document.getElementById('qrDisplayContainer');
var qrDisplay = document.getElementById('qrDisplay');
document.getElementById('qrButton').onclick = () => { // generate (and display) qr code on-demand (in case url changes)
  resetInactivityTimer();
  const qr = new QRCodeStyling({
    width: 300,
    height: 300,
    type: "svg",
    data: location.href,
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

document.getElementById('recenterButton').onclick = recenterMap;

function delay(ms = 1e3) {
  new Promise(resolve => setTimeout(resolve, ms));
}

let inactivityTimer, reconnectCountdown, networkPromise = null;
export { networkPromise };
export async function resetInactivityTimer() { // if !network, initialize(false), else disconnect after INACTIVITY_SECONDSif not restarted
  console.log('resetInactivityTimer, networkPromise:', networkPromise);
  showMessage(''); // Clearing any messages
  clearTimeout(inactivityTimer);
  clearInterval(reconnectCountdown);
  if (!networkPromise) return initialize(false);
  return inactivityTimer = setTimeout(() => {
    showMessage(Int`Connection closed due to inactivity. Will reconnect on use.`, 'error');
    networkPromise.then(contact => contact.disconnect());
  }, INACTIVITY_SECONDS * 1e3);
}

function checkOnline() { //true if online and visible, else cancel reconnectCountdown and inactivityTimeout, and show "offline"
  console.log('checkOnline', navigator.onLine && !document.hidden);
  if (navigator.onLine && !document.hidden) return true;
  clearTimeout(inactivityTimer);
  clearInterval(reconnectCountdown);
  showMessage(Int`No network connection.`, 'error');
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
  console.log('initializeGeolocation. subscribe:', subscribe);
  subscribeOneShot = subscribe;
  if (!geolocation) {
    showMessage(Int`Geolocation not supported. Using default location.`, 'error', 'fail');
    defaultInit();
    return;
  }
  geolocation.clearWatch(positionWatch);
  positionWatch = geolocation.watchPosition(
    position => {
      const {latitude, longitude} = position.coords;
      //console.log('geolocation ready. map:', !!map, 'subscribeOneShot:', subscribeOneShot);
      updateLocation(latitude, longitude);
      if (!subscribeOneShot) return;
      subscribeOneShot = false;
      resetInactivityTimer();
      updateSubscriptions([]); // This was for a new node, so supply and empty oldSubscriptions.
    }, async error => {
      console.warn(`Geolocation code ${error.code}.`);
      if (navigator.onLine) {
	if (error.code === GeolocationPositionError.PERMISSION_DENIED) {
	  showMessage(Int`Location access denied. Using default location.`, 'error', error);
	  defaultInit();
	} else {
	  geolocation.clearWatch(positionWatch);
	  await delay();
	  initializeGeolocation();
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
async function initialize(fromHandler) { // Ensure there is a network promise and map, and reset geolocation.
  // debounce
  // if !checkOnline, return
  // set network to promise a new Contact, set ondisconnect, and connect.
  // delay if asked
  // initializeGeolocation
  if (checking) return;
  checking = true;
  try {
    // If networkPromise has not yet been set (or cleared by disconnect), we will be subscribing.
    const subscribe = !networkPromise;
    console.log('initialize fromHandler:', !!fromHandler, 'subscribe:', !!subscribe);
    if (!checkOnline()) return;
    showMessage('');
    if (!networkPromise) {
      console.log('creating');
      networkPromise = NetworkClass.create();
      networkPromise.then(contact => {
	console.log('contact created', contact.name);
	globalThis.contact = contact; // For debugging.
	contact.detachment.then(() => {
	  console.log('contact detached');
	  // If/when we reconnect, we will make a new network object with a new GUID,
	  // so as not to confuse other nodes that have given up on the unresponsive old GUID.
	  networkPromise = null; 
	  showMessage(Int`No network connection.`, 'error');
	  resetReconnectCountdown();
	});
	contact.connect()
	  .then(() => console.log('connected'));
      });
    }
    if (fromHandler) await delay();
    //fixme resetInactivityTimer();
    initializeGeolocation(subscribe);
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
initText('div.about-text', 'About');
initText('#aboutReport');
initText('#aboutShared');
initText('#aboutFade');
initText('#aboutMirror');
initText('#aboutAnyone');
initText('#aboutYz');
initText('#aboutAcknowledge');
initText('#version');
initialize(false);
