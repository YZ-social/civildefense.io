const { localStorage } = globalThis;
import { v4 as uuidv4 } from 'uuid';
import { minidenticonSvg } from 'minidenticons';
import { createAuthorIdentity }  from '@axona/protocol';
import { agentTopic } from './versions.js';
import { Int } from './translations.js';
import { consume, openDisplay, downsampledFile2dataURL } from './display.js';
import { networkPromise, resetInactivityTimer } from './main.js';
import { P2PWebNetwork } from './p2pWebNetwork.js';

export class Agent {
  // Tracks what we know of people, and updates avatars and handles representing them.

  // Agent metadata are always republished with each alert/reply, using alert's region in region/name/author
  // Not republished when the value changes.
  // Next time the agent is used in an alert/reply, it will publish to the region/name/author
  //   Any subscribers in that region will see the new value.
  //   Subscribers in other regions will not know of the change -- until the user has activity there.
  // A map display might cross across two or more regions. We do not want the same user to appear
  // differently for alerts on the other side of an arbitrary and invisible line.
  // Thus we keep on Agent per persona tag, and have it display the latest info we have.
  // Currently, this is done with a subscription for each region in which we have had
  // a referencing open alert this session, and it remains an active subscription through the session.
  // (We don't want to try to determine when the last reference goes away to unsubscribe, and we
  // don't want to continuously subscribe/unsubscribe when opening and closing alerts.)

  constructor({tag, identity}) { // Subscribe to public data for tag.
    // Throughout, 'type' is either 'avatar' (indicating an image) or 'handle' (a string).

    this.identity = identity; // (tag gets carried through the system handle.)
    // The system value for handle and avatar is the same, but it is convenient to
    // represent this as two types, like everything else.
    this.updateValue(tag, 'system', 'handle');
    this.updateValue(tag, 'system', 'avatar');
    // Our private choice for this user is stored locally.
    // But for our own avatar, is the public choice.
    const scope = tag == Agent.tag ? 'public' : 'private';
    this.updateFromLocal(scope, 'handle');
    this.updateFromLocal(scope, 'avatar');
  }
  get tag() { // Retrieved from system handle or avatar.
    return this.values.handle.system;
  }
  localPersistKey(type, tag = this.tag) { // for localStorage of our private data about this Agent.
    return `${type}-${tag}`;
  }
  static networkPersistKey(tag) {
    return this.agents[tag]?.networkPersistKey(tag);
  }
  networkPersistKey(tag = this.tag) {
    return agentTopic(tag);
  }
  updateFromLocal(scope, type, tag = this.tag) { // get value locally, and then update (which may have side-effect)
    const value = localStorage.getItem(this.localPersistKey(type, tag));
    this.updateValue(value, scope, type, false); // Don't publish until we post.
  }
  static recreateMessageTag(tag, type) { // For the agent specified by tag, promise the messageTag for the specified agent tag, type.
    return this.agents[tag]?.recreateMessageTag(type);
  }
  recreateMessageTag(type) {// Promise the Axona msgId that provided the specified type of public data, if any.
    return this.publicMsgId[type];
  }
  trackedRegions = {};
  currentRegion = null;
  trackPublicChanges(region) {
    this.currentRegion = region;
    if (this.trackedRegions[region]) return;
    this.persistPublicMetadata(region);
    networkPromise.then(contact => this.trackedRegions[region] = contact.subscribe({
      eventName: this.networkPersistKey(),
      region,
      since: 'latest',
      // FIXME: owner: this.tag
      handler: data => this.setPublicData(data),
    }));
  }
  async setPublicData(data) { // Subscription to public data has fired. Update value, but do not not re-publish.
    let {payload, subject, type} = data;
    // If this was a deletion, we have no type in the data. Find the one that matches subject.
    type ||= Object.keys(this.publicMsgId).find(key => this.publicMsgId[key] === subject);
    if (!type) return; // Delete of a value that we don't have.
    if (type === 'avatar' && payload) {
      const contact = await networkPromise;
      payload = await contact.assembleChunkedString(payload);
    }
    this.updateValue(payload, 'public', type, false);
    if (subject) this.publicMsgId[type] = subject;
  }
  
  static agents = {}; // tag => Agent
  static ensure({tag, identity, region}) { // Answer Agent for tag, creating it if necessary.
    const agent = this.agents[tag] ||= new this({tag, identity});
    if (region) agent.trackPublicChanges(region);
    return agent;
  }

  // Track values of various types and scope.
  values = {
    handle: {system: null, public: null, private: null, mixed: null},    
    avatar: {system: null, public: null, private: null, mixed: null}
  };
  publicMsgId = {}; // maps type => msgId for saved public data of this Agent instance.
  getValue(scope, type) {
    return this.values[type][scope];
  }
  updateValue(value, scope, type, pushPublic = true) { // Updates dependent elements, and if necessary, the mixed values/elements as well.
    if (this.values[type][scope] === value) return;

    // Persist if private. For public, update locally but do not publish until this agent publishes an alert or reply.
    if (scope === 'private') this.persistPrivate(value, type);
    else if (pushPublic && (scope === 'public')) return this.persistPublic(value, type);
    this.values[type][scope] = value;
    for (const element of this.elements[type][scope]) this.updateElement(element, type, value);
    if (scope === 'mixed') return null;
    // Compute the mixed value:
    // It is the private value if specified.
    // Otherwise is the first non-empty value private, public, and a version of system.
    const vprivate = this.values[type].private;
    const vpublic = this.values[type].public;
    const vsystem = type === 'avatar' ? this.values[type].system : 'anonymous';
    const vmixed = vprivate === '' ? vsystem : (vprivate || vpublic || vsystem);
    return this.updateValue(vmixed, 'mixed', type);
  }
  persistPrivate(value, type) { // Save locally.
    const key = this.localPersistKey(type);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  async persistPublicMetadata(region) { // Publish handle and avatar.
    this.currentRegion = region;
    await Promise.all(['handle', 'avatar'].map(type => this.persistPublic(this.getValue('public', type) || null, type)));
  }
  async persistPublic(value, type) { // Publish (and we will act on subscription).
    const eventName = this.networkPersistKey();
    const region = this.currentRegion;
    // TODO: set owner as well.
    const contact = await networkPromise;
    if (value) {
      let payload = value;
      if (type === 'avatar') {
	payload = await contact.chunkifyString({string: value, region});
      }
      return contact.publish({eventName, type, region, payload});
    }
    const subject = this.recreateMessageTag(type);
    if (!subject) return null; // We have not published a value, so nothing to kill.
    return contact.publish({eventName, subject, region, payload: null});
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
  static current = null;
  static tag = null;
  static identity = null;
  static switchUser(tag, identity) { // Set/persist/ensure the current user, return Agent
    this.tag = tag; // Before the ensure().
    this.identity = P2PWebNetwork.currentPublishIdentity = identity;
    localStorage.setItem('usertag', this.tag);
    return this.current = this.ensure({tag, identity});
  }
  static async initialize() { // Initialize what the agent needs from the about screen
    const tag = localStorage.getItem('usertag') || uuidv4();
    const myIdentity = await createAuthorIdentity({persistAs: tag});
    const myAgent = Agent.switchUser(tag, myIdentity);
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

