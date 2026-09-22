// Offer a websocket connection for testing, that skips the DHT entirely, and accepts publishing by pushing to subscribers over the websocket.
import { WebSocketServer } from 'ws';
import { operators } from '../public/javascripts/pubsub.js';

const sockets = {};
operators.setSender((nodeId, eventHandlerId, envelope) => new Promise((resolve, reject) => {
  // Setup pubsub to receive events, by supplying a function that promises to send the event.
  //
  // When a client goes to the background, it will stay connected for at least a few seconds. An alert during that time will be transmitted in the usual way.
  // If the client politely closes, our close handler will catch this, and call pubsub's deleteSubscriber(), which activates any sticky subs.
  //    An alert after that be transmitted by the sticky push sub, if any.
  // We have a 20 second heartbeat to all clients: when someone has gone dark by being in the background, that will supply the cose.
  //    An alert after heartbeat expiration wil be transmitted by the sticky push sub, if any.
  // But... Sending on a websocket that isn't listening will silently appear to succeed.
  // (The protocol is designed that way so that operating systems can buffer the output, so any tcp ack failure could occur
  // long after socket.send() returned.)
  // Oy.
  // If the OS suspends the client, say, 5 seconds after going into the background, an alert between 5 and 20 seconds would not be delivered!
  // In order to prevent this, outgoing events send an ackTag string (in addition to the event envelope), which the client must send back.
  // Here we set the event publisher to answer a Promise. If the sender acknowledges the event within ACK_TIME_MS, it resolves to undefined.
  // But if there is no acknowledgement (or if the updated readyState after sending is not OPEN), then the promise is rejected,
  // and pubsub can catch that and transmit by the sticky push sub, if any.
  const socket = sockets[nodeId];
  if (!socket) return;
  const ACK_TIME_MS = 5e3;
  const ackTag = nodeId + '-' + socket.sendCounter++;
  const fail = reason => {
    delete sockets[nodeId]; // Keep close() from removing any sticky sub.
    delete operators[ackTag];
    socket.terminate(); // close will be asynchronous.
    reject(reason); // Reject now (before close), so that caller can catch this and push message to sticky sub, if any.
  };
  console.log('socket send', socket.readyState, ackTag, eventHandlerId);
  const timer = setTimeout(() => fail(`No acknowledgement for ${ackTag} in state ${socket.readyState} for handler ${eventHandlerId}.`), ACK_TIME_MS);
  operators[ackTag] = () => {
    console.log('ack', ackTag, 'from eventHandlerId', eventHandlerId);
    clearTimeout(timer);
    delete operators[ackTag];
    resolve();
  };
  socket.send(JSON.stringify([eventHandlerId, ackTag, envelope])); // We want an error if socket is gone, closed, etc.
  // State might not update until we attempt to actually send.
  if (socket.readyState !== WebSocket.OPEN) fail(`Bad state send to ${ackTag}, state ${socket.readyState} for handler ${eventHandlerId}.`);
}));

function heartbeat() {
  this.isAlive = true;
}

export function configureWebsocket(server) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const nodeTag = req.url.slice(1);
    console.log('Connected', nodeTag);
    ws.sendCounter = 0;
    sockets[nodeTag] = ws;

    ws.on('message', async message => {
      try {
	const parsed = JSON.parse(message);
	const [id, methodName, ...rest] = parsed;
	const result = await operators[methodName](...rest);
	if (id && (ws.readyState === WebSocket.OPEN)) ws.send(JSON.stringify([id, result]));
      } catch (error) {
	console.error(`Incomming ${error.message}: ${message}\n${error.stack}`);
      }
    });

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    ws.on('error', console.error);
    ws.on('close', () => {
      console.log('Disconnected', nodeTag);
      // Guarded, so that we don't double delete, and remove an active sticky sub.
      if (sockets[nodeTag]) operators.deleteSubscriber(nodeTag);
      delete sockets[nodeTag];
    });
  });

  const interval = setInterval(function ping() { // Keep-alive ping/pong on interval
    wss.clients.forEach(function each(ws) {
      if (!ws.isAlive) {
	console.log('heartbeat failure');
	return ws.terminate();
      }
      if (ws.readyState == WebSocket.OPEN) {
	ws.isAlive = false;
	ws.ping();
      }
      return null;
    });
  }, 20e3);
}
