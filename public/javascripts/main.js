import { setupNetwork } from './pubSub.js';
import { map, showMessage, initMap, defaultInit, updateLocation } from './map.js';

let aboutPopup = L.popup({className: 'tipless', content: document.getElementById('aboutContent').innerHTML});
document.getElementById('about-btn').onclick = () => {
  let center = map.getCenter();
  if (aboutPopup.isShowing) {
    aboutPopup.close();
  } else {
    aboutPopup.setLatLng(center);
    map.openPopup(aboutPopup);
  }
  aboutPopup.isShowing = !aboutPopup.isShowing;
};

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
	  showMessage('Location access denied. Using default location.', 'error', error);
	  defaultInit();
	} else {
	  geolocation.clearWatch(positionWatch);
	  await delay();
	  initializeGeolocation();
	}
      } else {
	showMessage('No network connection.', 'error');
      }
    }, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    }
  );
}

async function initialize(doDelay) { // Setup everything, or reset things.
  showMessage('');
  if (doDelay) await delay(); // For online/visibility handlers.

  console.log('initializing', document.visibilityState, navigator.onLine ? 'online' : 'offline');
  if (document.visibilityState !== 'visible') return;
  if (!navigator.onLine) {
    showMessage('No network connection.', 'error');
    return;
  }

  setupNetwork(); // No-op if already open.
  if ('geolocation' in navigator) {
    initializeGeolocation();
  } else {
    showMessage('Geolocation not supported. Using default location.', 'error', 'fail');
    defaultInit();
  }
}
document.addEventListener('visibilitychange', initialize);
window.addEventListener('online', initialize);
initialize();
