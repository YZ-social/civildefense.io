import { Int } from './translations.js';
import { setupNetwork } from './pubSub.js';
import { map, showMessage, initMap, defaultInit, updateLocation, recenterMap } from './map.js';
const { QRCodeStyling, GeolocationPositionError } = globalThis; // For linters.

var aboutContent = document.getElementById('aboutContent');
document.getElementById('aboutButton').onclick = () => aboutContent.classList.toggle('hidden', false);
aboutContent.onclick = () => aboutContent.classList.toggle('hidden', true);

var qrDisplayContainer = document.getElementById('qrDisplayContainer');
var qrDisplay = document.getElementById('qrDisplay');
document.getElementById('qrButton').onclick = () => { // generate (and display) qr code on-demand (in case url changes)
  const qr = new QRCodeStyling({
    width: 300,
    height: 300,
    type: "svg",
    data: location.href,
    dotsOptions: {
      color: "#bf5107",
      type: "rounded"
    },
    backgroundOptions: {
      color: "#e9ebee",
    },
    image: "images/YZ Owl.png",
    imageOptions: {
      crossOrigin: "anonymous",
      margin: 10
    }
  });
  qrDisplay.innerHTML = '';
  qr.append(qrDisplay);
  qrDisplayContainer.classList.toggle('hidden', false);
}
qrDisplayContainer.onclick = () => qrDisplayContainer.classList.toggle('hidden', true);

document.getElementById('recenterButton').onclick = recenterMap;

function delay(ms = 1e3) {
  new Promise(resolve => setTimeout(resolve, ms));
}

let positionWatch;
function initializeGeolocation() {
  const {geolocation} = navigator;  // Get user's geolocation
  geolocation.clearWatch(positionWatch);
  positionWatch = geolocation.watchPosition(
    position => {
      const {latitude, longitude} = position.coords;
      updateLocation(latitude, longitude);
    }, async error => {
      console.warn(`Gelocation code ${error.code}.`);
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

let checking = false;
async function initialize(doDelay) { // Setup everything, or reset things.
  if (checking) return;
  checking = true;
  try {
    showMessage('');
    if (doDelay) await delay(); // For online/visibility handlers.

    console.log('initializing', document.visibilityState, navigator.onLine ? 'online' : 'offline');
    if (document.visibilityState !== 'visible') return;
    if (!navigator.onLine) {
      showMessage(Int`No network connection.`, 'error');
      return;
    }

    setupNetwork(); // No-op if already open.
    if ('geolocation' in navigator) {
      initializeGeolocation();
    } else {
      showMessage(Int`Geolocation not supported. Using default location.`, 'error', 'fail');
      defaultInit();
    }
  } finally {
    checking = false;
  }
}
document.addEventListener('visibilitychange', initialize);
window.addEventListener('online', initialize);

function initText(selector, content = selector) {
  const element = document.querySelector(selector);
  const text = Int([content]);
  console.log({selector, content, element, text});
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
initialize();
