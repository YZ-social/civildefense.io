import { v4 as uuidv4 } from 'uuid';
import {
  AxonaPeer, AxonaDomain, NeuronNode, AxonaManager,
  //Synapse, SimNetwork, simTransport,
  deriveTopicId,
  deriveIdentity, loadIdentity, dumpIdentity,
  geoCellId, geoCellCenter, clz264,
} from '@axona/protocol';
import { webTransport } from '@axona/web';
const { BigInt, localStorage } = globalThis;

// TODO: simplify all this outside-of-class stuff.
let NetworkClass;
const REGION = geoCellCenter(geoCellId(37.468467587148844, -122.25860595703126));
console.log('region:', REGION);
export function setSessionRegion(lat, lng) {
  const region = geoCellCenter(geoCellId(lat, lng));
  console.log('session region', lat, lng, region);
  //resolveSessionRegion(region);
}
export function getRegionPublisher(lat, lng) { // Answer the "area code" prefix (8-bit s2 cell id as a hex  bit-flag).
  return geoCellId(lat, lng).toString(16).padStart(2, '0') + '0'.repeat(64);
}

async function makePeer({ network, region }) {
  // 2a. Derive a 264-bit Ed25519 identity in this region's S2 cell.
  let identity;
  // The network will not let us kill publications from previous sessions unless we persist and reuse the identity.
  const identityPersistenceKey = 'nodeIdentity';
  const identityString = localStorage.getItem(identityPersistenceKey);
  if (identityString) {
    identity = await loadIdentity(JSON.parse(identityString));
  } else {
    identity = await deriveIdentity(region);
    localStorage.setItem(identityPersistenceKey, JSON.stringify(await dumpIdentity(identity)));
  }

  // 2b. Open a SimTransport on the shared SimNetwork.
  /* SIM version
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  */
  ///* WEBRTC version
  const transport = webTransport({ bridgeUrl: 'wss://testnet.axona.net', identity});
  //*/

  await transport.start(identity.id);

  // 2c. Build the local DHT node.  NeuronNode holds the synaptome and
  //     routing state; AxonaDomain holds parameters shared across peers.
  //     NeuronNode XORs ids as BigInts internally, so convert from
  //     identity.id (hex string) to BigInt at construction time.
  const node     = new NeuronNode({
    id:  BigInt('0x' + identity.id),
    lat: region.lat, lng: region.lng,
  });
  node.transport = transport;
  const domain   = new AxonaDomain({ k: 20 }); // What's the difference between this and AxonaManger.rootSetSize ?

  // 2d. AxonaPeer is the per-node DHT contract implementation.
  const peer = new AxonaPeer({ domain, node, identity, transport });
  // 2e. AxonaManager handles pub/sub.  It needs a `dht` adapter that
  //     forwards K-closest, sendDirect, routeMessage, and handler
  //     registration to our AxonaPeer.  Most of these are 1-line
  //     delegations; sendDirect special-cases self-target for local
  // const dht = {
  //   getSelfId:       () => peer.getNodeId(),
  //   findKClosest:    (...args) => peer.findKClosest(...args),
  //   routeMessage:    (...args) => peer.routeMessage(...args),
  //   sendDirect:      async (peerId, type, payload) => {
  //     if (peerId === peer.getNodeId()) {
  //       // Local-loopback: dispatch into our own direct handler table.
  //       const h = peer._directHandlers?.get(type);
  //       if (!h) return false;
  //       try { await h(payload, { fromId: peer.getNodeId(), type }); return true; }
  //       catch (err) { console.error('self-sendDirect threw:', err); return false; }
  //     }
  //     return peer.sendDirect(peerId, type, payload);
  //   },
  //   onRoutedMessage: (type, h) => peer.onRoutedMessage(type, h),
  //   onDirectMessage: (type, h) => peer.onDirectMessage(type, h),
  // };
  // const axonaManager = new AxonaManager({
  //   dht,
  //   // replayCacheSize: 1000, // How much is enough?
  //   maxSubscriptionAgeMs: 5 * 60e3,
  //   rootGraceMs: 30 * 24 * 60 * 60e3
  // });
  // //fixme peer._axonaManager = axonaManager;       // hand the AM directly to the peer
  await peer.start();

  return { peer, identity };
}

