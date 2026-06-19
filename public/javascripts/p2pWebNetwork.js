import { v4 as uuidv4 } from 'uuid';
import { AxonaPeer, AxonaDomain, NeuronNode, deriveIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION } from '@axona/protocol';
// FIXME: What is the right way to use Axona web transport. It doesn't seem to provide either a functioning export nor declare its dependencies.
import { webTransport } from './../axona-protocol/src/transport/web/index.js';
globalThis.RTCPeerConnection ||= await import('node-datachannel/polyfill').then(ndc => ndc.RTCPeerConnection);
const { BigInt } = globalThis;

/* Example:
   const network = await P2PWebNetwork.create({lat: 37.468467587148844, lng: -122.25860595703126});
   ....
   await network.disconnect();
 */

const {promise:sessionRegionPromise, resolve:resolveSessionRegion} = Promise.withResolvers();

export class P2PWebNetwork {
  static wireVersion = WIRE_VERSION;
  static kernelVersion = KERNEL_VERSION;
  static setSessionRegion = resolveSessionRegion;
  static sessionRegion = sessionRegionPromise;
  static async create({infoLogger = console.log, debugLogger,
		       region, identity, bridgeUrl = 'wss://bridge.axona.net',
		       synapseCount = 4, timeoutMs = 10e3} = {}) {
    // Promise a ready-to-use network peer.
    // Complex region/identity behavior: Must pass either identity or region (either can be a promise), or will wait for setSessionRegion() to be called.
    if (!identity) region ||= this.canonicalizeRegion(await (region || this.sessionRegion));
    identity ||= deriveIdentity(region);
    identity = await identity;
    region ||= identity.region;

    const transport = webTransport({bridgeUrl, identity});
    const node = new NeuronNode({lat: region.lat, lng: region.lng, id: BigInt('0x' + identity.id)});
    node.transport = transport; // FIXME: pass in to constructor?
    const domain   = new AxonaDomain({ k: 20 }); // FIXME: can't this be defaulted in AxonaPeer?
    const peer = new  AxonaPeer({domain, node, identity, transport});

    const network = new this();
    Object.assign(network, {infoLogger, debugLogger, identity, transport, node, peer});
    network.resetStatePromises();
    network.info('Created network node for wire/kernel versions', this.wireVersion, this.kernelVersion);
    await network.connect({synapseCount, timeoutMs});
    return network;
  }
  
