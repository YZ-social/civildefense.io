import { v4 as uuidv4 } from 'uuid';
import { createNodeIdentity, createAuthorIdentity, geoCellId, geoCellCenter, WIRE_VERSION, KERNEL_VERSION } from '@axona/protocol';
import { stringToBytes, bytesToString, publishChunkedBytes, receiveChunkedBytes } from '@axona/protocol/std';
import { connect } from '@axona/protocol/connect.js';
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
  static createAuthorIdentity = createAuthorIdentity;
  static setSessionRegion = resolveSessionRegion;
  static sessionRegion = sessionRegionPromise;
  static async create({infoLogger = console.log, debugLogger,
		       region = this.sessionRegion,
		       bridgeUrl = globalThis.process?.env.BRIDGE_URL || 'wss://bridge.axona.net',
		      } = {}) {
    // Promise a ready-to-use network peer.
    region = await region;
    const { peer, nodeIdentity, transport, status, disconnect } = await connect({
      bridge: bridgeUrl,
      location: region,
      author: false
    });

    const network = new this();
    Object.assign(network, {infoLogger, debugLogger, disconnector: disconnect, transport, nodeIdentity, peer});
    network.resetStatePromises();
    network.info(`Created network node for kernel ${this.kernelVersion} region 0x${this.regionCode(region.lat, region.lng).toString(16)}.`);
    const { peers, ms } = status;
    network.info(`Connected ${peers} connections through ${bridgeUrl} in ${ms.toLocaleString()} ms.`);
    network.attached(network);
    return network;
  }
  
  async disconnect() { // Politely close network connection.
    const health = this.peer.health();
    await this.disconnector();
    this.info(`disconnected with ${health.peers.length} connections and ${health.axonRoles.length} axons.`);
    this.resetStatePromises();
  }
  async replicateStorage() { // Let the network know that we might go away without further notice.
    // FIXME. It would be great if we could remove ourselves from any non-leaf positions in the Axon, but stay subscribed.
  }
  fastDisconnect() { // Synchronous attempt to be polite to those connected.
    this.peer.leave(); // Execution is asynchronous. Will not finish -- or perhaps even really start -- within the call.
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

  static getCanvas(file) { // Promise a Canvas from a File of type image/*. ONLY IN BROWSERS!
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
  static  async downsampledBlob({blob, outputType = 'image/jpeg', maxDimension = 1024}) { // ONLY IN BROWSERS!
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
    // Publish Blob (or File) and answer an identifier that can be used to re-assemble. Truthy maxDimension works only in browsers!
    if (!blob.size) throw new Error(`Cannot chunkify empty Blob.`);
    if (maxDimension) blob = await this.constructor.downsampledBlob({blob, maxDimension});
    const {type:mime, name} = blob;
    const topic = {name: uuidv4(), region, owner};
    const buffer = await blob.arrayBuffer();
    const u8 = new Uint8Array(buffer);
    //console.log('blob', blob.size, u8.length);
    const data = await publishChunkedBytes(this.peer, u8, {topic, signWith, mime, name, ...rest});
    this.debug('chunked', data);
    return data;
  }
  async assembleChunkedDataURL(topic) { // Promise {bytes, mime, name, dataURL} that was chunkified to topic.
    const data = await receiveChunkedBytes(this.peer, topic, {/*, onProgress: console.log*/});
    // Using dataURL is not terribly efficient, but it is convenient, because formatReplies can return HTML strings with all the data in them,
    // instead of, e.g., needing javascript to later set properties of elements to createObjectURL of a Blob.
    data.dataURL = this.constructor.u82dataURL(data.bytes, data.mime);
    this.debug('assembled', topic);
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
	this.debug('received', {msgId, topic, ts, signerPubkey, deleted, message});
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
    this.debug('published', {topic, subject, payload, issuedTime, rest, signWith});
    if (payload) return await this.peer.pub(topic, {issuedTime, payload, ...rest}, options);
    // The next would not normally happen, but until since:'latest' works, we need a way to send a null payload and have the handler delete the entry.
    if (!subject) return await this.peer.pub(topic, {issuedTime, payload, ...rest}, options);
    return await this.peer.kill(topic, subject, options);
  }

  host() {
    return this.peer.host();
  }
  unhost() {
    return this.peer.unhost();
  }
  // Mostly internal stuff.
  static regionCode(lat, lng) { // Answer containing region code.
    return geoCellId(lat, lng);
  }
  static regionCenter(regionCode) {
    return geoCellCenter(regionCode);
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
    return this.regionCenter(this.regionCode(lat, lng));
  }
  // Todo: Integrate with AxonaPeer's complex logging.
  debug(...rest) { // Add debug logspam.
    this.debugLogger?.(this.nodeIdentity.id, ...rest);
  }
  info(...rest) { // Add debug logspam.
    (this.infoLogger || this.debugLogger)?.(this.nodeIdentity.id, ...rest);
  }
}
export default P2PWebNetwork;
