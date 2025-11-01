import uuid4 from './uuid4.js';
import { showMessage } from './map.js';
const { WebSocket } = globalThis; // For linters.
const WEBSOCKET_URI = location.origin.replace('^http', 'ws') + '/ws'; // Falsey to debug locally

const handlers = {}; // Mapping key => function(messageData) for all active subcriptions

let connection, promise;
export async function setupNetwork() { // Establish or re-establish a connection
  const existing = await connection;
  if (existing?.readyState === WebSocket.OPEN) {
    console.log('already connected');
    return;
  }
  connection = WEBSOCKET_URI ?
    new WebSocket(WEBSOCKET_URI) :
    { // If no WEBSOCKET_URI, operate locally with an object that has a send() method
      send(string) {
	const {method, ...data} = JSON.parse(string);
	if (method !== 'publish') return;
	this.onmessage( {data: JSON.stringify(data)} ); // Fake an Event object.
      }
    };

  promise = new Promise(resolve => // Resolves when open, b/c sending over a still-opening socket gives error.
    connection.onopen = () => {
      if (connection.readyState !== WebSocket.OPEN) return; // You would think that can't happen, but...
      console.log('connection open');
      resolve(connection);
    });

  // onerror is of no help, as the event is generic.
  connection.onclose = event => {
    console.warn('websocket close', event.code, event.wasClean, event.reason);
    if (document.visibilityState === 'visible') {
      setupNetwork();
      return;
    }
    const more = event.reason ? ' ' + event.reason : '';
    showMessage('The server connection has closed. Please reload.' + more, 'error');
  };

  connection.onmessage = event => { // Call the handler previously set using subscribe, if any.
    const {key, data} = JSON.parse(event.data);
    const handler = handlers[key];
    if (!handler) return;

    // If the publish was tagged for filtering by its publisher, check to see if
    // the publisher was here.
    if (data.messageTag) {
      const index = inFlight.indexOf(data.messageTag);
      if (index >= 0) {
        inFlight.splice(index, 1);
        return;
      }
    }

    handler(data, key);
  };

  for (const key in handlers) { // If this is reconnecting, re-establish the subscriptions on the new socket.
    await subscribe(key, handlers[key]);
  }
}

const inFlight = [];
export async function publish(key, data, timeToLive = 10 * 60e3) { // Publish data to subscribers of key.
  await promise;
  key = key.toString();

  // Iff this client has a handler for this key, evaluate it immediately and tag the
  // publish with a recognizable value so that we can ignore its receipt.
  const publishData = { ...data };
  if (handlers[key]) {
    const messageTag = uuid4(); // Added to data to be round-tripped. Not a user tag!
    publishData.messageTag = messageTag;
    // Make note of inFlight uuid and execute immediately.
    inFlight.push(messageTag);
    handlers[key](data, key);
  }

  const message = {method: 'publish', key, data: publishData, timeToLive};
  connection.send(JSON.stringify(message));
}
const renewals = {};
export async function subscribe(key, handler) { // Assign handler for key, or remove any handler if falsy.
  await promise;
  key = key.toString();
  if (handler) {
    handlers[key] = handler;
    connection.send(JSON.stringify({method: 'subscribe', key}));
    renewals[key] = setTimeout(() => renewals[key] && subscribe(key, handler), 55 * 60e3);
  } else {
    delete handlers[key];
    clearTimeout(renewals[key]);
    delete renewals[key];
    connection.send(JSON.stringify({method: 'unsubscribe', key}));
  }
}

