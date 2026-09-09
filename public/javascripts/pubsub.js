// In memory pubsub, for either client-only testing, or server-websocket testing
import { v4 as uuidv4 } from 'uuid';
const pushHere = !!globalThis.process;
const webpush = pushHere ? await import('web-push') : {default: {}};
const { generateVAPIDKeys, setVapidDetails, sendNotification } = webpush.default;
const { TextEncoder, crypto, Buffer } = globalThis;

export const resolveTopic = async descriptor => {
  if (typeof(descriptor) !== 'object') return descriptor;
  let {name, region, owner = null, write = owner ? 'owner' : 'open'} = descriptor;
  if (typeof(region) === 'string') region = parseInt(region);;
  const normalized = {name, region, owner, write};
  const topicId = JSON.stringify(normalized); // TODO: hash after initial dev/debug
  return {name, region, owner, write, topicId};
};
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

// const vapidKeys = generateVAPIDKeys?.() || {};
// console.log({vapidKeys});
// setVapidDetails?.(
//   'mailto:example@yourdomain.org',
//   vapidKeys.publicKey,
//   vapidKeys.privateKey
// );
function push(envelope, {applicationServerKey, applicationId, ...subscription}) {
  const options = {
    // It would be nice to include topic, but that is application-specific.
    // Maybe it could be specified by pub options, but that's getting a bit weird.
    // Besides, I bet some services don't even use it.
    TTL: PUBLISH_TIMEOUT,
    vapidDetails: {
      subject: 'mailto:example@yourdomain.org',
      publicKey: applicationServerKey,
      privateKey: applicationId
    }
  };
  console.log('push', envelope, subscription, options);
  return sendNotification?.(subscription, JSON.stringify(envelope), options);
}

function delay(ms = 0) {
  return ms && new Promise(resolve => setTimeout(resolve, ms));
}

let invoke;
export function setReceiver(receiver) {
  invoke = receiver;
}
async function fireEvent(...rest) {
  try {
    invoke(...rest);
  } catch (error) { // Error sending, e.g., nodeTag is gone.
    const [nodeTag, id, envelope] = rest;
    await deleteSubscriber(nodeTag);
    const subscription = await store.get('sub', await deriveTopicId(envelope.topic), id);
    if (subscription) push(envelope, subscription);
  }
}
const throttleMS = 30; // Just to yield to other stuff.
async function fireThrottledEvent(...rest) {
  await fireEvent(...rest);
  await new Promise(resolve => setTimeout(resolve, throttleMS));
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
	  await fireThrottledEvent(nodeTag, id, envelope);
	  break;
	case 'latest':
	  if (envelope.ts > lastTime) {
	    lastTime = envelope.ts;
	    lastEnvelope = envelope;
	  }
	  break;
	default: // Must be a timestamp
	  if (envelope.ts === since) await fireThrottledEvent(nodeTag, id, envelope);
	}
      }
      if (lastEnvelope) fireEvent(nodeTag, id, lastEnvelope);
    }, 100);
  }
  return {topicName: {name, region, owner, write}, topicId, id};
}

export async function unsubscribe(topic, nodeTag, {pushId}) {
  const topicId = await deriveTopicId(topic);
  let id = await store.remove('sub', topicId, nodeTag);
  // Also remove any sticky push subscription:
  // If not yet promoted to sub, it's in track under our current, protectable nodeTag.
  await store.remove('track', topicId, nodeTag);
  // Otherwise, it might have been activated in sub under pushId (i.e., a previous session nodeTag).
  if (pushId) pushId = await store.remove('sub', topicId, pushId);  // pushId must match that used during activation.
  return {ok: !!id, id, pushId}; // Axona doesn't return the id(s) of the subscription(s), but it is convenient for us to do so.
}

export async function deleteSubscriber(nodeTag) {
  // subject === nodeTag for 'sub' entries, so we can remove directly rather
  // than fetching and filtering every topic's entries.
  for (const topicId of await store.topics('sub')) {
    await store.remove('sub', topicId, nodeTag);
    // Activate pending push subscription, if any.
    const pushSubscription = await store.remove('track', topicId, nodeTag);
    if (pushSubscription) {
      console.log('activiting', topicId, nodeTag, pushSubscription);
      await store.set('sub', topicId, nodeTag, pushSubscription, TRACK_TIMEOUT);
    }
  }
}

const hasBuffer = typeof Buffer !== 'undefined';
let toHex = hasBuffer ? u8 => Buffer.from(u8).toString('hex') : u8 => u8.toHex();
export async function publish(topic, message, {signWith}) {
  const topicId = await deriveTopicId(topic);
  const signerPubkey = signWith?.authorId || undefined;
  const payload = JSON.stringify({message, publisher: signerPubkey});
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  const msgId = toHex(new Uint8Array(hash));
  const envelope = {msgId, topic, ts: Date.now(), message, signerPubkey};
  await store.set('pub', topicId, msgId, envelope, PUBLISH_TIMEOUT);
  const subs = await store.entries('sub', topicId);
  await Promise.all(subs.map(([tag, handlerInfo]) => {
    if ('string' === typeof(handlerInfo)) { // nodeId
      return fireThrottledEvent(tag, handlerInfo, envelope);
    } else { // An activated push subscription.
      return push(envelope, handlerInfo);
    }
  }));
  return msgId;
}

export async function unpublish(topic, msgId, {signWith}) {
  const topicId = await deriveTopicId(topic);
  const envelope = await store.remove('pub', topicId, msgId);
  if (!envelope) return {ok: false}; // we didn't have it.
  envelope.deleted = true;
  envelope.message = null;
  for (const [nodeTag, id] of await store.entries('sub', topicId)) await fireThrottledEvent(nodeTag, id, envelope);
  return {ok: true};
}
