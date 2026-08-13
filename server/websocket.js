// Offer a websocket connection for testing, that skips the DHT entirely, and accepts publishing by pushing to subscribers over the websocket.
import { WebSocketServer } from 'ws';
import * as operator from '../public/javascripts/pubsub.js';

const sockets = {};
operator.setReceiver((nodeId, id, envelope) => {
  const socket = sockets[nodeId];
  socket.send(JSON.stringify([id, envelope]));
});
export function configureWebsocket(server) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => {
    const nodeTag = req.url.slice(1);
    console.log('Connected', nodeTag);
    sockets[nodeTag] = ws;

    ws.on('message', async message => {
      const [id, methodName, ...rest] = JSON.parse(message);
      const result = await operator[methodName](...rest);
      ws.send(JSON.stringify([id, result]));
    });

    ws.on('close', () => {
      console.log('Disconnected', nodeTag);
      operator.deleteSubscriber(nodeTag);
    });
  });
}
