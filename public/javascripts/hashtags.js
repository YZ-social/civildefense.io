const { localStorage } = globalThis; // For linters.
import { stripLeadingEmoji, canonicalTag } from './versions.js';
import { Int } from './translations.js';
import { showMessage } from './map.js';
import { Alert } from './alert.js';
import { resetInactivityTimer, clickTip } from './main.js';


const help = `🆘 ${Int`help`}`;
let allKnownHashtags = JSON.parse(localStorage.getItem('allKnownHashtags') || `[
  "🍰 cake",
  "🎸 classic rock",
  "🎼 classical",
  "🩷 community support",
  "🤠 country",
  "🎧 edm",
  "🔥 fire",
  "🌊 flood",
  "${help}",
  "🎤 hiphop",
  "🧊 ice",
  "🎷 jazz",
  "🎙️ news",
  "👁️ observer corps",
  "🎵 pop",
  "🧰 utility repairs"
]`);

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
  hashtags: {}, // extended string => true/false/'pub'
  canonical2extended: {}, // canonical string => extended string
  add(label, active = true, updateAlerts = true) { // Ensure label is a hashtag, initialized to active, and if existing, forcing it active.
    // Return our (possibly new) understanding of the extended hashtag.
    // Note that only startup-population of tags from persistence would ever specify active=false.
    // Here we accept a canonical or extended label, updating our records keyed by the canonical part,
    // but if we currently have just a canonical part we update our records to capture the extended.
    // (We do not change the emoji of an existing extended.)
    const canonical = canonicalTag(label);                   // no emoji, lower case.
    const ourExtended = this.canonical2extended[canonical];  // our current version, if any
    const replaceExisting = !this.firstEmoji(ourExtended);
    const extended = replaceExisting ? label : ourExtended;      // full emoji form to use
    if (replaceExisting) {
      active = this.hashtags[canonical] || active;
      allKnownHashtags = allKnownHashtags.filter(tag => canonicalTag(tag) !== canonical);
      delete this.hashtags[ourExtended];
    }
    this.hashtags[extended] ||= active; // If it's 'pub', let it remain so.
    this.canonical2extended[canonical] = extended;
    if (replaceExisting) {
      this.onchange({resetSubscriptions: false});
      if (updateAlerts) Alert.updateAlerts(canonical, extended);
    }
    if (!allKnownHashtags.includes(extended)) {
      allKnownHashtags.push(extended);
      this.sort(allKnownHashtags);
      localStorage.setItem('allKnownHashtags', JSON.stringify(allKnownHashtags));
    }
    return extended;
  },
  getAll() { // List of all the user's extended hashtags.
    return Object.keys(this.hashtags);
  },
  getSubscribe() { // Return a list of the hashtags to which the user intendeds to subscribe.
    return this.getAll().filter(tag => this.hashtags[tag]);
  },
  isSubscribed(key) { // Is this user subscribed to some form of this key.
    const canonical = canonicalTag(key);                   // no emoji, lower case.
    const ourExtended = this.canonical2extended[canonical];  // our current version, if any
    return this.hashtags[ourExtended];
  },
  isPublish(key) { // Is this extended tag (in the user's preferred presentation) the user's current publishing tag?
    return this.hashtags[key] === 'pub';
  },
  backupPublisher: false,
  getPublish(force = false) { // Return the one hashtag to which the user intends to publish.
    // If force and no publisher, setPublisher to backup and return it.
    let pub = this.getAll().find(key => this.isPublish(key));
    if (!pub && force) {
      pub = this.backupPublisher || help;
      this.setPublish(pub);
      this.onchange({highlightPublish: true});
    }
    return pub;
  },  
  firstEmoji(tag) { // First emoji that appears in string, else falsy.
    // I would prefer that it take just the first emoji, but that doesn't grab double-wide ones
    // such as flags. So instead this will return any leading emoji ending with a space, terminator, or normal character.
    return tag && tag.match(/\p{Emoji}+/u)?.[0];

  },
  identicon(tag, slot = '') { // HTML for an identicon representing tag.
    // Unneeded and not necessarilly meaningful if tag has emoji.
    return `<minidenticon-svg ${slot ? `slot="${slot}"` : ''} username="${tag}"></minidenticon-svg>`;
  },
  formatAlert(tag) { // HTML (possibly text) to represent tag as a marker on map.
    return this.firstEmoji(tag) || this.identicon(tag);
  },
  formatPubtag(tag, identiconData = tag) { // HTML (possibly text) to represent tag with defaulted icon.
    const emoji = this.firstEmoji(tag);
    return emoji ? tag : this.identicon(identiconData) + tag;
  },
  onchange({redisplaySubscribers = true, highlightPublish = false, resetSubscriptions = true} = {}) { // Update and persist internal data, and update visuals.
    // If redisplaySubscribers, the presence/order may have changed.
    if (redisplaySubscribers) this.resetSubscriberDisplay();
    localStorage.setItem('hashtags', JSON.stringify(this.hashtags));
    if (resetSubscriptions) {
      // We destroy unsubscribed markers right away, because we don't want the user to have to wait and wonder why they're still displayed.
      // If there are alerts in flight, they will be rejected by Alert initialize because we will have already turned off the sub.
      Alert.items.forEach(wrapper => this.isSubscribed(wrapper.hashtag) || wrapper.destroy());
      Alert.updateSubscriptions();
    }
  },
  chipset: document.body.querySelector('.watching-hashtags'), // Element containing the user's chips.
  chipHTML(label) { // Answer an HTML string to represent label in the chipset.
    const active = this.hashtags[label];
    return `<md-filter-chip label="${label}" elevated removable
        ${active === 'pub' ? 'class="pub"' : ''}
        ${active ? ' selected' : ''}
      >${this.firstEmoji(label) ? '' :
        `<div slot="selected-icon" class="identicon"><md-icon class="material-icons">checkmark</md-icon> ${this.identicon(label)}</div>`}
        <md-icon-button slot="remove-trailing-icon"><md-icon class="material-icons"></md-icon></md-icon-button>
      </md-filter-chip>`;
  },

  // Topic entry, with autocomplete.
  // - When you click the input box, it shows all the topics we know about.
  //   This includes topics you already have available, because you might not realize you have them.
  // - As you type, it filters out entries that do not match:
  //   - If you happen to start with an emoji and have not yet entered a separating space, it matches against those that use the same emoji.
  //   - Otherwise, it matches text, ignoring the emoji, and it highlights the substring that matches.
  // - up/down arrow or tab ==> highlights from among those shown and copies its text to the input box, but not yet accepting it.
  //    - But if tab is used when something was already highlighted, then it is accepted (like enter).
  // - click (regardless of highlighting) ==> what you click on is used.
  // - enter:
  //   - something highlighted ==> what is highlighted is used.
  //   - otherwise => exact contents of input box is used.
  closeSelector() { // Close the autocomplete tag selector
    const { listbox, newtag } = this;
    listbox.classList.toggle('hidden', true);
    newtag.setAttribute('aria-expanded', 'false');
    newtag.removeAttribute('aria-activedescendant');
    newtag.value = '';
    this.activeIndex = -1;
    this.selectors = [];
  },
  openSelector() { // Open the autocomplete tag selector
    const { listbox, newtag } = this;
    listbox.classList.toggle('hidden', false);
    newtag?.setAttribute('aria-expanded', 'true');
  },
  setActive(index) { // Highlight the index among selectors, and copy it's value to newtag.
    const { listbox, newtag } = this;
    this.activeIndex = index;
    listbox.querySelectorAll('.combobox-option').forEach((option, optionIndex) => {
      const active = index === optionIndex;
      option.classList.toggle('active', active);
      if (active) {
	option.scrollIntoView({ block: 'nearest' });
	newtag.setAttribute('aria-activedescendant', option.id);
      } else {
	newtag.removeAttribute('aria-activedescendant');
      }
    });
    newtag.value = this.selectors[this.activeIndex];
  },
  selectValue(value) { // Accept the specified string.
    this.newtag.value = value;
    this.acceptTag();
  },
  acceptTag() { // Add the new hashtag.
    resetInactivityTimer();
    let tag = this.newtag?.value  // Get into standard form, but do not strip emoji or case into canonical yet.
	.replace(/^#/, '')        // No leading hash
	.replace(':', '.')        // Replace colon with some other separator.
	.replace(/\s+/g, ' ')     // Replace multiple spaces with a single space
	.normalize('NFD');        // Standardize different ways of making accents into decomposed form - but do not remove them.
    Alert.closePopup();
    if (!tag) return;
    if (this.firstEmoji(tag)) { // Possibly REPLACE existing with the new tag.
      const canonical = canonicalTag(tag);
      const existingExtended = this.canonical2extended[canonical];
      if (existingExtended !== tag) {
	delete this.canonical2extended[canonical];
	delete this.hashtags[existingExtended];
      }
    }
    tag = this.add(tag); // Might exist, in which case tag might now be extended.
    this.setPublish(tag);
    this.onchange({highlightPublish: true});
  },
  activeIndex: -1,
  selectors: [],
  renderSelector(query) { // Render the autocompletion of query string.
    const { listbox, newtag } = this;
    function escapeRegExp(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function highlight(text, query) {
      if (!query) return text;
      const re = new RegExp(`(${escapeRegExp(query)})`, 'ig');
      return text.replace(re, '<mark>$1</mark>');
    }

    // TODO: create the elements only when allKnownHashtags changes. Then hide/highlight here.
    listbox.innerHTML = '';
    let matchString = canonicalTag(query);
    this.selectors = allKnownHashtags.filter(item =>
      // Subtle: Starting with emoji will match all/only those tags that start with the same tag. Cool.
      // But because of the way canonicalTag() works, once you type a space after an emoji, we match
      // against only the non-emoji, non-space text.
      item.toLowerCase().includes(matchString)
    );

    if (matchString && !this.selectors.includes(query)) {
      this.selectors.unshift(query);
    }
    this.selectors.forEach((item, i) => {
      const li = document.createElement('li');
      li.className = 'combobox-option';
      li.id = `tag-option-${i}`;
      li.setAttribute('role', 'option');
      li.innerHTML = this.formatPubtag(highlight(item, matchString), item);
      li.onclick = event => {
	// pointerdown would fire before the text field's blur event,
	// so we would not have to delay that. But then we would not
	// scroll properly by touch drag.
        event.preventDefault();
	event.stopPropagation();
        this.selectValue(item);
      };
      listbox.appendChild(li);
    });
    setTimeout(() => { // Needs a tick.
      const width = listbox.clientWidth;
      const max = Math.max(125, width);
      newtag.style.width = max + 'px'; // Set newtag so that input box makes room for floating lis
    }, 50);

    this.openSelector();
  },
  sort(tags) { // Sort list of tags in place without regard to leding emoji
    tags.sort((a, b) => stripLeadingEmoji(a).localeCompare(stripLeadingEmoji(b)));
  },
  resetSubscriberDisplay() { // Lay out all the hashtag chips display, including the input for adding new ones.
    this.chipset.innerHTML = '';
    const tags = this.getAll();

    // Sort alphabetically, ignoring any leading emoji, as these have unexpected orderings.
    this.sort(tags);
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
      element.addEventListener('remove', event => { // Clicking the button WITHIN the chip (which is the material design 'remove' event).
	resetInactivityTimer();
	const chip = event.target;
	if (!chip.selected) { // 'x' icon. Not currently selected. Go ahead and remove it.
	  showMessage(Int`Topic "${chip.label}" has been removed. You can add it back with "add topic".`, 'instructions');
	  return this.remove(chip);
	} // radio button icon. Chip is already selected. We are setting the publishing tag.
	event.preventDefault();
	showMessage(Int`Tapping the map will now produce an alert for the "${chip.label}" topic.`, 'instructions');
	if (chip.classList.contains('pub')) return false;
	return this.setPublish(chip.label);
      });
      clickTip(element, Int`Toggle whether alerts for this topic shown on the map. Separately, a radio button is shown when selected and sets this as the initial topic of the next alert you make, while an x button is shown when deselected and removes the topic.`, event => { // Toggle action on whole chip.
	event.stopPropagation();
	resetInactivityTimer();
	const chip = event.target;
	if (chip.selected) showMessage(Int`Turning "${chip.label}" alerts back on in the map.`, 'instructions');
	else showMessage(Int`Turning off "${chip.label}" alerts in the map. You can delete the topic altogether with the X.`, 'instructions');
	this.toggleChip(chip);
	Alert.closePopup();
	this.onchange({redisplaySubscribers: false});
      });
    });
    this.chipset.insertAdjacentHTML("afterbegin",  // Chip to add a new hashtag.
				    `<div class="combobox">
  <md-filled-text-field class="newtag"
     aria-expanded="false"
     aria-controls="knownTagsListbox"
     aria-autocomplete="list"
     autocomplete="off"
     tabindex="0"
     placeholder="➕${Int`add topic`}"></md-filled-text-field>
</div>`);
    // I've tried also supplying a datalist, e.g., to supply the mobile keyboard completions, but
    // I have not been able to get it to work.
    const newtag = this.newtag = this.chipset.querySelector('.newtag');
    const listbox = this.listbox = document.querySelector('.combobox-listbox');
    clickTip(newtag, Int`Add a new topic for which the map should show any alerts.`, event => { // Focusing "add topic".
      event.stopPropagation();
      Alert.closePopup();
      resetInactivityTimer();
      this.renderSelector('');
      if (navigator.maxTouchPoints <= 1) { // Only when no multi-touch. On-screen keyboard makes it shoot off the top.
	showMessage(Int`Type a new topic name to see any alerts on the map with this topic.`, 'instructions');
      }
    });
    newtag.onkeydown = event => {
      if (listbox.classList.contains('hidden')) return;
      const optionCount = listbox.querySelectorAll('.combobox-option').length;

      switch (event.key) {
      case 'Enter':
	event.preventDefault();
        if (this.activeIndex < 0) {
	  this.acceptTag(); // As is, not from list.
        } else {
          this.selectValue(this.selectors[this.activeIndex]);
	}
        break;

      case 'Escape':
	event.preventDefault();
        this.closeSelector();
        break;

      case 'ArrowDown':
	event.preventDefault();
        if (optionCount > 0) this.setActive((this.activeIndex + 1) % optionCount);
        break;

      case 'ArrowUp':
	event.preventDefault();
        if (optionCount > 0) this.setActive((this.activeIndex - 1 + optionCount) % optionCount);
        break;

      case 'Tab':
	event.preventDefault();
	if (this.activeIndex < 0) this.setActive(0);
	else this.selectValue(this.selectors[this.activeIndex]); // Otherwise select what is active.
        break;
      default:
	this.activeIndex = -1;
      }
    };
    newtag.oninput = () => this.renderSelector(newtag.value);
    // When we click on the listbox, the browser will first blur newtag, and then
    // we would not get the click! So here we delay closing a bit.
    newtag.onblur = () => setTimeout(() => this.closeSelector(), 200);
  },
  remove(chip, redisplaySubscribers = false) { // Remove this topic, persistently.
    delete this.hashtags[chip.label];
    delete this.canonical2extended[canonicalTag(chip.label)];
    this.onchange({redisplaySubscribers, resetSubscriptions: false});
  },
  toggleChip(chip) { // Switch whether the topic is or is not subscribed.
    // Now selected => hashtags[label] becomes 'pub' (selected and the publisher) and clear old pub
    // NOT now selected => hashtags[label] becomes false (through mechanism as follows)
    //    but if publisher => set alt publisher if possible, else remember as backupPublisher
    const label = chip.label;

    // chip.selected is new state, after clicking.
    if (chip.selected) return this.setPublish(label);  // Become publisher, clearing old publisher.

    // Not selected:

    // If we're not publisher, just clear. But don't go through getPublish, as that can have side effects.
    if (this.hashtags[label] !== 'pub') return this.hashtags[label] = false;

    // Also clear, but...
    const subs = this.getSubscribe();
    if (subs.length > 1) {  // Find and set alternative publisher if possible.
      const pubIndex = subs.indexOf(label);
      const index = (pubIndex + 1) % subs.length;
      this.setPublish(subs[index]);
    } else {
      // No alternative available. Clear it, but remember for use by getPublish.
      // It will stay .pub styled while toggled, until anything toggles on.
      this.backupPublisher = label;
    }
    return this.hashtags[label] = false;
  },
  getChip(label) { // Handy for scripting, but not otherwise used in app.
    for (const chip of this.chipset.children) {
      if (chip.label === label) return chip;
    }
    return null;
  },
  setPublish(newTag) { // Make this topic be the one to be used when we next publish an alert.
    // newTag will be marked for publishing (in this.hashtags and element style)
    // Old publish tag (if any) will be set back to merely be subscribed (in same)
    let oldTag = this.getPublish();
    const backup = this.backupPublisher;
    if (oldTag) this.hashtags[oldTag] = true; // true (instead of 'pub')
    else if (backup) oldTag = backup;
    this.backupPublisher = false;
    this.hashtags[newTag] = 'pub';
    for (const chip of this.chipset.children) {
      if (chip.label === newTag) chip.classList.add('pub');
      else if (chip.label === oldTag) chip.classList.remove('pub');
    }
    return oldTag;
  }
};
globalThis.Hashtags = Hashtags; // for debugging

// Populate hashtags data and display.
// First the persisted/default data:
const persisted = JSON.parse(localStorage.getItem('hashtags') || `{"🍰 ${Int`cake`}": true, "${help}": "pub"}`);
Object.entries(persisted).forEach(([tag, active]) => Hashtags.add(tag, active, false));
