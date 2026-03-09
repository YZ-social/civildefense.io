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
const timeouts = {pub: {}, sub: {}};
function expire(type, subject, remover, timeout) { // Cancellably schedule remover() to fire at timeout.
  timeouts[type][subject] = setTimeout(remover, timeout);
}
function cancel(type, subject) { // Cancel a sheduled expiration.
  clearTimeout(timeouts[type][subject]);
}

// pub maps eventName => {[subject]: storageItem, ...}, where subject is the message id. Entries purged after PUBLISH_TIMEOUT.
// sub maps  eventName => {[subject]: ws, ...}, where subject is the subscriber id. Entries purged after SUBSCRIPTION_TIMEOUT.
const data = {pub: {}, sub: {}};
function removeBucket(type, eventName, subject, bucket = data[type][eventName]) { // Remove from data.
  if (!bucket) return;
  delete bucket[subject];
  if (Object.keys(bucket).length) return;
  delete data[type][eventName];
}

function setSticky(eventName, storageItem) { // Associate string eventName, for use by getSticky.
  const {payload, subject} = storageItem;
  const bucket = data.pub[eventName] ||= {};
  function removeMessage() {
    removeBucket('pub', eventName, subject, bucket);
  }
  cancel('pub', subject);
  if (payload === null) removeMessage();
  else {
    bucket[subject] = JSON.stringify(storageItem);
    expire('pub', subject, removeMessage, PUBLISH_TIMEOUT);
  }
}
function getSticky(eventName) { // Answer array of previously set strings that are still associated with eventName.
  return Object.values(data.pub[eventName] || {});
}

router.ws('/ws', function(ws, req, next) {
  // no on('connection') needed; connection is already made
  function deleteFromKeySubs(eventName, subject, keySubs = data.sub[eventName]) {
    removeBucket('sub', eventName, subject, keySubs);
  }
  function deleteWS() {
    for (const eventName in data.sub)  {
      const keySubs = data.sub[eventName];
      for (const [subject, socket] of Object.entries(keySubs)) {
	if (ws === socket) deleteFromKeySubs(eventName, subject, keySubs);
      }
    }
  }
  let heartbeat = setInterval(() => ws.ping(), 10e3);
  ws.on('message', message => {
    const {eventName, type, subject, payload, ...rest} = JSON.parse(message);
    let keySubs = data.sub[eventName] ||= {};
    switch (type) {
    case 'pub':
      const subscribedSockets = Object.values(keySubs);
      for (const ws of subscribedSockets) ws.send(message);
      setSticky(eventName, {eventName, subject, payload, ...rest, type: 'event'});
      break;
    case 'ext':
      cancel('pub', subject);
      expire('pub', subject, () => removeBucket('pub', eventName, subject), PUBLISH_TIMEOUT);
      break;
    case 'sub':
      cancel('sub', subject);
      if (payload) {
	//console.log('subscribing', eventName, 'among', Object.keys(keySubs));
	// In the DHT, the payload is the node name so that we can fire the event to it later.
	// Here we have/store the websocket.
	if (subject !== payload) throw new Error('Subscription with payload:', payload, 'and subject:', subject);
	keySubs[subject] = ws;
	for (const string of getSticky(eventName)) {
	  console.log('sending sticky', string);
	  ws.send(string);
	}
	expire('sub', subject, () => deleteFromKeySubs(eventName, subject), SUBSCRIPTION_TIMEOUT);
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

