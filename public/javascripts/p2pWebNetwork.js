import { v4 as uuidv4 } from 'uuid';
import { AxonaPeer, AxonaDomain, NeuronNode, createNodeIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION } from '@axona/protocol';
import { stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes } from '@axona/protocol/std';
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
    identity ||= createNodeIdentity(region);
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
  // These two methods should be used to replace all strings that might push a message payload above 16kB.
  // TODO: For now, these work on strings tha are already base64, and convert them to Uin8Array. Change that to operate on original binary.
  async chunkifyString({string, region, signWith = this.constructor.currentPublishIdentity, owner = signWith.authorId}) {
    // Publish string and answer an identifier that can be used to re-assemble.
    if (!string.length) throw new Error(`Cannot chunkify empty string '${string}.`);
    region = '0x'+region; // TODO: Is this necessary?
    const topic = {name: uuidv4(), region, owner};
    const data = await publishChunkedBytes(this.peer, stringToBytes(string), {topic, signWith, throttleMs: 150});
    //console.log('chunked to', data);
    return data.topic;
  }
  async assembleChunkedString(topic) { // Promise the string that was chunkified to topic.
    const data = await receiveChunkedBytes(this.peer, topic, {timeoutMs: 60e3/*, onProgress: console.log*/});
    //console.log('reassembled:', data);
    return bytesToString(data.bytes);
  }

  // The methods publish/subscribe map from the original civildefense-over-kdht API to Axona, and could be rewritten in the apps.
  // But since we needed this class anyway, it was easiest to retain them.
  // Besides, I don't like to see abbreviations in API names.
  async subscribe({eventName, region, owner, handler}) { // Assign handler for eventName, or remove any handler if falsy.
    await this.attachment;
    region = '0x'+region; // TODO: Is this necessary?
    const topic = {region, name: eventName};
    if (owner) topic.owner = owner;
    if (handler) {
      const callback = async envelope => {
	const {message, deleted, msgId, signerPubkey, topic, ts} = envelope;
	console.log('fired', {msgId, topic, signerPubkey, deleted, message});
	if (deleted) {
	  handler({subject: msgId, payload: null});
	  return;
	}
	handler({...message, subject: msgId});
      };
      await this.peer.sub(topic, callback, {since: 'all'});
    } else {
      this.peer.unsub(topic, {});
    }
  }
  static currentPublishIdentity = null;
  async publish({eventName, region, owner, signWith = this.constructor.currentPublishIdentity, issuedTime = Date.now(), subject, payload, ...rest}) {
    // Publish data to subscribers of eventName.
    await this.attachment; // Get connected.
    region = '0x'+region; // TODO: Is this necessary?
    const topic = {region, name: eventName};
    if (owner) topic.owner = owner;
    const options = {signWith};
    //console.log({topic, subject, payload, issuedTime, rest, signWith});
    if (payload) return await this.peer.pub(topic, {issuedTime, payload, ...rest}, options);
    if (!subject) return null;
    return await this.peer.kill(topic, subject, options);
  }

  // Mostly internal stuff.
  static regionCode(lat, lng) { // Answer containing region code.
    return geoCellId(lat, lng).toString(16).padStart(2, '0');
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