  async connect({synapseCount = 4, timeoutMs = 10e3} = {}) {
    // Returned promise resolves when ready for use. Can be cycled through disconnect()/connect().
    await this.transport.start(this.identity.id);
    await this.join();
    this.debug('Joined', this.health().synaptomeSize, 'connections.');
    // FIXME: This is required to get good results. Shouldn't it be built in to join()?
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const size = this.synaptomeSize;
      if (size >= synapseCount) break;
      await this.constructor.delay(200);
    }
    this.info('Connected', this.health().synaptomeSize, 'connections.');
    this.attached(this);
    return this;
  }
  async disconnect() { // Politely close network connection.
    const health = this.health();
    await this.leave();
    this.info(`disconnected with ${health.peers.length} connections and ${health.axonRoles.length} axons: [${health.axonRoles.map(role => role.topic)}]`);
    await this.stop();
    this.resetStatePromises();
  }
  async replicateStorage() { // Let the network know that we might go away without further notice.
    // FIXME. It would be great if we could remove ourselves from any non-leaf positions in the Axon, but stay subscribed.
  }
  fastDisconnect() { // Synchronous attempt to be polite to those connected.
    this.leave(); // Execution is asynchronous. Will not finish -- or perhaps even really start -- within the call.
  }

  // civildefense and alert-bot explicitly handle files in an application-specific way:
  // they convert them to data urls, which contain an explicit mime type and are represented
  // as text, so they can go as JSON. The apps also downsample images in a way that is
  // appropriate for their specific use within the application.  When receiving, the surrounding
  // JSON identifies the string to be converted by the application to other application-specific forms.
  // Thus there's no need for transport to deal with that.
  //
  // However, Axona cannot handle a message that might contain a string that is, say, a megabyte.
  // So it's up to us to provide a utility that the app can use to chunk and re-assemble string
  // that the app knows might be large. That's what these two methods do.
  // They should be used to replace all strings that might push a message payload above 256kB (or maybe 16kB, see below).
  async chunkifyString(string, publisher = null) { // Publish string and answer an identifier that can be used to re-assemble.
    if (!string.length) throw new Error(`Cannot chunkify empty string '${string}.`);
    // FIXME: This implementation can be disrupted when another user publishes garbage to the same topic.
    const topic = uuidv4(); // Publish the chunks to this topic.
    // A specific RTCPeerConnection has an sctp.maxMessageSize negotiated between the peers.
    // Alas, we will be publishing a bunch of substrings to topic and we have no control or insight into the
    // specific webrtc connections it will pass through -- which might not even be our connection.
    // So the only safe thing to do is to use the largest size that is guaranteed to work across implementations
    // in all networks, which is only 16k. Ugh!
    const SIZE_LIMIT = 230e3; // FIXME: should be less than 16e3 (Allowing room for envelopes.) But that won't work for even basic downrezed photos. So do a large size for now that we KNOW will not work on some browser/network combinations.
    const THROTTLE = 1e3//fixme 150; // ms
    const numChunks = Math.ceil(string.length / SIZE_LIMIT);
    const options = {publisher};
    // TODO: It would be nice to send these in parallel, but instead, we have to pause for throttling.
    const sent = await this.peer.pub(topic, {i: 0, v: numChunks}, options);
    this.info(`Fragmenting ${string.length.toLocaleString()} byte message ${topic} into ${numChunks} chunks of ${SIZE_LIMIT}, starting with ${sent}, publisher ${publisher}.`);
    for (let i = 1, o = 0; i <= numChunks; ++i, o += SIZE_LIMIT) {
      const frag = {i, v: string.substr(o, SIZE_LIMIT)};
      await this.constructor.delay(THROTTLE);
      const msgId = await this.peer.pub(topic, frag, options);
      this.info('chunk', i, msgId, frag.v.length, frag.v.slice(0, 40), frag.v.slice(-40));
    }
    this.info('completed', numChunks);
    return topic;
  }
  async assembleChunkedString(topic, publisher = null) { // Promise the {string, messageIdentifiers} that was chunkified to topic.
    // The messageIdentifiers must be retained if the app intends to extend the lifetime of the chunks by "touching" them.
    console.log('*** assembling', topic, publisher);
    return new Promise(async resolve => {
      let chunks = [], messageIdentifiers = [];
      const subscription = await this.peer.sub(topic, (envelope) => {
	const {message, msgId} = envelope;
	const {i, v} = message;
	this.info('*** received chunk', i, msgId, 'of total', chunks.length, v.length, i ? v.slice(0, 40) : v, i ? v.slice(-40) : '-');
	if (i === 0) {
	  chunks.length = parseInt(v);
	} else {
	  chunks[i - 1] = v;
	  // We don't care about the order of messageIdentifiers. Push leaves no gaps, and length tells us how many chunks have been received.
	  messageIdentifiers.push(msgId);
	}
	const done = chunks.length && (messageIdentifiers.length >= chunks.length);
	console.log('*** total:', messageIdentifiers.length, 'of', chunks.length, 'done:', done);
	if (done) {
	  const string = chunks.join('');
	  console.log('*** resolving', string.length, string.slice(0, 40), string.slice(-40), messageIdentifiers);
	  this.peer.unsub(topic, {publisher});
	  resolve({string, messageIdentifiers});
	}
      }, {publisher, since: 'all'});
      console.log('*** subscribed', subscription);
    });
  }

  // The methods publish/subscribe map from the original civildefense-over-kdht API to Axona, and could be rewritten in the apps.
  // But since we needed this class anyway, it was easiest to retain them.
  // Besides, I don't like to see abbreviations in API names.
  subscriptions = {}; // eventName => subscription. TODO: use unsub() instead of stop().
  async subscribe({eventName, publisher = null, handler}) { // Assign handler for eventName, or remove any handler if falsy.
    await this.attachment;
    if (handler) {
      const callback = async envelope => {
	const {message, deleted, msgId, signerPubkey, topic, ts} = envelope;
	if (deleted) {
	  //console.log('deleted:', {eventName, subject: msgId});
	  handler({subject: msgId, payload: null});
	  return;
	}
	//console.log('fired:', {eventName, topic, publisher, topicId: await deriveTopicId(publisher, topic), deleted, message, ts});
	handler({...message, subject: msgId});
      };
      this.subscriptions[eventName] = await this.peer.sub(eventName, callback, { publisher, since: 'all' });
      //console.log('subscribed', eventName, publisher, await deriveTopicId(publisher, eventName, this.subscriptions[eventName]?.id));
    } else {
      //this.subscriptions[eventName]?.stop(); // fixme remove this.susbscriptions
      this.peer.unsub(eventName, {publisher});
      delete this.subscriptions[eventName];
    }
  }
  async publish({eventName, publisher = null, issuedTime = Date.now(), subject, payload, ...rest}) { // Publish data to subscribers of eventName.
    await this.attachment; // Get connected.
    const options = {publisher};
    //console.log({eventName, publisher, payload, subject, issuedTime, rest});
    if (payload) return await this.peer.pub(eventName, {issuedTime, payload, ...rest}, options);
    if (!subject) return null;
    return await this.peer.kill(eventName, subject, options);
  }

  // Mostly internal stuff.
  static regionCode(lat, lng) { // Answer containing region code.
    return geoCellId(lat, lng).toString(16).padStart(2, '0');
  }
  static code2publisher(code) {
    return code + '0'.repeat(64);
  }
  static regionPublisher(lat, lng) { // Answer the region containing lat/lng as a string suitable as some forms of the "publisher" parameter.
    return this.code2publisher(this.regionCode(lat, lng));
  }
  static delay(ms, label = '', result) { // Promise result after ms milliseconds.
    return new Promise(resolve => setTimeout(resolve, ms, result));
  }
  resetStatePromises() { // Fire any existing detach(), and assign new promises and resolvers for attachment and detachment.
    const existingDetachedResolver = this.detached;
    const {promise:attachment, resolve:attached} = Promise.withResolvers();
    const {promise:detachment, resolve:detached} = Promise.withResolvers();
    Object.assign(this, {attachment, detachment, attached, detached});
    existingDetachedResolver?.();
  }
  static canonicalizeRegion(lat, lng) {
    // Answer a {lat, lng} that is the center of a top-level Axona region containing the given {lat, lng}.
    // E.g., a precise location gets anonymized to containing top-level cell center.
    return geoCellCenter(geoCellId(lat, lng));
  }
  get synaptomeSize() { // Safely answer the number of connections.
    return this.node.synaptome?.size ?? 0;
  }
  // TODO: Integrate with AxonaPeer's complex logging.
  debug(...rest) { // Add debug logspam.
    this.debugLogger?.(this.identity.id, ...rest);
  }
  info(...rest) { // Add debug logspam.
    (this.infoLogger || this.debugLogger)?.(this.identity.id, ...rest);
  }
}
export default P2PWebNetwork;

// For now, we want to override publish and subscribe, but that conflicts with internal messages on AxonaPeer.
// Thus P2PWebNetwork has an AxonaPeer, instead of inheriting from it. And thus we need forwarding messages.
['join', 'leave', 'stop', 'health', 'host', 'unhost']
  .forEach(methodName => P2PWebNetwork.prototype[methodName] = function (...rest) {return this.peer[methodName](...rest);});
