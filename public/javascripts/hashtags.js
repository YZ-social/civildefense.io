const { URL, URLSearchParams, localStorage } = globalThis; // For linters.
import { Int } from './translations.js';
import { updateSubscriptions, Marker } from './map.js';
import { resetInactivityTimer } from './main.js';

// We subscribe to the cartesian product of the list of non-overlapping cells and all hashes.
// We publish to just the first of these.
export const Hashtags = {

  // Unless otherwise noted, a `hashtag` is an extended hashtag that contains a leading emoji if known.
  // That emoji is used as the marker on the map.
  // This full string is what is displayed, and shared with others through publishing and urls.
  //
  // However, there is also a `canonical` form that is used in forming the eventName for pub/sub, in which the leading emoji is stripped.
  // A user might manually type in either form to add a new subscription, and they will receive publications that carry the full string.
  // Any user that does not yet have a leading emoji will display an identicon of the canonical part as the marker,
  // but the first time they get an extended string whose canonical part matches, they will start using that emoji going forward.
  // Thus:
  // 1. A user does not have to type an emoji to add a hashtag subscription.
  // 2. Once a user has an emoji for a given hashtag - either entered by them or learned from others - it will "stick" and not change for this user.
  // 3. But until then, we still have a marker that will automatically pick up the first one it sees from someone else.
  //    (The already displayed identicons do not change until the user "opens" a post, and then they all change.
  //     Later, we will allow a user to change what they see on their own device.)
  // 4. While an identicon is displayed, it is the same for all markers of this hashtag, regardless of whether the original posters
  //    were using the same emoji as each other.
  hashtags: {},
  canonical2extended: {},
  add(label, active = true, updateMarkers = true) { // Ensure label is a hashtag, initialized to active, and if existing, forcing it active.
    // Return our (possibly new) understanding of the extended hashtag.
    // Note that only startup-poplation of tags from persistence would ever specify active=false.
    // Here we accept a canonical or extended label, updating our records keyed by the canonical part,
    // but if we currently have just a canonical part we update our records to capture the extended.
    // (We do not change the emoji of an existing extended.)
    const canonical = this.canonicalTag(label);
    const ours = this.canonical2extended[canonical];
    const extended = ours || label;
    const isExtendingCanonical = !ours && label !== canonical; // We have only a canonical so far.
    if (isExtendingCanonical) {
      active = this.hashtags[canonical] || active;
      delete this.hashtags[canonical];
    }
    this.hashtags[extended] ||= active; // If it's 'pub', let it remain so.
    if (canonical !== extended) this.canonical2extended[canonical] = extended;
    if (isExtendingCanonical) {
      this.onchange({resetSubscriptions: false});
      if (updateMarkers) Marker.updateMarkers(canonical, extended);
    }
    return extended;
  },
  getAll() { // List of all the user's hashtags.
    return Object.keys(this.hashtags);
  },
  getSubscribe() { // Return a list of the hashtags to which the user intendeds to subscribe.
    return this.getAll().filter(tag => this.hashtags[tag]);
  },
  getPublish() { // Return the one hashtag to which the user intends to publish.
    return this.getAll().find(key => this.hashtags[key] === 'pub');
  },
  stripLeadingEmoji(string) { // Return string without any leading emoji (which might be of varying
    // length) followed by an optional emoji break character and any whitespace.
    return string.replace(/^\p{Extended_Pictographic}*\uFE0F?\s*/u, '') || string;
  },
  firstEmoji(tag) { // First emoji that appears in string, else falsy.
    return tag.match(/\p{Extended_Pictographic}/u)?.[0];
  },
  identicon(tag, slot = '') { // HTML for an identicon representing tag.
    // Unneeded and not necessarilly meaningful if tag has emoji.
    return `<minidenticon-svg ${slot ? `slot="${slot}"` : ''} username="${tag}"></minidenticon-svg>`;
  },
  formatMarker(tag) { // HTML (possibly text) to represent tag as a marker on map.
    return this.firstEmoji(tag) || this.identicon(tag);
  },
  formatPubtag(tag) { // HTML (possibly text) to represent tag with defaulted icon.
    const emoji = this.firstEmoji(tag);
    return emoji ? tag : this.identicon(tag) + tag;
  },
  canonicalTag(tag) { // A string representing tag, without the (leading) emoji if any.
    return this.stripLeadingEmoji(tag);
  },
  onchange({redisplaySubscribers = true, resetSubscriptions = true} = {}) { // Update and persist internal data, and update visuals.
    // If redisplaySubscribers, the presence/order may have changed.
    if (redisplaySubscribers) this.resetSubscriberDisplay();
    localStorage.setItem('hashtags', JSON.stringify(this.hashtags));
    if (resetSubscriptions) {
      updateSubscriptions();
      Object.values(Marker.markers).forEach(wrapper => this.hashtags[wrapper.hashtag] || wrapper.destroy());
    }
  },
  chipset: document.body.querySelector('.watching-hashtags'), // Element containing the user's chips.
  chipHTML(label) {
    const active = this.hashtags[label];
    return `<md-filter-chip label="${label}" elevated
        ${active === 'pub' ? 'class="pub"' : ''}
        ${active ? ' selected' : 'removable'}
      >${this.firstEmoji(label) ? '' : this.identicon(label, 'selected-icon')}</md-filter-chip>`;
  },
  resetSubscriberDisplay() { // Lay out all the hashtag chips display, including the input for adding new ones.
    this.chipset.innerHTML = '';
    const tags = this.getAll();

    // Sort alphabetically, ignoring any leading emoji, as these have unexpected orderings.
    tags.sort((a, b) => this.stripLeadingEmoji(a).localeCompare(this.stripLeadingEmoji(b)));
    const reordered = {};
    tags.forEach(tag => reordered[tag] = this.hashtags[tag]);
    this.hashtags = reordered;

    // Add a chip for each hashtag.
    tags.forEach(label => { // Elements are displayed from the bottom up.
      this.chipset.insertAdjacentHTML("afterbegin", this.chipHTML(label));
    });
    // IWBNI we just added handlers once to the chipset and relied on bubbling up, but there's something not working about that.
    [...this.chipset.children].forEach(element => {
      // Material design will update the displays. We have to handle the data changes.
      element.addEventListener('remove', event => {
	resetInactivityTimer();
	const chip = event.target;
	delete this.hashtags[chip.label];
	delete this.canonical2extended[this.canonicalTag(chip.label)];
	this.onchange({redisplaySubscribers: false, resetSubscriptions: false});
      });
      element.onclick = event => {
	resetInactivityTimer();
	const chip = event.target;
	const label = chip.label;
	const isPub = label === this.getPublish();
	const altPub = isPub && this.getSubscribe().find(tag => tag != label);
	if (altPub) this.setPublish(altPub);
	else if (isPub && !chip.selected) { chip.selected = true; return; } // Don't allow deselecting the only pub tag.
	this.hashtags[label] = chip.selected;
	chip.removable = !chip.selected;
	Marker.closePopup();
	this.onchange({redisplaySubscribers: false});
      };
    });
    this.chipset.insertAdjacentHTML("afterbegin",  // Chip to add a new hashtag.
				    `<md-filled-text-field class="newtag" placeholder="➕${Int`add topic`}"></md-filled-text-field>`);
    this.chipset.firstChild.onchange = event => { // Add the new hashtag.
      resetInactivityTimer();
      const tag = event.target.value.trim();
      if (!tag) return;
      Marker.closePopup();
      this.add(tag);
      this.setPublish(tag);
      this.onchange();
    };
  },
  setPublish(newTag) {
    const oldTag = this.getPublish();
    this.hashtags[oldTag] = true;
    this.hashtags[newTag] = 'pub';
    for (const chip of this.chipset.children) {
      if (chip.label === oldTag) chip.classList.remove('pub');
      else if (chip.label === newTag) chip.classList.add('pub');
    }
    return oldTag;
  }
};

// Populate hashtags data and display.
// First the persisted/default data:
const persisted = JSON.parse(localStorage.getItem('hashtags') ||
			     `{"🍰${Int`cake`}": true, "🔥${Int`fire`}": true, "🌊${Int`flood`}": true, "🆘${Int`help`}": "pub", "🧊${Int`ice`}": true}`);
Object.entries(persisted).forEach(([tag, active]) => Hashtags.add(tag, active, false));

new URLSearchParams(location.search).get('tags')?.split(',').forEach(tag => Hashtags.add(tag));
// We don't need the query parameters now. Get rid of them. They're annoying. But preserve dht, if any.
const copy = new URL(location);
const dht = copy.searchParams.get('dht');
if (copy.searchParams.size > (dht ? 1 : 0)) {
  copy.search = dht ? `?dht=${dht}` : '';
  console.log('replace with', copy.href);
  history.replaceState(null, '', copy);
}

Hashtags.onchange({resetSubscriptions: false}); // Too early to subscribe, but will be done during initialization.
