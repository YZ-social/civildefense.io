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
    network.info('created', this.wireVersion, this.kernelVersion);
    await network.connect({synapseCount, timeoutMs});
    return network;
  }
  
  async connect({synapseCount = 4, timeoutMs = 10e3} = {}) {
    // Returned promise resolves when ready for use. Can be cycled through disconnect()/connect().
    await this.transport.start(this.identity.id);
    await this.join();
    this.debug('joined', this.health().synaptomeSize);
    // FIXME: This is required to get good results. Shouldn't it be built in to join()?
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const size = this.synaptomeSize;
      if (size >= synapseCount) break;
      await this.constructor.delay(200);
    }
    this.info('connected', this.health().synaptomeSize);
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
    this.leave();
  }

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
      this.subscriptions[eventName]?.stop();
      delete this.subscriptions[eventName];
    }
  }
  async publish({eventName, publisher = null, issuedTime = Date.now(), subject, payload, ...rest}) { // Publish data to subscribers of eventName.
    await this.attachment; // Get connected.
    const options = {publisher};
    //console.log({eventName, publisher, payload, subject});
    if (payload) return await this.peer.pub(eventName, {issuedTime, payload, ...rest}, options);
    if (!subject) return null;
    if (payload === null) return await this.peer.kill(eventName, subject, options);
    return await this.peer.touch(eventName, subject, options);
  }

  static regionPublisher(lat, lng) { // Answer the region containing lat/lng as a string suitable as some forms of the "publisher" parameter.
    return geoCellId(lat, lng).toString(16).padStart(2, '0') + '0'.repeat(64);
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
    //this.debugLogger?.(this.identity.id, ...rest);
    console.log(this.identity.id, ...rest);
  }
  info(...rest) { // Add debug logspam.
    //(this.infoLogger || this.debugLogger)?.(this.identity.id, ...rest);
    console.log(this.identity.id, ...rest);
  }
}
export default P2PWebNetwork;

// For now, we want to override publish and subscribe, but that conflicts with internal messages on AxonaPeer.
// Thus P2PWebNetwork has an AxonaPeer, instead of inheriting from it. And thus we need forwarding messages.
['join', 'leave', 'stop', 'health', 'host', 'unhost']
  .forEach(methodName => P2PWebNetwork.prototype[methodName] = function (...rest) {return this.peer[methodName](...rest);});
