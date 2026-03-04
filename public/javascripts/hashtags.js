const { URLSearchParams, localStorage } = globalThis; // For linters.
import { updateQueryParameters, updateSubscriptions, Marker } from './map.js';
import { resetInactivityTimer } from './main.js';

// We subscribe to the cartesian product of the list of non-overlapping cells and all hashes.
// We publish to just the first of these.
export const Hashtags = {
  hashtags: JSON.parse(localStorage.getItem('hashtags') ||
		       '{"🍰cake": true, "🔥fire": true, "🌊flood": true, "🆘help": "pub", "🧊ice": true}'),
  add(label) { // Ensure label is an active hashtag.
   this. hashtags[label] ||= true; // If it's 'pub', let it remain so.
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
  stripLeadingEmoji(string) { // Return string without any leading emoji (which might be of varying length).
    return string.replace(/^\p{Extended_Pictographic}/u, '') || string;
  },
  firstEmoji(tag) { // First emoji that appears in string, else falsy.
    return tag.match(/\p{Extended_Pictographic}/u)?.[0];
  },
  identicon(tag, slot = '') {
    return `<minidenticon-svg ${slot ? `slot="${slot}"` : ''} username="${tag}"></minidenticon-svg>`;
  },
  markerHTML(tag) { // HTML (possibly text) to represent tag as a marker on map.
    return this.firstEmoji(tag) || this.identicon(tag);
  },
  pubtagHTML(tag) { // HTML (possibly text) to represent tag with defaulted icon.
    const emoji = this.firstEmoji(tag);
    return emoji ? tag : this.identicon(tag) + tag;
  },
  onchange({redisplaySubscribers = true, resetSubscriptions = true} = {}) { // Update and persist internal data, and update visuals.
    // If redisplaySubscribers, the presence/order may have changed.
    if (redisplaySubscribers) this.resetSubscriberDisplay();
    localStorage.setItem('hashtags', JSON.stringify(this.hashtags));
    updateQueryParameters();
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
	this.onchange({redisplaySubscribers: false, resetSubscriptions: false});
      });
      element.onclick = event => {
	resetInactivityTimer();
	const chip = event.target;
	const label = chip.label;
	const isPub = label === this.getPublish();
	const altPub = isPub && this.getSubscribe().find(tag => tag != label);
	if (altPub) this.setPublishChip([...chip.parentElement.children].find(child => child.label === altPub));
	else if (isPub && !chip.selected) { chip.selected = true; return; } // Don't allow deselecting the only pub tag.
	this.hashtags[label] = chip.selected;
	chip.removable = !chip.selected;
	Marker.closePopup();
	this.onchange({redisplaySubscribers: false});
      };
    });
    this.chipset.insertAdjacentHTML("afterbegin",  // Chip to add a new hashtag.
				    `<md-filled-text-field class="newtag" placeholder="➕add topic"></md-filled-text-field>`);
    this.chipset.firstChild.onchange = event => { // Add the new hashtag.
      resetInactivityTimer();
      const tag = event.target.value.trim();
      if (!tag);
      this.add(tag);
      Marker.closePopup();
      this.onchange();
    };
  },
  setPublish(newTag) {
    const oldTag = this.getPublish();
    this.hashtags[oldTag] = true;
    this.hashtags[newTag] = 'pub';
    return oldTag;
  },
  setPublishChip(chip) { // Set chip to be the new publishing tag, return the label.
    // If newTag is falsy, find one that isn't the current one if possible.
    const newTag = chip.label;
    const oldTag = this.setPublish(newTag);
    [...chip.parentElement.children].find(chip => chip.label === oldTag).classList.remove('pub');
    chip.classList.add('pub');
    return newTag;
  },
  resetPublisherDisplay(popup) { // Lay out the choices for what to publish to, including the option to cancle the alert.
    const chipset = popup.querySelector('form');
    chipset.innerHTML = this.getSubscribe()
      .map(tag => `<label><md-radio name="pub" value="${tag}" ${this.hashtags[tag] === 'pub' ? 'checked' : ''}></md-radio> ${tag}</label>`)
      .join('');
    chipset.addEventListener('change', event => { // Do not re-publish yet, but do change tag display.
      const tag = event.target.value;
      const html = this.pubtagHTML(tag);
      popup.querySelector('span').innerHTML = html;
      this.enableUpdate(popup);
    });
    popup.querySelector('md-outlined-text-field').addEventListener('input', event => {
      this.enableUpdate(popup);
    });
  },
  enableUpdate(popup) { // The user has changed something. Allow update.
    const button = popup.querySelector('md-filled-button');
    if (!button.hasAttribute('disabled')) return;
    button.removeAttribute('disabled');
    popup.querySelector('.times').insertAdjacentHTML("beforeend", "for update to...");
  }
};

// Populate hashtags data and display.
new URLSearchParams(location.search).get('tags')?.split(',').forEach(tag => Hashtags.add(tag));
Hashtags.onchange({resetSubscriptions: false}); // Too early to subscribe, but will be done during initialization.
