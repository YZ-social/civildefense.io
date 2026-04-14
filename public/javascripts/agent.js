const { localStorage } = globalThis;
import { v4 as uuidv4 } from 'uuid';
import { minidenticonSvg } from 'minidenticons';
import { Int } from './translations.js';
import { consume, openDisplay, downsampledFile2dataURL } from './display.js';
import { networkPromise, resetInactivityTimer } from './main.js';

export class Agent {
  // Tracks what we know of people, and updates avatars and handles representing them.
  
  constructor({tag}) { // Subscribe to public data for tag.
    // The system value for handle and avatar is the same, but it is convenient to
    // represent this as two types, like everything else.
    this.updateValue(tag, 'system', 'handle');
    this.updateValue(tag, 'system', 'avatar');
    // Our private choice for this user is stored locally.
    // But for our own avatar, is the public choice.
    const scope = tag == usertag ? 'public' : 'private';
    this.updateFromLocal(scope, 'handle');
    this.updateFromLocal(scope, 'avatar');

    networkPromise.then(contact => contact.subscribe({
      eventName: this.networkPersistKey(tag),
      handler: data => this.setPublicData(data),
      autoRenewal: true
    }));
  }
  get tag() { // Retrieved from system handle or avatar.
    return this.values.handle.system;
  }
  localPersistKey(type, tag = this.tag) { // for localStorage of our private data about this Agent.
    return `${type}-${tag}`;
  }
  static networkPersistKey(tag) { // EventName (not key) for pubsub of public data bout this Agent.
    return `public:${tag}`;
  }
  networkPersistKey(tag = this.tag) {
    return Agent.networkPersistKey(tag);
  }
  updateFromLocal(scope, type, tag = this.tag) { // get value locally, and then update (which may have side-effect)
    const value = localStorage.getItem(this.localPersistKey(type, tag));
    this.updateValue(value, scope, type);
  }
  setPublicData(data) { // Subscription to public data has fired. Update value, but do not not re-publish.
    const {payload, subject} = data;
    this.updateValue(payload, 'public', subject, false);
  }
  
  static agents = {}; // tag => Agent
  static ensure(tag) { // Answer Agent for tag, creating it if necessary.
    return this.agents[tag] ||= new this({tag});
  }

