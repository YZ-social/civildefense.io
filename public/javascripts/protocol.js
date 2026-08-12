// If ?dht=0, use a websocket to the server instead of Axona.

let connect, createAuthorIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION, stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes;

const dht = globalThis.process ? globalThis.process.env.DHT : new URL(globalThis.location).searchParams.get('dht');

if (dht === '0') {

  const { getContainingCells, getPointInCell } = await import('./s2.js');
  const { cellHex } = await import('./versions.js');
  const { v4:uuidv4 } = await import('uuid');
  WIRE_VERSION = 'SERVER';
  KERNEL_VERSION = `${WIRE_VERSION}.1.0`;
  createAuthorIdentity = ({persistAs}) => {
    let tag;
    if (persistAs && globalThis.localStorage) {
      tag = globalThis.localStorage.getItem(persistAs);
      if (!tag) {
	tag = uuidv4();
	globalThis.localStorage.setItem(persistAs, tag);
      }
    }
    return {authorId: tag};
  };
  geoCellId = (lat, lng) => {
    const cells = getContainingCells(lat, lng);
    const hex = cellHex(cells[0]);
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

  connect = ({bridge, location}) => {
    // We always call location as {lat, lng}
    // We always call it with author:false
    const {lat, lng} = location;
    const region = geoCellId(lat, lng);
    const nodeTag = region.toString(16).padStart(2, '0') + uuidv4();
    const nodeIdentity = {id: nodeTag};
    const transport = null; // But do not call P2PWebNetwork.ice!!!

    function setBucket(collection, type, topic, subject, value) { // Set value in the collection.
      const bucket = collection[type][topic] ||= {};
      bucket[subject] = value;
    }
    function removeBucket(collection, type, topic, subject) { // Return the value and stop storing it.
      const bucket = collection[type][topic];
      if (!bucket) return null;
      const value = bucket[subject];
      delete bucket[subject];
      if (!Object.keys(bucket).length) delete collection[type][topic];
      return value;
    }

    const SUBSCRIPTION_TIMEOUT = 0;//fixme60 * 60e3; // Delete after an hour. Must be renewed by app.
    const PUBLISH_TIMEOUT = 24 * 60e3;      // Delete after 24 hours.
    const timeouts = {pub: {}, sub: {}};
    function expire(type, topic, subject, remover, timeout) { // Cancellably schedule remover() to fire at timeout.
      if (!timeout) return;
      setBucket(timeouts, type, topic, subject, setTimeout(remover, timeout));
    }
    function cancel(type, topic, subject) { // Cancel a sheduled expiration.
      clearTimeout(removeBucket(timeouts, type, topic, subject));
    }

    // pub maps eventName => {[subject]: storageItem, ...}, where subject is the message id. Entries purged after PUBLISH_TIMEOUT.
    // sub maps  eventName => {[subject]: ws, ...}, where subject is the subscriber id. Entries purged after SUBSCRIPTION_TIMEOUT.
    const data = {pub: {}, sub: {}};
    function getDataValues(type, topic) { // For all subjects
      return Object.values(data[type][topic] || {});
    }

    function deleteSub(topic, subject) {
      removeBucket(data, 'sub', topic, subject);
    }
    function deleteWS() { /// fixme on leave
      for (const eventName in data.sub)  {
	const keySubs = data.sub[eventName];
	for (const [subject, socket] of Object.entries(keySubs)) {
	  if (peer === socket) deleteSub(eventName, subject, keySubs);
	}
      }
    }
    function normalizeTopic({name, region, owner, write = 'open'} = {}) {
      if (typeof(region) === 'string') region = parseInt(region);;
      return JSON.stringify({name, region, owner, write});
    }

    const peer = {
      onError() {},
      onLog() {},
      health() {
	return {peers: [], axonRoles: []};
      },
      leave() {},
      sub(topic, handler, {since = 'all'}) {
	topic = normalizeTopic(topic);
	cancel('sub', topic, nodeTag);
	expire('sub', topic, nodeTag, () => deleteSub(topic, nodeTag), SUBSCRIPTION_TIMEOUT);
	setBucket(data, 'sub', topic, nodeTag, handler);
	if (!since) return;
	let lastEnvelope = null, lastTime = 0;
	for (const envelope of getDataValues('pub', topic)) {
	  switch (since) {
	  case 'all':
	    handler(envelope);
	    break;
	  case 'latest':
	    if (envelope.ts > lastTime) {
	      lastTime = envelope.ts;
	      lastEnvelope = envelope;
	    }
	    break;
	  default: // Must be a timestamp
	    if (envelope.ts === since) handler(envelope);
	  }
	}
	if (lastEnvelope) handler(lastEnvelope);
      },
      unsub(topic, options) {
	topic = normalizeTopic(topic);
	cancel('sub', topic, nodeTag);
	deleteSub(topic, nodeTag);
      },
      async pub(topic, message, {signWith}) {
	topic = normalizeTopic(topic);
	const signerPubkey = signWith?.authorId || undefined;
	const payload = JSON.stringify({message, publisher: signerPubkey});
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
	const msgId = new Uint8Array(hash).toHex();
	const envelope = {msgId, topic, ts: Date.now(), message, signerPubkey};
	const subs = getDataValues('sub', topic);
	for (const subscriber of subs) subscriber(envelope);
	setBucket(data, 'pub', topic, msgId, envelope);
	expire('pub', topic, msgId, () => removeBucket(data, 'pub', topic, msgId), PUBLISH_TIMEOUT);
	return msgId;
      },
      kill(topic, msgId, {signWith}) {
	topic = normalizeTopic(topic);	
	cancel('pub', topic, msgId);
	const envelope = removeBucket(data, 'pub', topic, msgId);
	envelope.deleted = true;
	envelope.message = null;
	for (const subscriber of getDataValues('sub', topic)) subscriber(envelope);	
      },
      host() {},
      unhost() {}
    };
    const disconnect = () => null; // fixme
    const status = {peers: 0, ms: 0}; // fixme ms
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

