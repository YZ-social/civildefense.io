// TODO:
// - In Alert, get rid of subject (just use tag)
// - key off 'deleted' instead of payload:null, and bring handling here
// - Bring pub/sub here, customized for SpatialConversation subclass
// - Agents
// - Document lifecycle and subclass requirements

export class Tagged { // Maintains cached existence within a (possibly instance-specific) container

  // These next three instance methods are not generally called directly, but are here for extending by subclasses.
  initialize({...properties} = {}) { // Initialization of a new object. (Includes tag.) Must return this, or null to not cache.
    // Application subclass will typically extend this with UI initialization
    Object.assign(this, properties);
    return this;
  }
  update({...properties} = {}) { // Re-initialize an existing object with properties. Must return this, or null to remove item.
    // This version gives error when specified values (if any) do not match existing.
    // Since axona publications are immutable, an update with different values would generally be meaningless.
    for (const key in properties) {
      const existing = this[key];
      const proposed = properties[key];
      if (JSON.stringify(existing) !== JSON.stringify(proposed)) throw new Error(`Cannot update '${key}' from ${existing} to ${proposed}.`);
    }
    return this;
  }
  destroy() { // Subclasses extend to remove UI.
    // Subclass extensions of ensure may expect this answer falsy, indicating that an item was removed.
    // NOTE: Does not destroy replies, as these may have been published by others.
    return null; 
  }

  static async ensureIn(data, container, kind = container.itemKind) { // update() or initialize() item and remember what those answer. (Falsy is deleted).
    const {tag, payload, ...rest} = data;
    let item = container.getItem(tag);
    if (!payload) return item && container.removeItem(tag)?.destroy();
    if (item) item = await item.update(data);
    else item = await (new kind().initialize({...data, container}));

    if (!item) return container.removeItem(tag)?.destroy();
    return container.setItem(tag, item);
  }
}

export class Reply extends Tagged {  // An individual reply to a conversation.
}

export class Conversation extends Tagged { // A conversation with replies.

  // get/set/removeItem for replies. The instance maintains the collection as a list.
  items = []; // List of replies, in increasing time order.
  getItem(tag) { // Find the reply if known, else falsy.
    const { items } = this;        
    return items.find(reply => reply.tag === tag);
  }
  setItem(tag, item) { // Adds reply to cache, maintaining order. Ignores tag.
    const { items } = this;        
    items.push(item);
    items.sort((a, b) => a.issuedTime - b.issuedTime); // In case they arrive out of order. Typically just a check.
    return item;
  }
  removeItem(tag) { // Remove reply from cache.
    const { items } = this;    
    return items.splice(items.findIndex(reply => reply.tag === tag), 1)?.[0];
  }
  get itemKind() { // Answer class of reply items.
    return Reply;
  }
  ensure(data) { // Initialize or update Reply from data.
    return this.constructor.ensureIn(data, this);
  }

  // get/set/removeItem for conversations. The class maintains the collection as a dictionary.
  // Multiton pattern, with each subclass getting its own dictionary.
  static _conversations = {}; // Maps tag => conversation
  static get conversations() { // Answer conversation dictionary for this specific class.
    if (!Object.hasOwn(this, '_conversations')) this._conversations = {};
    return this._conversations;
  }
  static items() {
    return Object.values(this.conversations);
  }
  static getItem(tag) { // Get conversation if known, else falsy.
    return this.conversations[tag];
  }
  static setItem(tag, item) { // Cache conversation at tag.
    return this.conversations[tag] = item;
  }
  static removeItem(tag) { // Remove conversation from cache.
    let existing = this.getItem(tag);
    delete this._conversations[tag];
    return existing;
  }
  static get itemKind() { // Answer class of Converstion items.
    return this;
  }
  static ensure(data) { // Initialize or update Conversation from data.
    return this.ensureIn(data, this);
  }
}
