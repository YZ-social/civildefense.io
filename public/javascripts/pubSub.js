import { v4 as uuidv4 } from 'uuid';
import { Int } from './translations.js';
import { showMessage } from './map.js';
const { WebSocket } = globalThis; // For linters.
const WEBSOCKET_URI = location.origin.replace('^http', 'ws') + '/ws'; // Falsey to debug locally
const RETRY_SECONDS = 90;
const INACTIVITY_SECONDS = 5 * 60;

let connectionPromise = null, countdown;
async function close(...rest) { // Close network connection, if any.
  (await connectionPromise)?.close(...rest);
}
async function setupNetwork() { // Establish or re-establish a connection.
  clearInterval(countdown);
  if ((await connectionPromise)?.readyState === WebSocket.OPEN) {
    console.log('already connected');
    return;
  }
  connectionPromise = new Promise(resolve => { // Resolves to connection when open, b/c sending over a still-opening socket gives error.
    const connection = new WebSocket(WEBSOCKET_URI);
    connection.onmessage = event => receive(JSON.parse(event.data));
    connection.onopen = () => {
      if (connection.readyState !== WebSocket.OPEN) return; // You would think that can't happen, but...
      console.log('connection open');
      resolve(connection);
      for (const eventName in handlers) { // If this is reconnecting, re-establish the subscriptions on the new socket.
	subscribe(eventName, handlers[eventName]);
      }
    };

    // onerror is of no help, as the event is generic.
    connection.onclose = event => {
      clearInterval(countdown);
      resolve(connectionPromise = null); // If anyone is waiting or will wait.
      console.warn('websocket close', event.code, event.wasClean, event.reason);
      if (event.reason === 'inactivity') return;
      if (document.visibilityState === 'visible') { // Set up reconnect with countdown.
	let counter = RETRY_SECONDS;
	countdown = setInterval(() => {
	  if (document.visibilityState !== 'visible') {
	    console.log("Abandoning retry timeout for invisible tab.");
	    clearInterval(countdown);
	  } else if (counter > 1) {
	    showMessage(Int`Server unavailable. Retrying in ` + counter-- + Int` seconds, or reload.`, 'error');
	  } else {
	    showMessage('');
	    setupNetwork();
	  }
	}, 1e3);
	return;
      }
      const more = event.reason ? ' ' + event.reason : '';
      showMessage(Int`The server connection has closed. Please reload.` + more, 'error');
    };
  });
}


let inactivityTimer;
export function resetInactivityTimer() { // Start a timer that will release the websocket after the given period.
  showMessage('');
  clearTimeout(inactivityTimer);
  setupNetwork();
  inactivityTimer = setTimeout(() => {
    showMessage(Int`Connection closed due to inactivity. Will reconnect on use.`, 'error');
    close(3000, 'inactivity');
  }, INACTIVITY_SECONDS * 1e3);
}


// pub, sub, and receive
let nodeTag = uuidv4();
const handlers = {}; // Mapping eventName => function(messageData) for all active subcriptions
const renewals = {};
export async function subscribe(eventName, handler) { // Assign handler for eventName, or remove any handler if falsy.
  eventName = eventName.toString();
  if (handler) {
    handlers[eventName] = handler;
    await send(eventName, {type: 'sub', subject: nodeTag, payload: nodeTag});
    renewals[eventName] = setTimeout(() => renewals[eventName] && subscribe(eventName, handler), 55 * 60e3);
  } else {
    delete handlers[eventName];
    clearTimeout(renewals[eventName]);
    delete renewals[eventName];
    await send(eventName, {type: 'sub', subject: nodeTag, payload: null});
  }
}

let last = [];
export function unpublishLast() { // Unpublish everything from the previous click, if any, and reset for new publication.
  for (const {eventName, payload, subject} of last.slice())
    send(eventName, {type: 'pub', subject, payload: null, issuedTime: Date.now()});
  last = [];
}

const inFlight = [];
export async function publish({eventName, subject, ...rest}) { // Publish data to subscribers of eventName.
  eventName = eventName.toString();

  // IFF this client has a handler for this eventName, evaluate it immediately and tag the
  // publish with a recognizable value so that we can ignore its receipt.
  if (handlers[eventName]) { // Execute immediately.
    inFlight.push(subject);
    handlers[eventName]({subject, ...rest}, eventName);
  }

  last.push({eventName, subject, ...rest, type: 'pub'});
  await send(eventName, {subject, ...rest, type: 'pub'});
}

// In the DHT, there is storeValue(key, storageItems).
// For server-based pubsub, the eventName string is embedded within each storageItem in each sent/received message.

async function send(eventName, messageObject) { // Send serialized message when ready, or nothing if no connection.
  (await connectionPromise)?.send(JSON.stringify({eventName, ...messageObject}));
}
function receive(message) {  // Call the handler previously set using subscribe, if any.
  const {eventName, subject, ...rest} = message;
  const handler = handlers[eventName];
  if (!handler) return;

  // If the publish was tagged for filtering by its publisher, check to see if the publisher was here.
  if (subject) {
    const index = inFlight.indexOf(subject);
    if (index >= 0) {
      inFlight.splice(index, 1);
      return;
    }
  }

  handler({subject, ...rest}, eventName);
};
