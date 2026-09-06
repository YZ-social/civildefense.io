// In-memory implementation of the pubsub storage interface.
//
// Interface (all methods synchronous here, but callers should treat them as
// potentially async-capable so a future backend, e.g. Redis, can be dropped
// in without touching pubsub.js):
//   set(type, topicId, subject, value, ttlMs)  -> void
//   remove(type, topicId, subject)             -> value | null
//   values(type, topicId)                      -> value[]
//   entries(type, topicId)                     -> [subject, value][]
//   topics(type)                               -> topicId[]
//
// `type` is always 'pub' or 'sub'. Expiry (ttlMs) is owned entirely by the
// backend: this implementation uses setTimeout; a Redis backend would use
// native key/field TTL (e.g. HEXPIRE) instead, and wouldn't need `timers`.

const publicationRolloverLimit = 1000;

const data = {pub: {}, sub: {}};
const timers = {pub: {}, sub: {}};

function bucketFor(collection, type, topicId) {
  return collection[type][topicId] ||= {};
}

function cancelTimer(type, topicId, subject) {
  const bucket = timers[type][topicId];
  if (!bucket) return;
  clearTimeout(bucket[subject]);
  delete bucket[subject];
  if (!Object.keys(bucket).length) delete timers[type][topicId];
}

function set(type, topicId, subject, value, ttlMs) {
  cancelTimer(type, topicId, subject); // replacing a value resets its expiry
  const bucket = bucketFor(data, type, topicId);
  if (type === 'pub') {
    const keys = Object.keys(bucket);
    if (keys.length >= publicationRolloverLimit) {
      console.warn('Over pub limit on topic', topicId, keys.length);
      delete bucket[keys[0]];
    }
  }
  bucket[subject] = value;
  if (ttlMs) {
    bucketFor(timers, type, topicId)[subject] = setTimeout(() => remove(type, topicId, subject), ttlMs);
  }
}

function remove(type, topicId, subject) {
  cancelTimer(type, topicId, subject);
  const bucket = data[type][topicId];
  if (!bucket) return null;
  const value = bucket[subject];
  delete bucket[subject];
  if (!Object.keys(bucket).length) delete data[type][topicId];
  return value ?? null;
}

function values(type, topicId) {
  return Object.values(data[type][topicId] || {});
}

function entries(type, topicId) {
  return Object.entries(data[type][topicId] || {});
}

function topics(type) {
  return Object.keys(data[type]);
}

export const store = {set, remove, values, entries, topics};
