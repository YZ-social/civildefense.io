
// The DHT runs a hook here to connect nodes to each other, which uses WebSockets during
// the connection and then gets out of the way.
// It also runs some headless peers here to provide stable continuity to the network.

// But that isn't ready just yet. So temporarily, the DHT pub/sub is handled in-memory
// here, communicating through WebSocket for the whole client session.

const SUBSCRIPTION_TIMEOUT = 60 * 60e3; // Delete after an hour. Must be renewed by app.
const PUBLISH_TIMEOUT = 10 * 60e3;      // Delete after 10 minutes.

const subscriptions = {}; // key => ws. Entries purged after SUBSCRIPTION_TIMEOUT.
const sticky = {};        // key => data. Entries purshed after PUBLISH_TIMEOUT.

const addRoutes = app => {
  app.ws('/ws', function(ws, req, next) {
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
};

module.exports = addRoutes;
