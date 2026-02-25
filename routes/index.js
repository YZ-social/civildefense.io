import express from 'express';
export var router = express.Router();

// The DHT runs a hook here to connect nodes to each other, which uses WebSockets during
// the connection and then gets out of the way.
// It also runs some headless peers here to provide stable continuity to the network.

// But that isn't ready just yet. So temporarily, the DHT pub/sub is handled in-memory
// here, communicating through WebSocket for the whole client session.

// Each client is identified by its websocket connection.  When a client subscribes to
// a key, we ensure that its websocket appears in the set maintained for that key.
// When a publish event happens for a given key, we signal all the websockets in that
// key's set.  At that point we also add the published event to a set of "sticky"
// publishes for the key, with a timed removal set up for the future.  Any client
// newly subscribing to a key is sent the key's current set of sticky values.

// When a client's user moves or resizes the map, the set of keys to subscribe to is
// recomputed.  The client unsubscribes from any keys it is no longer interested in,
// and subscribes to new keys of interest.  Because each event is published at a wide
// range of scales, it is likely to be a frequent occurrence that even a major move
// or rescale results in the map showing exactly the same events as before, albeit
// supplied through different subscriptions.

const SUBSCRIPTION_TIMEOUT = 60 * 60e3; // Delete after an hour. Must be renewed by app.
const PUBLISH_TIMEOUT = 10 * 60e3;      // Delete after 10 minutes.

const subscriptions = {}; // eventName => {[subject]: ws, ...}. Entries purged after SUBSCRIPTION_TIMEOUT.
const sticky = {};        // eventName => {[subject]: storageItem, ...}. Entries purged after PUBLISH_TIMEOUT.
function setSticky(eventName, storageItem) { // Associate string eventName, for use by getSticky.
  const {payload, subject} = storageItem;
  const bucket = sticky[eventName] ||= {};
  function removeMessage() { delete bucket[subject]; if (!Object.keys(bucket).length) delete sticky[eventName]; }
  if (!payload) removeMessage();
  else {
    bucket[subject] = JSON.stringify(storageItem);
    setTimeout(removeMessage, PUBLISH_TIMEOUT);
  }
}
function getSticky(eventName) { // Answer array of previously set strings that are still associated with eventName.
  return Object.values(sticky[eventName] || {});
}

router.ws('/ws', function(ws, req, next) {
  // no on('connection') needed; connection is already made
  function deleteFromKeySubs(eventName, subject, keySubs = subscriptions[eventName]) {
    if (!keySubs) return;
    delete keySubs[subject];
    if (!keySubs.size) delete subscriptions[eventName];
  }
  function deleteWS() {
    for (const eventName in subscriptions)  {
      const keySubs = subscriptions[eventName];
      for (const [subject, socket] of Object.entries(keySubs)) {
	if (ws === socket) deleteFromKeySubs(eventName, subject, keySubs);
      }
    }
  }
  let heartbeat = setInterval(() => ws.ping(), 10e3);
  ws.on('message', message => {
    const {eventName, type, subject, payload, ...rest} = JSON.parse(message);
    let keySubs = subscriptions[eventName] ||= {};
    switch (type) {
    case 'pub':
      const subscribedSockets = Object.values(keySubs);
      for (const ws of subscribedSockets) ws.send(message);
      setSticky(eventName, {eventName, subject, payload, ...rest, type: 'event'});
      break;
    case 'sub':
      if (payload) {
	subscriptions[eventName][subject] = ws;
	//console.log('subscriptions', eventName, subscriptions[eventName]);
	for (const string of getSticky(eventName)) {
	  console.log('sending sticky', string);
	  ws.send(string);
	}
	setTimeout(() => deleteFromKeySubs(eventName, subject), SUBSCRIPTION_TIMEOUT);
      } else {
	deleteFromKeySubs(eventName, subject, keySubs);
      }
      break;
    default:
      console.error(`Unrecognized type ${type}`, message);
    }
  });

  ws.on('close', () => {
    console.log(`Client disconnected`);
    clearInterval(heartbeat);
    deleteWS();
  });

  ws.on('error', error => {
    console.error('WebSocket error:', error);
    deleteWS();
  });
});

