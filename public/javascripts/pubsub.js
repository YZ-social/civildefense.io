// Centralized pubsub, for either client-only testing, or server-websocket testing.
import { v4 as uuidv4 } from 'uuid';
// CivilDefense dht=-1 has no networking at all and loads this in browser, but isn't running when push would fire.
const { push } = globalThis.process ? await import('./push.js') : {};
const { TextEncoder, crypto, Buffer } = globalThis;

const hasBuffer = typeof Buffer !== 'undefined';
let toHex = hasBuffer ? u8 => Buffer.from(u8).toString('hex') : u8 => u8.toHex();
async function hash2Hex(text) { // Promise hex-coded SHA256(text).
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(hash));
}
export async function resolveTopic(descriptor) {  // Normalize like axona.
  if (typeof(descriptor) !== 'object') return {topicId: descriptor};
  let {name, region, owner = null, write = owner ? 'owner' : 'open'} = descriptor;
  if (typeof(region) === 'string') region = parseInt(region);;
  const normalized = {name, region, owner, write};
  const topicId = await hash2Hex(JSON.stringify(normalized));
  return {name, region, owner, write, topicId};
};
// Promise a string.
export const deriveTopicId = descriptor => resolveTopic(descriptor).then(resolved => resolved.topicId);


// All storage (the type -> topicId -> subject -> value buckets, and their
// expiry) lives behind this interface. Swap the import below for a
// different implementation of the same interface (e.g. store-memory.js for
// local testing) -- nothing else in this file needs to change. Every store
// call is awaited: that's a no-op for a synchronous backend and required
// for an async one like Redis, so the same file works with either.
const storeSource = globalThis.process?.env.REDIS_URL ? './store-redis.js' : './store-memory.js';
const { store } = await import(storeSource);
console.log('store source', storeSource);

const SUBSCRIPTION_TIMEOUT = 0; // No need, because we run deleteSubscriber on disconnect.
const PUBLISH_TIMEOUT = 24 * 60 * 60e3;      // Delete after 24 hours.
const TRACK_TIMEOUT = PUBLISH_TIMEOUT;

let invoke;
export function setReceiver(receiver) { // Set the means by which we fire events over a connection.
  invoke = receiver; // E.g. (nodeId, handlerId, envelope) => getSocket(nodeId).send(JSON.stringify([handlerId, envelope]));
}
async function fireEvent(...rest) { // Send envelope to a subscribed hander.
  try {
    invoke(...rest);
  } catch (error) { // Error sending, e.g., nodeTag is gone and we had not yet noticed.
    const [nodeTag, id, envelope] = rest;
    await deleteSubscriber(nodeTag);
    const subscription = await store.get('sub', await deriveTopicId(envelope.topic), id);
    if (subscription) push(envelope, subscription, PUBLISH_TIMEOUT);
  }
}

export async function subscribe(topic, nodeTag, {since = 'all', pushData = null}) {
  // Axona allows multiple handlers on the same topic, but we don't use that in civildefense, and do not implement it here.

  const {name, region, owner, write, topicId} = await resolveTopic(topic);
  const id = uuidv4();
  await store.set('sub', topicId, nodeTag, id, SUBSCRIPTION_TIMEOUT);
  // If pushData, store it separately by nodeTag until it needs to be activated.
  if (pushData) await store.set('track', topicId, nodeTag, pushData, TRACK_TIMEOUT);
  if (since) { // invoke handler on any sticky data, but only after we have told client the subscription id.
    setTimeout(async () => {
      let lastEnvelope = null, lastTime = 0;
      for (const envelope of await store.values('pub', topicId)) {
	switch (since) {
	case 'all':
	  await fireEvent(nodeTag, id, envelope);
	  break;
	case 'latest':
	  if (envelope.ts > lastTime) {
	    lastTime = envelope.ts;
	    lastEnvelope = envelope;
	  }
	  break;
	default: // Must be a timestamp
	  if (envelope.ts === since) await fireEvent(nodeTag, id, envelope);
	}
      }
      if (lastEnvelope) fireEvent(nodeTag, id, lastEnvelope);
    }, 100);
  }
  return {topicName: {name, region, owner, write}, topicId, id};
}

export async function unsubscribe(topic, nodeTag, {pushId}) {
  // Unsubscribe subscription and any unactivated tracking subscription from the specified node.
  // Additionally, an activated sticky pushId will be removed if specified - it is the nodeTag from a previous session).

  const topicId = await deriveTopicId(topic);
  let id = await store.remove('sub', topicId, nodeTag);
  // Also remove any sticky push subscription:
  // If not yet promoted to sub, it's in track under our current, protectable nodeTag.
  await store.remove('track', topicId, nodeTag);
  // Otherwise, it might have been activated in sub under pushId (i.e., a previous session nodeTag).
  // TODO: pushId should probably be a JWS that was signed in the subscribing node's previous session by the pushId,
  // thus proving that the request actually came from the succcessor to that node.
  if (pushId) pushId = await store.remove('sub', topicId, pushId);  // pushId must match that used during activation.
  return {ok: !!id, id, pushId}; // Axona doesn't return the id(s) of the subscription(s), but it is convenient for us to do so.
}

export async function deleteSubscriber(nodeTag) {
  // The node is gone: lost connection, or fireEvent failed.

  for (const topicId of await store.topics('sub')) { // Remove in all topics.
    await store.remove('sub', topicId, nodeTag);
    // Activate pending push subscription, if any, by moving it from 'track' to active 'sub'.
    const pushSubscription = await store.remove('track', topicId, nodeTag);
    if (pushSubscription) {
      //console.log('activiting', topicId, nodeTag, pushSubscription);
      await store.set('sub', topicId, nodeTag, pushSubscription, TRACK_TIMEOUT);
    }
  }
}

export async function publish(topic, message, {signWith}) {
  // Publish message to any existing subscription.

  const topicId = await deriveTopicId(topic);
  const signerPubkey = signWith?.authorId || undefined;
  const payload = JSON.stringify({message, publisher: signerPubkey});
  const msgId = await hash2Hex(payload);
  const envelope = {msgId, topic, ts: Date.now(), message, signerPubkey};
  await store.set('pub', topicId, msgId, envelope, PUBLISH_TIMEOUT);
  const subs = await store.entries('sub', topicId);
  // Each sub's handlerInfo can be an ordinary subscription nodeId, or a sticky push subscription data.
  await Promise.all(subs.map(([tag, handlerInfo]) => {
    if ('string' === typeof(handlerInfo)) { // nodeId
      return fireEvent(tag, handlerInfo, envelope);
    } else { // activated sticky push subscription data object.
      return push(envelope, handlerInfo, PUBLISH_TIMEOUT);
    }
  }));
  return msgId;
}

export async function unpublish(topic, msgId, {signWith}) {
  // Kill a publication by removing it from persistence, and firing removal event for existing subs.

  const topicId = await deriveTopicId(topic);
  const envelope = await store.remove('pub', topicId, msgId);
  if (!envelope) return {ok: false}; // we didn't have it.
  envelope.deleted = true;
  envelope.message = null;
  for (const [nodeTag, id] of await store.entries('sub', topicId)) await fireEvent(nodeTag, id, envelope);
  return {ok: true};
}