  // Track values of various types and scope.
  values = {
    handle: {system: null, public: null, private: null, mixed: null},    
    avatar: {system: null, public: null, private: null, mixed: null}
  };
  getValue(scope, type) {
    return this.values[type][scope];
  }
  updateValue(value, scope, type, publish = true) { // Updates dependent elements, and if necessary, the mixed values/elements as well.
    if (this.values[type][scope] === value) return;

    // Persist. For public, that will boomerang through subscription.
    if (scope === 'private') this.persistPrivate(value, type);
    else if (publish && (scope === 'public')) return this.persistPublic(value, type);

    this.values[type][scope] = value;
    for (const element of this.elements[type][scope]) this.updateElement(element, type, value);
    if (scope === 'mixed') return null;
    const vprivate = this.values[type].private;
    const vpublic = this.values[type].public;
    const vsystem = this.values[type].system;
    const vmixed = vprivate === '' ? vsystem : (vprivate || vpublic || vsystem);
    return this.updateValue(vmixed, 'mixed', type);
  }
  persistPrivate(value, type) { // Save locally.
    const key = this.localPersistKey(type);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  persistPublic(value, type) { // Publish (and we will act on subscription).
    networkPromise.then(contact => contact.publish({
      eventName: this.networkPersistKey(),
      subject: type,
      payload: value,
      immediate: true
    }));
  }

  // We represent handles and avatars by inserting stuff into given elements.
  updateElement(element, type, value) {
    Agent[type](element, value === '' ? this.tag : value);
  }
  static handle(element, value) { // Update handle element with value.
    element.textContent = value || '(none)';
    element.value = value || ''; // Hack: handle input[type="text"] as well. Must be property assignment, not attribute.
  }
  static avatar(element, value) { // Update avatar element with value.
    element.innerHTML = value === null ? '(none)' : (value.startsWith('data') ? this.makeImage(value) : Agent.makeIdenticon(value));
  }
  static downsampleResolution = 128; // max height or width
  static makeImage(url) {
    return `<img src="${url}"></img>`;
  }
  static makeIdenticon(tag) {
    return `<minidenticon-svg username="${tag}"></minidenticon-svg>`;
  }

  // Track elements to be updated when something changes.
  elements = {
    handle: {system: new Set(), public: new Set(), private: new Set(), mixed: new Set()},
    avatar: {system: new Set(), public: new Set(), private: new Set(), mixed: new Set()}
  };
  addElement(element, scope, type) { // If not already present, Update element, add it to th set that will stay updated, and return true.
    if (this.elements[type][scope].has(element)) return false;
    this.updateElement(element, type, this.values[type][scope]);
    this.elements[type][scope].add(element);
    return true;
  }
  removeElement(element, scope, type) { // Remove element from getting updated.
    this.elements[type][scope].delete(element);
  }

  describe(event) { // Describe someone who posted or replied
    const content = openDisplay('correspondentContainer', event);
    const handleSpan = content.querySelector('.handle');
    const avatarSpan = content.querySelector('.avatar');
    const systemHandle = content.querySelector('.system-label md-outlined-button');
    const publicHandle = content.querySelector('.public-label md-outlined-button');
    const privateHandle = content.querySelector('.private-label md-outlined-text-field');
    const systemAvatar = content.querySelector('.system-label md-outlined-icon-button');
    const publicAvatar = content.querySelector('.public-label md-outlined-icon-button');
    const privateAvatar = content.querySelector('.private-label md-outlined-icon-button');
    const fileChooser = content.querySelector('input[type="file"]');
    privateHandle.label = Int`handle`;
    const ok = document.getElementById('correspondentOK');
    const cancel = document.getElementById('correspondentCancel');
    const oldPrivateHandle = this.getValue('private', 'handle');
    const oldPrivateAvatar = this.getValue('private', 'avatar');
    this.addElement(systemHandle, 'system', 'handle');
    this.addElement(publicHandle, 'public', 'handle');
    this.addElement(privateHandle, 'private', 'handle');
    this.addElement(handleSpan, 'mixed', 'handle');    
    this.addElement(systemAvatar, 'system', 'avatar');
    this.addElement(publicAvatar, 'public', 'avatar');
    this.addElement(privateAvatar, 'private', 'avatar');
    this.addElement(avatarSpan, 'mixed', 'avatar');    

    content.onclick = consume; // Normally set by openDisplay to close the display, but we don't want that here.
    systemHandle.onclick = event => {
      consume(event);
      this.updateValue('', 'private', 'handle');
    };
    publicHandle.onclick = event => {
      consume(event);
      this.updateValue(publicHandle.getAttribute('value') || '', 'private', 'handle');
    };
    privateHandle.oninput = event => {
      resetInactivityTimer();
      this.updateValue(privateHandle.value || null, 'private', 'handle');
    };

    systemAvatar.onclick = event => {
      consume(event);
      this.updateValue('', 'private', 'avatar');
    };
    publicAvatar.onclick = event => {
      consume(event);
      const dataURL = publicAvatar.firstElementChild?.getAttribute('src');
      this.updateValue(dataURL || '', 'private', 'avatar');
    };
    privateAvatar.onclick = event => {
      consume(event);
      fileChooser.oncancel = event => {
	consume(event);
	this.updateValue(null, 'private', 'avatar');
      };
      fileChooser.onchange = async event => {
	consume(event);
	if (!fileChooser.files.length) return;
	const url = await downsampledFile2dataURL(fileChooser.files[0], Agent.downsampleResolution);
	this.updateValue(url, 'private', 'avatar');
	console.log('clearing avatar selection');
      };
      fileChooser.click();
    };

    cancel.onclick = () => {
      this.updateValue(oldPrivateHandle, 'private', 'handle');
      this.updateValue(oldPrivateAvatar, 'private', 'avatar'); 
      ok.click();
    };
    ok.onclick = () => {
      this.removeElement(systemHandle, 'system', 'handle');
      this.removeElement(publicHandle, 'public', 'handle');
      this.removeElement(privateHandle, 'private', 'handle');
      this.removeElement(handleSpan, 'mixed', 'handle');    
      this.removeElement(systemAvatar, 'system', 'avatar');
      this.removeElement(publicAvatar, 'public', 'avatar');
      this.removeElement(privateAvatar, 'private', 'avatar');
      this.removeElement(avatarSpan, 'mixed', 'avatar');    
      content.parentElement.classList.toggle('hidden', true);
    };
  }
  static initialize() { // Initialize what the agent needs from the about screen
    localStorage.setItem('usertag', usertag);
    const myAgent = Agent.ensure(usertag);
    const myHandle = document.getElementById('myHandle');
    const myAvatar = document.getElementById('myAvatar');
    myAgent.addElement(myHandle, 'public', 'handle');
    myAgent.addElement(myAvatar, 'mixed', 'avatar'); // display the mixed result
    myHandle.label = Int`your handle`;
    myHandle.onclick = consume;
    myHandle.onchange = event => {
      resetInactivityTimer();
      const value = myHandle.value || null;
      myAgent.updateValue(value, 'public', 'handle');
      myAgent.persistPrivate(value, 'handle'); // So that we'll have it next session.
    };
    myAvatar.onclick = event => {
      consume(event);
      const fileChooser = document.getElementById('correspondentContainer').querySelector('input[type="file"]');
      fileChooser.oncancel = event => {
	consume(event);
	myAgent.updateValue(null, 'public', 'avatar');
	myAgent.persistPrivate(null, 'avatar'); // So that we'll have it next session.
	console.log('clearing avatar selection');
      };
      fileChooser.onchange = async event => {
	consume(event);
	if (!fileChooser.files.length) return;
	const url = await downsampledFile2dataURL(fileChooser.files[0], Agent.downsampleResolution);
	myAgent.updateValue(url, 'public', 'avatar');
	myAgent.persistPrivate(url, 'avatar'); // So that we'll have it next session.
      };
      fileChooser.click();
    };
  }
}

export const usertag = localStorage.getItem('usertag') || uuidv4();
