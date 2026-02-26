import { v4 as uuidv4 } from 'uuid';
import { Node, WebContact } from '@yz-social/kdht';
const { WebSocket, URLSearchParams } = globalThis; // For linters.

let NetworkClass;
if (new URLSearchParams(location.search).has('dht')) {

  NetworkClass = WebContact;

} else {

  NetworkClass = class WebSocketPubSubClient { // A websocket-baed emulation of KDHT WebContact's connect/disconnect/subscribe/publish
    static async create({name = uuidv4()} = {}) {
      const contact = new this();
      const {promise:attachment, resolve:attached} = Promise.withResolvers();
      const {promise:detachment, resolve:detached} = Promise.withResolvers();
      Object.assign(contact, {attachment, detachment, attached, detached, name});
      return Promise.resolve(contact); // WebContact returns a Promise, so we do, too.
    }
    async disconnect() { // Close network connection, if any.
      const socket = await this.connection;
      socket?.close(3000, 'inactivity');
      this.connection = null;
    };
    connection = null; // Promise established at start of connect(), that resolves to socket/channel when open.
    attachment = null; // In the DHT, this promise resolves to self when joined, but here it happens at the same time as connection.
    detachment = null; // Promise established at start of connect(), that resolves when closed.
    async connect(baseURL = globalThis.location.origin.replace('^http', 'ws') + '/ws') { // Establish or re-establish a connection.
      if ((await this.connection)?.readyState === WebSocket.OPEN) {
	//console.log('already connected');
	return this;
      }
      this.connection = new Promise(resolveConnection => { // Resolves to connection when open, b/c sending over a still-opening socket gives error.
	const socket = new WebSocket(baseURL); // baseURL falsey to debug locally
	socket.onmessage = event => this.receive(JSON.parse(event.data));
	socket.onopen = () => {
	  if (socket.readyState !== WebSocket.OPEN) return; // You would think that can't happen, but...
	  console.log('connection open');
	  resolveConnection(socket);
	  this.attached(this);
	};

	// onerror is of no help, as the event is generic.
	socket.onclose = event => {
	  console.warn('websocket close', event.code, event.wasClean, event.reason);
	  this.detached(event.reason || (event.wasClean ? 'closed' : 'failed'));
	  this.attached(this);
	  resolveConnection( null); // If anyone is waiting or will wait.
	  this.connection = this.attachment = this.detachment = null;
	};
      });
      await this.connection;
      return this;
    }

    // In the DHT, there is storeValue(key, storageItems).
    // For server-based pubsub, the eventName string is embedded within each storageItem in each sent/received message.

    async send(eventName, messageObject) { // Send serialized message when ready, or nothing if no connection.
      //console.log('send', eventName, messageObject);
      (await this.connection)?.send(JSON.stringify({eventName, ...messageObject}));
    };
    receive(message) {  // Call the handler previously set using subscribe, if any.
      const {eventName, subject, issuedTime, ...rest} = message;
      //console.log('receive', {eventName, subject, issuedTime, ...rest});
      const handler = this.handlers[eventName];
      if (!handler) return;

      // If the publish was tagged for filtering by its publisher, check to see if the publisher was here.
      if (subject) {
	const index = this.inFlight.indexOf(subject + issuedTime);
	if (index >= 0) {
	  this.inFlight.splice(index, 1);
	  return;
	}
      }

      handler({subject, issuedTime, ...rest}, eventName);
    }
    handlers = {}; // Mapping eventName => function(messageData) for all active subcriptions
    inFlight = [];    
    async subscribe({eventName, handler}) { // Assign handler for eventName, or remove any handler if falsy.
      eventName = eventName.toString();
      if (handler) {
	this.handlers[eventName] = handler;
	await this.send(eventName, {type: 'sub', subject: this.name, payload: this.name});
      } else {
	delete this.handlers[eventName];
	await this.send(eventName, {type: 'sub', subject: this.name, payload: null});
      }
    }
    async publish({eventName, subject, immediate = false, issuedTime, ...rest}) { // Publish data to subscribers of eventName.
      eventName = eventName.toString();

      // IFF this client has a handler for this eventName, evaluate it immediately and tag the
      // publish with a recognizable value so that we can ignore its receipt.
      if (immediate && this.handlers[eventName]) { // Execute immediately.
	//console.log('acting immediately on', {eventName, subject, issuedTime, ...rest});
	this.inFlight.push(subject + issuedTime);
	this.handlers[eventName]({subject, issuedTime, ...rest, immediateLocalAction: true}, eventName);
      }

      await this.send(eventName, {subject, issuedTime, ...rest, type: 'pub'});
    }
  };
}

export { NetworkClass };
