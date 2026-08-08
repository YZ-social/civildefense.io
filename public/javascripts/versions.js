import pkg from '../../package.json' with {type: 'json'};
export const appVersion = pkg.version; // Overall semver of app. Used in display, and for comparison by service worker.
export const dataVersion = globalThis.process?.env.EVENT_VERSION || appVersion.split('.')[0];  // Compatability differentiator used below.

export function stripLeadingEmoji(string) { // Return string without any leading emoji (which might be of varying
  // length) followed by an optional emoji break character and any whitespace.
  // {Extended_Pictographic} is often recommended instead of {Emoji} as the latter includes numbers
  // and symbols. However, the former misses, e.g., the flag emojis.
  return string.replace(/^\p{Emoji}*\uFE0F?\s*/u, '') ||
    (string.endsWith(' ') ? '' : string); // All emoji counts, but if ending with space, it is the start of an emoji + \s + tag for which just the tag counts.
};
export function canonicalTag(tag) { // A string representing tag, without the (leading) emoji if any.
  return stripLeadingEmoji(tag).toLowerCase();
}

export function agentPersistKey(metadataType, agentTag) { // A label for looking up metadataType for agentTag.
  return `${metadataType}-${agentTag}`;
}
export function agentTopic(metadataType, agentTag) { // Return topic name for public info about agent specified by tag.
  return `public:${dataVersion}:${agentPersistKey(metadataType, agentTag)}`;
}
export function cellHex(cellid) { // Convert cellid BigInt to properly padded hex.
  return cellid.toString(16).padStart(16, '0');
}
export function alertTopic(cellid, tag) { // Return topic name for public info about specified tag in cellid.
  return `civildefense.io:${dataVersion}:${cellHex(cellid)}:${canonicalTag(tag)}`;
}
export function topicCell(topicName) { // Return the cell that is baked in to the topic.
  // Note that canonicalTag(tag) may contain a colon, but dataVersion must not.
  return topicName.match(/civildefense.io:[^:]+:([a-z0-9]+):/)[1];
}
export function topicRegion(topicName) { // Return the region that is baked in to the topic.
  return '0x' + topicCell(topicName).slice(0, 2);
}
