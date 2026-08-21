// In memory pubsub, for either client-only testing, or server-websocket testing
const { v4:uuidv4 } = await import('uuid');
const { TextEncoder, crypto, Buffer } = globalThis;

function setBucket(collection, type, topicId, subject, value) { // Set value in the collection.
  const bucket = collection[type][topicId] ||= {};
  if ((collection === data) && (type === 'pub')) {
    const keys = Object.keys(bucket);
    const size = keys.length;
    if (size > 1000) {
      console.warn('Over pub limit on topic', topicId, size); // TODO: rotate out the earliest received.
      delete bucket[keys[0]];
    }
  }
  bucket[subject] = value;
}
function removeBucket(collection, type, topicId, subject) { // Return the value and stop storing it.
  const bucket = collection[type][topicId];
  if (!bucket) return null;
  const value = bucket[subject];
  delete bucket[subject];
  if (!Object.keys(bucket).length) delete collection[type][topicId];
  return value;
}

const SUBSCRIPTION_TIMEOUT = 0; // No need, because we run deleteSubscriber on disconnect.
const PUBLISH_TIMEOUT = 24 * 60 * 60e3;      // Delete after 24 hours.
const timeouts = {pub: {}, sub: {}};
function expire(type, topicId, subject, remover, timeout) { // Cancellably schedule remover() to fire at timeout.
  if (!timeout) return;
  setBucket(timeouts, type, topicId, subject, setTimeout(() => { remover(); cancel(type, topicId, subject); }, timeout));
}
function cancel(type, topicId, subject) { // Cancel a sheduled expiration.
  clearTimeout(removeBucket(timeouts, type, topicId, subject));
}

// pub maps eventName => {[subject]: storageItem, ...}, where subject is the message id. Entries purged after PUBLISH_TIMEOUT.
// sub maps  eventName => {[subject]: ws, ...}, where subject is the subscriber id. Entries purged after SUBSCRIPTION_TIMEOUT.
const data = {pub: {}, sub: {}};
function getDataValues(type, topicId) { // For all subjects
  return Object.values(data[type][topicId] || {});
}
function getDataEntries(type, topicId) {
  return Object.entries(data[type][topicId] || {});
}

function deleteSub(topicId, subject) {
  return removeBucket(data, 'sub', topicId, subject);
}
function normalizeTopic({name, region, owner, write = 'open'} = {}) {
  if (typeof(region) === 'string') region = parseInt(region);;
  return {name, region, owner, write};
}
function deriveTopicId(topic) {
  return JSON.stringify(normalizeTopic(topic)); // No need to hash in this implementation.
}

let invoke;
export function setReceiver(receiver) {
  invoke = receiver;
}

export function subscribe(topicName, nodeTag, {since = 'all'}) {
  // Axona allows multiple handlers on the same topic, but we don't use that in civildefense, and do not implement it here.
  const topicId = deriveTopicId(topicName);
  const id = uuidv4();
  cancel('sub', topicId, id);
  expire('sub', topicId, id, () => deleteSub(topicId, id), SUBSCRIPTION_TIMEOUT);
  setBucket(data, 'sub', topicId, nodeTag, id);
  if (since) setTimeout(() => { // invoke handler on any sticky data, but only after we have told client the subscription id.
    let lastEnvelope = null, lastTime = 0;
    for (const envelope of getDataValues('pub', topicId)) {
      switch (since) {
      case 'all':
	invoke(nodeTag, id, envelope);
	break;
      case 'latest':
	if (envelope.ts > lastTime) {
	  lastTime = envelope.ts;
	  lastEnvelope = envelope;
	}
	break;
      default: // Must be a timestamp
	if (envelope.ts === since) invoke(nodeTag, id, envelope);
      }
    }
    if (lastEnvelope) invoke(nodeTag, id, lastEnvelope);
  }, 100);
  return {topicName, topicId, id};
}

export function unsubscribe(topic, nodeTag, options) {
  const topicId = deriveTopicId(topic);
  cancel('sub', topicId, nodeTag);
  const id = deleteSub(topicId, nodeTag);
  return {ok: true, id}; // Axona doesn't return the id(s) of the subscription(s), but it is convenient for us to do so.
}

export function deleteSubscriber(nodeTag) {
  for (const topicId in data.sub)  {
    const keySubs = data.sub[topicId];
    for (const [subject, value] of Object.entries(keySubs)) {
      if (nodeTag === subject) {
	deleteSub(topicId, subject, keySubs);
	cancel('sub', topicId, subject);
      }
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
  for (const [nodeTag, id] of getDataEntries('sub', topicId)) invoke(nodeTag, id, envelope);
  setBucket(data, 'pub', topicId, msgId, envelope);
  expire('pub', topicId, msgId, () => removeBucket(data, 'pub', topicId, msgId), PUBLISH_TIMEOUT);
  return msgId;
}

export function unpublish(topic, msgId, {signWith}) {
  const topicId = deriveTopicId(topic);  
  cancel('pub', topicId, msgId);
  const envelope = removeBucket(data, 'pub', topicId, msgId);
  if (!envelope) return {ok: false}; // we didn't have it.
  envelope.deleted = true;
  envelope.message = null;
  for (const [nodeTag, id] of getDataEntries('sub', topicId)) invoke(nodeTag, id, envelope);
  return {ok: true};
}