NetworkClass = class AxonaPubSubClient { // A websocket-baed emulation of KDHT WebContact's connect/disconnect/subscribe/publish
  static async create({name = uuidv4()} = {}) { // FIXME: use identity.pubHexKey for name. (Not identity.id, which includes region.)
    const contact = new this();
    const {promise:attachment, resolve:attached} = Promise.withResolvers();
    const {promise:detachment, resolve:detached} = Promise.withResolvers();
    Object.assign(contact, {attachment, detachment, attached, detached, name});

    const network = null;// fixme remove new SimNetwork(); // Can be null for webrtc
    const { peer: alice, identity: aliceId } = await makePeer({ network, region: REGION });    
    const { maxSubscriptionAgeMs } = {maxSubscriptionAgeMs: 30e3}; //fixme ialice._axonaManager;
    const fixme = {peer:alice, identity:aliceId, maxSubscriptionAgeMs};
    Object.assign(contact, fixme);
    //console.log({maxSubscriptionAgeMs, fixme, contact});

    /* SIM version
    const { peer: bob,   identity: bobId   } = await makePeer({ network, region: REGION });
    // Open a SimNetwork channel between alice and bob so they're directly
    // reachable, then admit each other to their synaptomes.  Real transports
    // (WebRTC mesh, WebSocket bridge) do this admission via the axona:hello
    // / hello-ack handshake at channel-open time — see axona-peer's
    // axona_node.js for the production wiring.
    await alice._transport.openConnection(bobId.id);
    function admitSynapse(localPeer, remoteBigInt) {
      const localId = localPeer._node.id;
      const stratum = clz264(localId ^ remoteBigInt);
      const syn = new Synapse({ peerId: remoteBigInt, latencyMs: 1, stratum });
      syn.weight   = 0.5;
      syn.inertia  = 0;
      syn._addedBy = 'demo';
      localPeer._node.synaptome.set(remoteBigInt, syn);
    }
    admitSynapse(alice, BigInt('0x' + bobId.id));
    admitSynapse(bob,   BigInt('0x' + aliceId.id));
    // Give the kernel a tick to admit each other to their synaptomes.
    await new Promise(r => setTimeout(r, 50));
    */
    console.log('created', contact.peer, !!contact.peer.pub, !!contact.peer.sub);
    return contact;
  }
  async disconnect() { // Close network connection, if any.
    await this.disconnectTransports();
    await this.peer.stop();
    this.detached();
  }
  disconnectTransports() {
    return this.peer.leave();
  }
  async replicateStorage() { // No-op.
  }
  connection = null; // Promise established at start of connect(), that resolves to socket/channel when open.
  detachment = null; // Promise established at start of connect(), that resolves when closed.
  async connect(baseURL) { // Establish or re-establish a connection.
    await this.peer.join();
    const READY_SYNAPSE_COUNT = 4;
    const READY_TIMEOUT_MS    = 10_000;
    const t0 = Date.now();
    const node = this.peer._node;
    while (Date.now() - t0 < READY_TIMEOUT_MS) {
      if (node.synaptome.size >= READY_SYNAPSE_COUNT) break;
      await new Promise(r => setTimeout(r, 200));
    }
    this.attached(this.peer);
    console.log(`${node.synaptome.size} connections.`);
  }

  deletableSubjects = {}; // msgId => subject
  deletableMsgIds = {}; // eventName+subject => msgId
  extendableData = {}; // eventName+subject => original {payload, act, hashtag}
  subscriptions = {}; // eventName => subscription
  async subscribe({eventName, publisher = null, handler}) { // Assign handler for eventName, or remove any handler if falsy.
    await this.attachment;
    if (handler) {
      const callback = async envelope => {
	const {message, deleted, msgId, signerPubkey, topic, ts} = envelope;
	// TODO: do not respond to immediate inFlight
	if (deleted) {
	  const subject = this.deletableSubjects[msgId];
	  if (!subject) console.log/*throw new Error*/(`No subject found for ${JSON.stringify(envelope)}.`);
	  const key = eventName + subject;
	  const data = this.extendableData[key];
	  if (!data) console.log/*throw new Error*/(`No data found for ${subject} ${JSON.stringify(envelope)}.`);
	  delete this.deletableSubjects[msgId];
	  delete this.extendableData[key];
	  //console.log('deleted:', {eventName, subject, data});
	  handler({...data, subject, payload: null});
	  return;
	}
	//console.log('fired:', {eventName, topic, publisher, topicId: await deriveTopicId(publisher, topic), deleted, message, ts});
	const key = eventName + message.subject;
	if (message.payload === undefined) {
	  //Object.assign(message, this.extendableData[key]);
	  return; // fixme. The above is an attempt to handle extensions, but is is confusing the debugging picture.
	  // (It seems to work fine in single user sim network.)
	}
	const {subject, ...rest} = message;
	this.deletableSubjects[msgId] = subject;
	//console.log(`recorded msgId ${msgId} for key ${key}`);
	this.extendableData[key] = message;
	handler({ subject, ...rest});
      };
      this.subscriptions[eventName] = await this.peer.sub(eventName, callback, { publisher, since: 'all' });
      //console.log('subscribed', eventName, publisher, await deriveTopicId(publisher, eventName, this.subscriptions[eventName]?.id));
    } else {
      this.subscriptions[eventName]?.stop();
      delete this.subscriptions[eventName];
    }
  }
  async publish({eventName, publisher = null, key, subject, immediate = false, issuedTime = Date.now(), payload, ...rest}) { // Publish data to subscribers of eventName.
    // key is ignored.
    await this.attachment;
    const message = {...rest, subject, issuedTime, payload};
    if (payload === undefined) return; // FIXME: Find out how to extend timeouts of other people's publications to a given subject (WITHIn the eventName/topic).
    const key1 = eventName + subject;
    if (payload === null) {
      //console.log('unpublish', {eventName, publisher, message});
      const msgId = this.deletableMsgIds[key1];
      if (!msgId) return console.log/*throw new Error*/(`No previous msgId for ${eventName} + ${subject}.`);
      await this.peer.kill(eventName, msgId, {publisher });
      return;
    }
    // TODO: Execute immediate handlers right away, and then not again when it gets handled later.
    // TODO: Find out how get just the most recent from the original sender on a given subject (WITHIN the eventName/topic).
    this.deletableMsgIds[key1] = await this.peer.pub(eventName, message, { publisher }); // answers a msgId
    //console.log('publish', {eventName, publisher, topicId: await deriveTopicId(publisher, eventName), message, id:this.deletableMsgIds[key1]});
  }
};

export { NetworkClass };
globalThis.NetworkClass = NetworkClass;
