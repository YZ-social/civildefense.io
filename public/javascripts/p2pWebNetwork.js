import { v4 as uuidv4 } from 'uuid';
import { AxonaPeer, AxonaDomain, NeuronNode, createNodeIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION } from '@axona/protocol';
import { stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes } from '@axona/protocol/std';
// FIXME: What is the right way to use Axona web transport. It doesn't seem to provide either a functioning export nor declare its dependencies.
import { webTransport } from './../axona-protocol/src/transport/web/index.js';
globalThis.RTCPeerConnection ||= await import('node-datachannel/polyfill').then(ndc => ndc.RTCPeerConnection);
const { BigInt, URL, File, pica } = globalThis;

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
		       region, identity, bridgeUrl = 'wss://testnet.axona.net',
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
    network.info('Created network node for kernel', this.kernelVersion);
    await network.connect({synapseCount, timeoutMs});
    return network;
  }
  
  async connect({synapseCount = 4, timeoutMs = 10e3} = {}) {
    // Returned promise resolves when ready for use. Can be cycled through disconnect()/connect().
    await this.transport.start(this.identity.id);
    await this.join();
    this.debug('Joined', this.health().synaptomeSize, 'connections.');
    if (parseInt(this.constructor.kernelVersion) < 4) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
	const size = this.synaptomeSize;
	if (size >= synapseCount) break;
	await this.constructor.delay(200);
      }
    } else {
      await this.peer.ready({ minPeers: synapseCount, timeoutMs });
    }
    this.info('Connected', this.health().synaptomeSize, 'connections.');
    this.attached(this);
    return this;
  }
  async disconnect() { // Politely close network connection.
    const health = this.health();
    await this.leave();
    this.info(`disconnected with ${health.peers.length} connections and ${health.axonRoles.length} ${health.axonRoles.length} axons.`);
    await this.stop();
    this.resetStatePromises();
  }
  async replicateStorage() { // Let the network know that we might go away without further notice.
    // FIXME. It would be great if we could remove ourselves from any non-leaf positions in the Axon, but stay subscribed.
  }
  fastDisconnect() { // Synchronous attempt to be polite to those connected.
    this.leave(); // Execution is asynchronous. Will not finish -- or perhaps even really start -- within the call.
  }

  async chunkifyString({string, region, signWith = this.constructor.currentPublishIdentity, owner = signWith.authorId}) {
    // Publish string and answer an identifier that can be used to re-assemble.
    if (!string.length) throw new Error(`Cannot chunkify empty string '${string}.`);
    const topic = {name: uuidv4(), region, owner};
    const data = await publishChunkedBytes(this.peer, stringToBytes(string), {topic, signWith});
    return data.topic;
  }
  async assembleChunkedString(topic) { // Promise the string that was chunkified to topic.
    const data = await receiveChunkedBytes(this.peer, topic, {/*, onProgress: console.log*/});
    return bytesToString(data.bytes);
  }

  static getCanvas(file) { // Promise a Canvas from a File of type image/*.
    return new Promise((resolve, reject) => {
      const img = new Image();
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      img.onload = () => {
	canvas.width = img.width;
	canvas.height = img.height;
	ctx.drawImage(img, 0, 0);
	URL.revokeObjectURL(img.src);
	resolve(canvas);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  static  async downsampledBlob({blob, outputType = 'image/jpeg', maxDimension = 1024}) {
    // Promise a reasonably sized Blob (or File) for a given Blob of type image/*, else blob unchanged.
    if (!blob.type.startsWith('image/')) return blob;

    let sizedWidth, sizedHeight;  // Largest will be 1024, preserving aspect ratio.
    const from = await this.getCanvas(blob);
    const {width, height} = from;
    if (width > height) {
      sizedWidth = maxDimension;
      sizedHeight = Math.round(maxDimension * height/width);
    } else {
      sizedHeight = maxDimension;
      sizedWidth = Math.round(maxDimension * width/height);
    }
    if ((blob.type === outputType) && (sizedWidth >= width)) return blob;

    const resizer = pica();
    const to = document.createElement('canvas');
    to.width = sizedWidth;
    to.height = sizedHeight;
    const buffer = await resizer.resize(from, to);
    outputType ||= blob.type;
    let result = await resizer.toBlob(buffer, outputType, 0.90);
    if (blob.name) { // Answer a File with original name, but with extension matching result type.
      let {name} = blob;
      const parts = name.split('.');
      const type = result.type;
      parts[parts.length - 1] = type.slice('image/'.length);
      name = parts.join('.');
      result = new File([result], name, {type});
    }
    return result;
  }
  static u82dataURL(u8, mime) { // Answer a dataURL from the Uint8Array and mime type string.
    return `data:${mime};base64,${u8.toBase64()}`;
  }
  static async blob2dataURL(blob) { // Promise a dataURL preserving mime type (but not File name, if any).
    const buffer = await blob.arrayBuffer();
    const u8 = new Uint8Array(buffer);
    return this.u82dataURL(u8, blob.type);
  }
  static async dataURL2blob(dataURL, filename='') { // Promise a Blob.
    const res = await fetch(dataURL);
    const blob = await res.blob();
    if (!filename) return blob;
    return new File([blob], filename, {type: blob.type});
  }
  async chunkifyBlob({blob, region, signWith = this.constructor.currentPublishIdentity, owner = signWith.authorId, maxDimension = 1024, ...rest}) {
    // Publish Blob (or File) and answer an identifier that can be used to re-assemble.
    if (!blob.size) throw new Error(`Cannot chunkify empty Blob.`);
    if (maxDimension) blob = await this.constructor.downsampledBlob({blob, maxDimension});
    const {type:mime, name} = blob;
    const topic = {name: uuidv4(), region, owner};
    const buffer = await blob.arrayBuffer();
    const u8 = new Uint8Array(buffer);
    console.log('blob', blob.size, u8.length);
    const data = await publishChunkedBytes(this.peer, u8, {topic, signWith, mime, name, ...rest});
    return data.topic;
  }
  async assembleChunkedDataURL(topic) { // Promise {bytes, mime, name, dataURL} that was chunkified to topic.
    const data = await receiveChunkedBytes(this.peer, topic, {/*, onProgress: console.log*/});
    // Using dataURL is not terribly efficient, but it is convenient, because formatReplies can return HTML strings with all the data in them,
    // instead of, e.g., needing javascript to later set properties of elements to createObjectURL of a Blob.
    data.dataURL = this.constructor.u82dataURL(data.bytes, data.mime);
    return data;
  }

  // The methods publish/subscribe map from the original civildefense-over-kdht API to Axona, and could be rewritten in the apps.
  // But since we needed this class anyway, it was easiest to retain them.
  // Besides, I don't like to see abbreviations in API names.
  async subscribe({eventName, region, owner, since = 'all', handler}) { // Assign handler for eventName, or remove any handler if falsy.
    await this.attachment;
    const topic = {region, name: eventName};
    if (owner) topic.owner = owner;
    if (handler) {
      const callback = async envelope => {
	const {message, deleted, msgId, signerPubkey, topic, ts} = envelope;
	console.log('fired', {msgId, topic, ts, signerPubkey, deleted, message});
	if (deleted) {
	  handler({subject: msgId, payload: null, agent: signerPubkey, topic, ts}); // fixme remove topic, ts here and below.
	  return;
	}
	handler({...message, agent: signerPubkey, subject: msgId, topic, ts});
      };
      await this.peer.sub(topic, callback, {since});
    } else {
      this.peer.unsub(topic, {});
    }
  }
  static currentPublishIdentity = null;
  async publish({eventName, region, owner, signWith = this.constructor.currentPublishIdentity, issuedTime = Date.now(), subject, payload, ...rest}) {
    // Publish data to subscribers of eventName.
    await this.attachment; // Get connected.
    const topic = {region, name: eventName};
    if (owner) topic.owner = owner;
    const options = {signWith};
    //console.log({topic, subject, payload, issuedTime, rest, signWith});
    if (payload) return await this.peer.pub(topic, {issuedTime, payload, ...rest}, options);
    // The next would not normally happen, but until since:'latest' works, we need a way to send a null payload and have the handler delete the entry.
    if (!subject) return await this.peer.pub(topic, {issuedTime, payload, ...rest}, options);
    return await this.peer.kill(topic, subject, options);
  }

  // Mostly internal stuff.
  static regionCode(lat, lng) { // Answer containing region code.
    return geoCellId(lat, lng);
  }
  static delay(ms, result) { // Promise result after ms milliseconds.
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
