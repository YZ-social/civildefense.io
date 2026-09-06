// In memory pubsub, for either client-only testing, or server-websocket testing
const { v4:uuidv4 } = await import('uuid');
const { TextEncoder, crypto, Buffer } = globalThis;

// All storage (the type -> topicId -> subject -> value buckets, and their
// expiry) lives behind this interface. Swap the import below for a
// Redis-backed (or other) implementation of the same interface when the
// data no longer fits in memory; nothing else in this file needs to change.
import { store } from './store-memory.js';

const SUBSCRIPTION_TIMEOUT = 0; // No need, because we run deleteSubscriber on disconnect.
const PUBLISH_TIMEOUT = 24 * 60 * 60e3;      // Delete after 24 hours.

function normalizeTopic({name, region, owner, write = 'open'} = {}) {
  if (typeof(region) === 'string') region = parseInt(region);;
  return {name, region, owner, write};
}
function deriveTopicId(topic) {
  return JSON.stringify(normalizeTopic(topic)); // No need to hash in this implementation.
}
function delay(ms = 0) {
  return ms && new Promise(resolve => setTimeout(resolve, ms));
}

let invoke;
export function setReceiver(receiver) {
  invoke = receiver;
}
const throttleMS = 30; // Just to yield to other stuff.
async function pauseInvoke(...rest) {
  invoke(...rest);
  await new Promise(resolve => setTimeout(resolve, throttleMS));
}

export function subscribe(topicName, nodeTag, {since = 'all'}) {
  // Axona allows multiple handlers on the same topic, but we don't use that in civildefense, and do not implement it here.
  const topicId = deriveTopicId(topicName);
  const id = uuidv4();
  store.set('sub', topicId, nodeTag, id, SUBSCRIPTION_TIMEOUT);
  if (since) { // invoke handler on any sticky data, but only after we have told client the subscription id.
    setTimeout(async () => {
      let lastEnvelope = null, lastTime = 0;
      for (const envelope of store.values('pub', topicId)) {
	switch (since) {
	case 'all':
	  await pauseInvoke(nodeTag, id, envelope);
	  break;
	case 'latest':
	  if (envelope.ts > lastTime) {
	    lastTime = envelope.ts;
	    lastEnvelope = envelope;
	  }
	  break;
	default: // Must be a timestamp
	  if (envelope.ts === since) await pauseInvoke(nodeTag, id, envelope);
	}
      }
      if (lastEnvelope) invoke(nodeTag, id, lastEnvelope);
    }, 100);
  }
  return {topicName, topicId, id};
}

export function unsubscribe(topic, nodeTag, options) {
  const topicId = deriveTopicId(topic);
  const id = store.remove('sub', topicId, nodeTag);
  return {ok: true, id}; // Axona doesn't return the id(s) of the subscription(s), but it is convenient for us to do so.
}

export function deleteSubscriber(nodeTag) {
  for (const topicId of store.topics('sub')) {
    for (const [subject] of store.entries('sub', topicId)) {
      if (nodeTag === subject) store.remove('sub', topicId, subject);
    }
  }
}

const hasBuffer = typeof Buffer !== 'undefined';
let toHex = hasBuffer ? u8 => Buffer.from(u8).toString('hex') : u8 => u8.toHex();
export async function publish(topic, message, {signWith}) {
  const topicId = deriveTopicId(topic);
  const signerPubkey = signWith?.authorId || undefined;
  const payload = JSON.stringify({message, publisher: signerPubkey});
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const msgId = toHex(new Uint8Array(hash));
  const envelope = {msgId, topic, ts: Date.now(), message, signerPubkey};
  for (const [nodeTag, id] of store.entries('sub', topicId)) await pauseInvoke(nodeTag, id, envelope);
  store.set('pub', topicId, msgId, envelope, PUBLISH_TIMEOUT);
  return msgId;
}

export async function unpublish(topic, msgId, {signWith}) {
  const topicId = deriveTopicId(topic);
  const envelope = store.remove('pub', topicId, msgId);
  if (!envelope) return {ok: false}; // we didn't have it.
  envelope.deleted = true;
  envelope.message = null;
  for (const [nodeTag, id] of store.entries('sub', topicId)) await pauseInvoke(nodeTag, id, envelope);
  return {ok: true};
}
