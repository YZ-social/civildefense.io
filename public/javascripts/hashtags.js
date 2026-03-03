const { URLSearchParams, localStorage } = globalThis; // For linters.
import { updateQueryParameters, updateSubscriptions, Marker } from './map.js';
import { resetInactivityTimer } from './main.js';

// We subscribe to the cartesian product of the list of non-overlapping cells and all hashes.
// We publish to just the first of these.
export const Hashtags = {
  hashtags: JSON.parse(localStorage.getItem('hashtags') ||
		       '{"🍰cake": true, "🔥fire": true, "🌊flood": true, "🛟help": "pub", "🧊ice": true}'),
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
  firstEmoji(string) {
    return string.match(/\p{Extended_Pictographic}/u)?.[0] || "⚠️";
  },
  onchange(redisplaySubscribers = true) {
    if (redisplaySubscribers) this.resetSubscriberDisplay();
    localStorage.setItem('hashtags', JSON.stringify(this.hashtags));
    updateQueryParameters();
    Object.values(Marker.markers).forEach(wrapper => this.hashtags[wrapper.hashtag] || wrapper.destroy());
  },
  setPublish(chip) { // Set chip to be the new publishing tag, return the label.
    // If newTag is falsy, find one that isn't the current one if possible.
    const newTag = chip.label;
    const oldTag = this.getPublish();
    this.hashtags[oldTag] = true;
    this.hashtags[newTag] = 'pub';
    [...chip.parentElement.children].find(chip => chip.label === oldTag).classList.remove('pub');
    chip.classList.add('pub');
    return newTag;
  },
  chipset: document.body.querySelector('.watching-hashtags'), // Element containing the user's chips.
  chipHTML(label) {
    const active = this.hashtags[label];
    return `<md-filter-chip label="${label}" elevated
        ${active === 'pub' ? 'class="pub"' : ''}
        ${active ? ' selected' : 'removable'}
      ></md-filter-chip>`;
  },
  resetSubscriberDisplay() { // Lay out all the hashtag chips display, including the input for adding new ones.
    this.chipset.innerHTML = '';
    const tags = this.getAll();
    // Sort alphabetically, ignoring any leading emoji, as these have unexpected orderings.
    tags.sort((a, b) => this.stripLeadingEmoji(a).localeCompare(this.stripLeadingEmoji(b)));
    tags.forEach(label => { // Elements are displayed from the bottom up.
      this.chipset.insertAdjacentHTML("afterbegin", this.chipHTML(label));
    });
    [...this.chipset.children].forEach(element => {
      // Material design will update the displays. We have to handle the data changes.
      element.addEventListener('remove', event => {
	resetInactivityTimer();
	const chip = event.target;
	delete this.hashtags[chip.label];
	this.onchange(false);
	updateSubscriptions();
      });
      element.onclick = event => {
	resetInactivityTimer();
	const chip = event.target;
	const label = chip.label;
	const isPub = label === this.getPublish();
	const altPub = isPub && this.getSubscribe().find(tag => tag != label);
	if (altPub) this.setPublish([...chip.parentElement.children].find(child => child.label === altPub));
	else if (isPub && !chip.selected) { chip.selected = true; return; } // Don't allow deselecting the only pub tag.
	this.hashtags[label] = chip.selected;
	chip.removable = !chip.selected;
	this.onchange(false);
	updateSubscriptions();
      };
    });
    this.chipset.insertAdjacentHTML("afterbegin",
				    `<md-filled-text-field class="newtag" placeholder="new searchtag">
                                       <md-icon class="material-icons" slot="leading-icon">add</md-icon>
                                     </md-filled-text-field>`
				     );
    this.chipset.firstChild.onchange = event => { // Add the new hashtag.
      resetInactivityTimer();
      this.add(event.target.value);
      this.onchange();
    };
  },
  resetPublisherDisplay(isOurs, popup, cancel) { // Lay out the choices for what to publish to, including the option to cancle the alert.
    if (!isOurs) return;

    const close = popup.querySelector('.leaflet-popup-close-button');
    close.innerHTML = `<md-outlined-icon-button><md-icon class="material-icons">check</md-icon></md-outlined-icon-button>`;

    const chipset = popup.querySelector('md-chip-set');
    chipset.innerHTML = this.getSubscribe()
      .map(tag => this.chipHTML(tag))
      .join('') + `<md-filter-chip label="cancel alert" class="cancel"></md-filter-chip>`;
    chipset.querySelector('.cancel').onclick = event=> { // cancel chip pressed
      event.stopPropagation();
      cancel();
    };
    chipset.querySelectorAll(':not(.cancel)').forEach(element => element.onclick = event=> { // chip pressed for new publisher
      event.stopPropagation();
      const chip = event.target;
      this.setPublish(chip);
      chip.selected = true;
      this.onchange();
    });
  }
};

// Populate hashtags data and display.
setTimeout(() => {
  new URLSearchParams(location.search).get('tags')?.split(',').forEach(tag => Hashtags.add(tag));
  Hashtags.onchange();
});
