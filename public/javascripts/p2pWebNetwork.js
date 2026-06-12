import { AxonaPeer, AxonaDomain, NeuronNode, deriveIdentity, geoCellId, geoCellCenter, } from '@axona/protocol';
// FIXME: What is the right way to use Axona web transport. It doesn't seem to provide either a functioning export nor declare its dependencies.
import { webTransport } from './../axona-protocol/src/transport/web/index.js';
globalThis.RTCPeerConnection ||= await import('node-datachannel/polyfill').then(ndc => ndc.RTCPeerConnection);
const { BigInt } = globalThis;

/* Example:
   const network = await P2PWebNetwork.create({lat: 37.468467587148844, lng: -122.25860595703126});
   ....
   await network.disconnect();
 */

export class P2PWebNetwork {
  static async create({infoLogger = console.log, debugLogger,
		       lat, lng, identity, bridgeUrl = 'wss://bridge.axona.net',
		       synapseCount = 4, timeoutMs = 10e3}) {
    // Promise a ready-to-use network peer.
    const region = this.canonicalizeRegion(lat, lng);
    identity ||=  deriveIdentity(region); // By default, do not expose precise location.
    identity = await identity;

    const transport = webTransport({bridgeUrl, identity});
    await transport.start(identity.id);

    const node = new NeuronNode({lat: region.lat, lng: region.lng, id: BigInt('0x' + identity.id)});
    node.transport = transport;

    const domain   = new AxonaDomain({ k: 20 }); // FIXME: can't this be defaulted in AxonaPeer?

    const peer = new  AxonaPeer({domain, node, identity, transport});
    const network = new this();
    Object.assign(network, {infoLogger, debugLogger, identity, peer});
    network.resetStatePromises();
    network.info('created');
    await network.connect({synapseCount, timeoutMs});
    return network;
  }
  
  async connect({synapseCount = 4, timeoutMs = 10e3} = {}) {
    // Returned promise resolves when ready for use. Can be cycled through disconnect()/connect().
    await this.join();
    this.debug('joined', this.health().synaptomeSize);
    // FIXME: his is required to get good results. Shouldn't it be built in to join()?
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const size = this.peer._node.synaptome.size;
      if (size >= synapseCount) break;
      await this.constructor.delay(200);
    }
    this.info('connected', this.health().synaptomeSize);
  }
  async disconnect() { // Politely close network connection.
    const health = this.health();
    await this.leave();
    this.info(`disconnected with ${health.peers.length} connections and ${health.axonRoles.length} axons: [${health.axonRoles.map(role => role.topic)}]`);
    await this.stop();
    this.resetStatePromises();
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

  static regionPublisher(lat, lng) {
    return geoCellId(lat, lng).toString(16).padStart(2, '0') + '0'.repeat(64);
  }
  static delay(ms, label = '', result) { // Promise result after ms milliseconds.
    return new Promise(resolve => setTimeout(resolve, ms, result));
  }
  resetStatePromises() { // If fire any existing detach(), and then assign promises and resolvers for attachment and detachment.
    const existingDetachedResolver = this.detached;
    const {promise:attachment, resolve:attached} = Promise.withResolvers();
    const {promise:detachment, resolve:detached} = Promise.withResolvers();
    Object.assign(this, {attachment, detachment, attached, detached});
    existingDetachedResolver?.();
  }
  static canonicalizeRegion(lat, lng) {
    // Answer a {lat, lng} that is the center of a top-level Axona region containing the given {lat, lng}.
    return geoCellCenter(geoCellId(lat, lng));
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
['join', 'leave', 'stop', 'health']
  .forEach(methodName => P2PWebNetwork.prototype[methodName] = function (...rest) {return this.peer[methodName](...rest);});


