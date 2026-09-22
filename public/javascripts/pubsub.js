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
export function setSender(receiver) { // Set the means by which we fire events over a direct connection.
  invoke = receiver; // E.g. (nodeId, handlerId, envelope) => getSocket(nodeId).send(JSON.stringify([handlerId, envelope]));
}

function directFireEvent(...rest) { // Send envelope to a subscribed hander.
  return invoke(...rest).catch(async error => { // Error sending, e.g., nodeTag is gone and we had not yet noticed.
    console.log(error.message || error);
    const [nodeTag, id, envelope] = rest;
    await deleteSubscriber(nodeTag);
    const topic = envelope.topic;
    const topicId = await deriveTopicId(topic);
    const subscription = await store.get('sub', topicId, id);
    console.log('push error activation:', topic, topicId, id, subscription);
    if (subscription) push(envelope, subscription, PUBLISH_TIMEOUT); // Do not wait for push.
  });
}

let burstQueue = Promise.resolve();
function sendBurst(thunk) { // Serialize outbursts so that we and a client that subscribed to a bunch both have time to send/accept ack's.
  burstQueue = burstQueue.then(thunk);
}

export async function subscribe(topic, nodeTag, {since = 'all', pushData = null}) {
  // Axona allows multiple handlers on the same topic, but we don't use that in civildefense, and do not implement it here.

  const {name, region, owner, write, topicId} = await resolveTopic(topic);
  const id = uuidv4();
  await store.set('sub', topicId, nodeTag, id, SUBSCRIPTION_TIMEOUT);
  // If pushData, store it separately by nodeTag until it needs to be activated.
  if (pushData) {
    console.log('track push sub', topicId, nodeTag, pushData.endpoint.slice(0, 80));
    await store.set('track', topicId, nodeTag, pushData, TRACK_TIMEOUT);
  } else {
    store.remove('track', topicId, nodeTag);
  }
  if (since) { // invoke handler on any sticky data, but only after we have told client the subscription id. TODO: is there a better way?
    setTimeout(() =>
      sendBurst(async () => {
	let lastEnvelope = null, lastTime = 0;
	for (const envelope of await store.values('pub', topicId)) {
	  switch (since) {
	  case 'all':
	    await directFireEvent(nodeTag, id, envelope);
	    break;
	  case 'latest':
	    if (envelope.ts > lastTime) {
	      lastTime = envelope.ts;
	      lastEnvelope = envelope;
	    }
	    break;
	  default: // Must be a timestamp
	    if (envelope.ts === since) await directFireEvent(nodeTag, id, envelope);
	  }
	}
	if (lastEnvelope) directFireEvent(nodeTag, id, lastEnvelope);
      }), 100);
  }
  return {topicName: {name, region, owner, write}, topicId, id};
}

export async function unsubscribe(topic, nodeTag, {pushId}) {
  // Unsubscribe subscription and any unactivated tracking subscription from the specified node.
  // Additionally, an activated sticky pushId will be removed if specified - it is the nodeTag from a previous session).

  const topicId = await deriveTopicId(topic);
  let id = await store.remove('sub', topicId, nodeTag), tracked;
  // Also remove any sticky push subscription:
  // If not yet promoted to sub, it's in track under our current, protectable nodeTag.
  await store.remove('track', topicId, nodeTag);
  // Otherwise, it might have been activated in sub under pushId (i.e., a previous session nodeTag).
  // TODO: pushId should probably be a JWS that was signed in the subscribing node's previous session by the pushId,
  // thus proving that the request actually came from the succcessor to that node.
  if (pushId) tracked = await store.remove('sub', topicId, pushId);  // pushId must match that used during activation.
  //if (pushId) console.log('normal unsubscribe remove tracking', pushId, tracked?.endpoint.slice(0, 80));
  return {ok: !!id, id, pushId: tracked}; // Axona doesn't return the id(s) of the subscription(s), but it is convenient for us to do so.
}

export async function deleteSubscriber(nodeTag) {
  // The node is gone: lost connection, or directFireEvent failed.
  console.log('deleteSubscriber', nodeTag);
  for (const topicId of await store.topics('sub')) { // Remove in all topics.
    const sub = await store.remove('sub', topicId, nodeTag);
    if (sub) console.log('removed sub', topicId, nodeTag, sub);
    // Activate pending push subscription, if any, by moving it from 'track' to active 'sub'.
    const pushSubscription = await store.remove('track', topicId, nodeTag);
    if (pushSubscription) {
      console.log('activating', topicId, nodeTag, pushSubscription.endpoint.slice(0, 80));
      await store.set('sub', topicId, nodeTag, pushSubscription, TRACK_TIMEOUT);
    }
  }
}

function isConnectedSubscription(handlerInfo) { // True if a it's a direct-connect subscription, false if sticky (push).
  return 'string' === typeof(handlerInfo);
}
async function handleEvents(topicId, envelope)  {
  const subs = await store.entries('sub', topicId);
  // Each sub's handlerInfo can be an ordinary subscription nodeId, or a sticky push subscription data.
  return Promise.all(subs.map(([nodeTag, handlerInfo]) => {
    if (isConnectedSubscription(handlerInfo)) { // nodeId
      return directFireEvent(nodeTag, handlerInfo, envelope);
    } else { // activated sticky push subscription data object.
      console.log('pushing for nodeId', nodeTag, handlerInfo?.endpoint.slice(0, 80));
      push(envelope, handlerInfo, PUBLISH_TIMEOUT);
      return null; // Do not wait for push
    }
  }));
}

export async function publish(topic, message, {signWith}) {
  // Publish message to any existing subscription.

  const topicId = await deriveTopicId(topic);
  const signerPubkey = signWith?.authorId || undefined;
  const payload = JSON.stringify({message, publisher: signerPubkey});
  const msgId = await hash2Hex(payload);
  const envelope = {msgId, topic, ts: Date.now(), message, signerPubkey};
  await store.set('pub', topicId, msgId, envelope, PUBLISH_TIMEOUT);
  await handleEvents(topicId, envelope);
  return msgId;
}

export async function unpublish(topic, msgId, {signWith}) {
  // Kill a publication by removing it from persistence, and firing removal event for existing subs.

  const topicId = await deriveTopicId(topic);
  const envelope = await store.remove('pub', topicId, msgId);
  if (!envelope) return {ok: false}; // we didn't have it.
  envelope.deleted = true;
  envelope.message = null;
  await handleEvents(topicId, envelope);
  return {ok: true};
}

export const operators = {setSender, subscribe, unsubscribe, deleteSubscriber, publish, unpublish};
