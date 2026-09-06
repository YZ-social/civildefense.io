// Redis implementation of the pubsub storage interface (see store-memory.js
// for the interface contract). Drop-in replacement: pubsub.js only needs to
// change which of these two modules it imports `store` from.
//
// Design notes:
// - Each (type, topicId, subject) item is its own Redis string key, so its
//   24h (or whatever) expiry is native Redis key TTL (`PX`) -- Redis reclaims
//   the memory itself, no client-side timers, no rehydration needed on
//   restart of this process.
// - A per-(type, topicId) sorted set (`idx:...`) tracks which subjects exist,
//   scored by insertion time. This gives real, correctly-ordered "oldest
//   first" eviction for the publication rollover limit.
// - Reads (`values`/`entries`) tolerate the index referencing an item that
//   has since expired: they filter it out and lazily prune the index entry.
// - This intentionally avoids Redis 7.4+'s per-hash-field TTL (HEXPIRE), so
//   it works on any reasonably recent Redis/Valkey. If you're guaranteed
//   7.4+, storing each bucket as one hash with HEXPIRE per field is a viable
//   alternative with fewer keys -- not needed here.

import { createClient } from 'redis';

const publicationRolloverLimit = 1000;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const client = createClient({ url: REDIS_URL });
client.on('error', err => console.error('Redis client error', err));
await client.connect();

function itemKey(type, topicId, subject) {
  return `civildefense.io:${type}:${topicId}:${subject}`;
}
function indexPrefix(type) {
  return `civildefense.io:idx:${type}:`;
}
function indexKey(type, topicId) {
  return `civildefense.io:idx:${type}:${topicId}`;
}

async function set(type, topicId, subject, value, ttlMs) {
  const idxKey = indexKey(type, topicId);
  if (type === 'pub') { // Limit pubs to rollover limit.
    const size = await client.zCard(idxKey);
    if (size >= publicationRolloverLimit) {
      console.warn('Over pub limit on topic', topicId, size);
      const oldest = await client.zPopMin(idxKey); // {value, score} for the lowest-scored (earliest) member
      if (oldest?.value) await client.del(itemKey(type, topicId, oldest.value));
    }
  }
  await client.set(itemKey(type, topicId, subject), JSON.stringify(value), ttlMs ? { PX: ttlMs } : undefined);
  await client.zAdd(idxKey, { score: Date.now(), value: subject });
}

async function remove(type, topicId, subject) { // Returns old value, or null.
  const idxKey = indexKey(type, topicId);
  const key = itemKey(type, topicId, subject);
  const raw = await client.get(key);
  await client.del(key);
  await client.zRem(idxKey, subject);
  return raw == null ? null : JSON.parse(raw);
}

async function entries(type, topicId) {
  const idxKey = indexKey(type, topicId);
  const subjects = await client.zRange(idxKey, 0, -1);
  if (!subjects.length) return [];
  const raws = await client.mGet(subjects.map(subject => itemKey(type, topicId, subject)));
  const result = [];
  const stale = [];
  subjects.forEach((subject, i) => {
    if (raws[i] == null) stale.push(subject); // item's native TTL fired since we indexed it
    else result.push([subject, JSON.parse(raws[i])]);
  });
  if (stale.length) await client.zRem(idxKey, stale);
  return result;
}

async function values(type, topicId) {
  return (await entries(type, topicId)).map(([, value]) => value);
}

async function topics(type) {
  const prefix = indexPrefix(type);
  const ids = [];
  // scanIterator yields batches (arrays of keys), not individual keys, on
  // this client version -- normalize so this works across client versions.
  for await (const batch of client.scanIterator({ MATCH: `${prefix}*` })) {
    for (const key of [].concat(batch)) ids.push(key.slice(prefix.length));
  }
  return ids;
}

export const store = { set, remove, values, entries, topics };

// Not part of the shared interface -- useful for tests/graceful shutdown.
export async function close() {
  await client.quit();
}
