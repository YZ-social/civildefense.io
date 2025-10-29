var express = require('express');
var router = express.Router();

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

const subscriptions = {}; // key => ws. Entries purged after SUBSCRIPTION_TIMEOUT.
const sticky = {};        // key => data. Entries purged after PUBLISH_TIMEOUT.

router.ws('/ws', function(ws, req, next) {
  // no on('connection') needed; connection is already made
  function deleteFromKeySubs(key, keySubs = subscriptions[key]) {
    if (!keySubs) return;
    keySubs.delete(ws);
    if (!keySubs.size) delete subscriptions[key];
  }
  function deleteWS() {
    for (const key in subscriptions)  {
      deleteFromKeySubs(key);
    }
  }
  let heartbeat = setInterval(() => ws.ping(), 10e3);
  ws.on('message', message => {
    const {method, key, timeToLive, data} = JSON.parse(message);
    let keySubs = subscriptions[key] ||= new Set();
    switch (method) {
    case 'publish':
      const string = JSON.stringify({key, timeToLive, data});
      for (const ws of keySubs) {
	ws.send(string);
      }
      const existing = sticky[key] ||= new Set();
      existing.add(string);
      setTimeout(() => { existing.delete(string); if (!existing.size) delete sticky[key]; } , PUBLISH_TIMEOUT);
      break;
    case 'subscribe':
      subscriptions[key].add(ws);
      for (const string of (sticky[key] || [])) {
	console.log('sending sticky', string);
	ws.send(string);
      }
      setTimeout(() => deleteFromKeySubs(key), SUBSCRIPTION_TIMEOUT);
      break;
    case 'unsubscribe':
      deleteFromKeySubs(key, keySubs);
      break;
    default:
      console.error(`Unrecognized method ${method}`, message);
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

module.exports = router;

