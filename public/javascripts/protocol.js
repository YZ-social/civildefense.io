// If ?dht=0, use a websocket to the server instead of Axona.
const { TextEncoder, TextDecoder, BigInt, URL, WebSocket, Buffer } = globalThis;

let connect, createAuthorIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION, stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes;

// dht 1  -> Axona
// dht 0  -> server
// dht -1 -> in-memory on client only
const defaultDHT = globalThis.process ? 1 : 0; // Browser defaults to no Axona. Server nodes and alert-bot default to Axona.
export const dht = parseInt((globalThis.process ?
			     globalThis.process.env.DHT :
			     new URL(globalThis.location).searchParams.get('dht')) ?? defaultDHT);

if (dht < 1) {

  const { v4:uuidv4 } = await import('uuid');
  const { getSmallestCellId, getPointInCell } = await import('./s2.js');
  const { cellHex } = await import('./versions.js');
  const operator = await import('./pubsub.js');

  WIRE_VERSION = 'SERVER';
  KERNEL_VERSION = `${WIRE_VERSION}.1.0`;
  createAuthorIdentity = ({
    persistAs, store = {
      get: (key) => globalThis.localStorage.getItem(key),
      set: (key, value) => globalThis.localStorage.setItem(key, value)
    }}) => {
      let tag;
      if (persistAs) {
	tag = store.get(persistAs);
	if (!tag) {
	  tag = uuidv4();
	  store.set(persistAs, tag);
	} else if (tag.includes('pubkey')) {
	  tag = JSON.parse(tag).pubkey; // if it is a real dump, as for alert-bot.
	}
      }
      return {authorId: tag};
    };
  geoCellId = (lat, lng) => {
    const cellid = getSmallestCellId(lat, lng);
    const hex = cellHex(cellid);
    const sliced = hex.slice(0, 2);
    return parseInt(sliced, 16); // The worst way to do this.
  };
  geoCellCenter = regionCode => { // Not right. See getPointInCell comments.
    const expanded = regionCode.toString(16).padStart(2, '0').padEnd(16, '0');
    const cellid = BigInt('0x' + expanded);
    const [lat, lng] = getPointInCell(cellid);
    return {lat, lng};
  };

  bytesToString = u8 => {
    return new TextDecoder().decode(u8);
  };
  stringToBytes = (str) => {
    return new TextEncoder().encode(str);
  };
  const hasBuffer = typeof Buffer !== 'undefined';
  function bytesToB64(u8) {
    if (hasBuffer) return Buffer.from(u8).toString('base64');
    let s = ''; const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    if (hasBuffer) return new Uint8Array(Buffer.from(b64, 'base64'));
    const s = atob(b64); const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    return u8;
  }
  publishChunkedBytes = (peer, u8, {name, mime}) => {
    const str = bytesToB64(u8);
    return {topic: {name, mime, str}};
  };
  receiveChunkedBytes = (peer, {name, mime, str}, options) => {
    const u8 = b64ToBytes(str);
    return {bytes: u8, name, mime, msgIds: []};
  };

  connect = async ({bridge, location, onDisconnect}) => {
    // We always call location as {lat, lng}
    // We always call it with author:false
    const {lat, lng} = location;
    const region = geoCellId(lat, lng);
    const nodeTag = region.toString(16).padStart(2, '0') + uuidv4();
    const nodeIdentity = {id: nodeTag};
    const handlers = {}; // guid => handler tag
    const inFlight = {};
    let disconnect, transport; // But do not call P2PWebNetwork.ice!!!
    const send = await new Promise(resolve => {
      if (dht === 0) {
	const url = `${bridge}/${nodeTag}`;
	const socket = transport = new WebSocket(url);
	socket.onmessage = event => {
	  const [tag, ...rest] = JSON.parse(event.data);
	  const subHandler = handlers[tag];
	  const inFlightResolver = inFlight[tag];

	  // if ((!subHandler && !inFlightResolver) || // debug
	  //     ((typeof(subHandler) !== 'function') && (typeof(inFlightResolver) !== 'function')))
	  //   console.warn('no handler or request', {tag, rest, subHandler, inFlightResolver, handlers, inFlight});

	  if (subHandler) return subHandler(...rest);
	  delete inFlight[tag];
	  return inFlightResolver?.(...rest);
	};
	socket.onopen = () => {
	  if (socket.readyState !== WebSocket.OPEN) return; // You would think that can't happen, but...
	  resolve((...rest) => { // Promise the send() function.
	    const tag = uuidv4();
	    const {promise, resolve} = Promise.withResolvers();
	    inFlight[tag] = resolve;
	    socket.send(JSON.stringify([tag, ...rest]));
	    return promise;
	  });
	};
	// onerror is of no help, as the event is generic.
	socket.onclose = event => {
	  console.warn('websocket close', event.code, event.wasClean, event.reason);
	  onDisconnect();
	};
	disconnect = () => socket.close();
      } else {
	disconnect = () => null;
	operator.setReceiver((nodeTag, id, ...rest) => handlers[id](...rest));
	resolve((methodName, ...rest) => operator[methodName](...rest)); // send()
      }
    });

    const peer = {
      onError() {},
      onLog() {},
      health() {
	return {peers: [], axonRoles: []};
      },
      async leave() {
	await send('deleteSubscriber', nodeTag);
	disconnect();
      },
      async sub(topic, handler, options) {
	const result = await send('subscribe', topic, nodeTag, options);
	handlers[result.id] = handler;
	return result;
      },
      async unsub(topic, options) {
	const result = await send('unsubscribe', topic, nodeTag, options);
	delete handlers[result.id];
	return result;
      },
      async pub(topic, message, options) {
	return send('publish', topic, message, options);
      },
      kill(topic, msgId, options) {
	return send('unpublish', topic, msgId, options);
      },
      lookup() { return {}; },
      host() {},
      unhost() {}
    };
    const status = {peers: 0, ms: 0}; // fixme ms
    await new Promise(resolve => setTimeout(resolve, 1e3)); // Simulate finding peers, and give the app some time to do stuff.
    return { peer, nodeIdentity, transport, status, disconnect };
  };

} else {
  const protocol = await import('@axona/protocol');
  const std = await import('@axona/protocol/std');
  ({ connect, createAuthorIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION }  = protocol);
  ({ stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes } = std);
}

export { connect, createAuthorIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION };
export { stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes }

